import os
import datetime
import functions_framework
from googleapiclient.errors import HttpError

from drive_client import get_drive_service, get_files_in_folder, download_file, upload_to_drive
from viwoods_parser import process_note_to_markdown
from master_compiler import compile_master_files
from github_client import push_to_github

@functions_framework.http
def sync_drive_notes(request):
    """HTTP Cloud Function entry point."""
    
    # Handle CORS Preflight for the new proxy endpoint
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)

    # Simple built-in CORS proxy for RSS feeds
    if request.args.get('proxy_url'):
        target_url = request.args.get('proxy_url')
        try:
            import urllib.request
            import urllib.error
            # Use a descriptive user-agent so strict sites (like Reddit) don't block us with a 403 Forbidden
            req = urllib.request.Request(target_url, headers={'User-Agent': 'viwoods-brain2-rss-proxy/1.0'})
            with urllib.request.urlopen(req) as response:
                content = response.read()
                return (content, 200, {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': response.headers.get('Content-Type', 'application/xml')
                })
        except urllib.error.HTTPError as e:
            # If the target server returns a 4xx or 5xx, pass it through gracefully instead of crashing the proxy
            error_content = e.read()
            return (error_content, e.code, {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': e.headers.get('Content-Type', 'text/plain')
            })
        except Exception as e:
            return (f"Proxy error: {str(e)}", 500, {'Access-Control-Allow-Origin': '*'})

    if not request.args.get('proxy_url'):
        # For the actual sync job, we require a secret key to prevent unauthorized invocations
        # once the Cloud Run service is made public for the CORS proxy.
        cron_secret = os.environ.get("CRON_SECRET")
        if cron_secret and request.args.get("cron_secret") != cron_secret:
            return "Unauthorized", 401
            
        if not os.environ.get("GEMINI_API_KEY"):
            return "Please set the GEMINI_API_KEY environment variable in Cloud Functions.", 500

    try:
        service = get_drive_service()
        
        target_folders_env = os.environ.get("DRIVE_FOLDERS", "Viwoods-Note")
        target_folders = [f.strip() for f in target_folders_env.split(",") if f.strip()]
        
        total_processed_count = 0
        
        for target_folder_name in target_folders:
            folder_query = f"mimeType='application/vnd.google-apps.folder' and name='{target_folder_name}' and trashed=false"
            folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
            folders = folder_results.get("files", [])
    
            if not folders:
                continue
            
            folder_id = folders[0]["id"]
            print(f"Found '{target_folder_name}' folder. Scanning for documents...")
    
            all_files = get_files_in_folder(service, folder_id)
            
            existing_mds = {f["folder_path"] + "/" + f["name"]: f for f in all_files if f["name"].endswith(".md") and f["name"] not in ["All_Notes_Master.md", "Scratch_Master.md", "Work_Master.md", "TODO_Master.md"]}
            docs_to_process = [f for f in all_files if f["name"].endswith(".note") and not f["name"].lower().endswith(".pdf.note")]
            
            processed_count = 0
            
            for doc in docs_to_process:
                clean_note_name = doc["name"].replace(".note", "")
                if clean_note_name.startswith("day_"):
                    print(f"Skipping daily note entirely: {doc['name']}")
                    continue

                expected_md_name = doc["name"].replace(".note", ".md")
                expected_md_path = doc["folder_path"] + "/" + expected_md_name
                    
                existing_md_id = None
                existing_md_path = None
                
                if expected_md_path in existing_mds:
                    md_file = existing_mds[expected_md_path]
                    doc_md5 = doc.get("md5Checksum")
                    md_app_props = md_file.get("appProperties", {})
                    
                    if doc_md5 and md_app_props and doc_md5 == md_app_props.get("source_md5"):
                        print(f"Skipping {doc['name']} (MD5 checksum matches). Pushing to GitHub anyway.")
                        existing_md_path = download_file(service, md_file['id'], expected_md_name, dest_folder="/tmp/cache")
                        push_to_github(expected_md_path, existing_md_path, commit_message=f"Auto-sync from OCR: {expected_md_name}")
                        continue
                        
                    doc_time = datetime.datetime.fromisoformat(doc["modifiedTime"].replace("Z", "+00:00"))
                    md_time = datetime.datetime.fromisoformat(md_file["modifiedTime"].replace("Z", "+00:00"))
                    
                    if doc_time <= md_time:
                        print(f"Skipping {doc['name']} (Markdown is up to date based on timestamp). Pushing to GitHub anyway.")
                        existing_md_path = download_file(service, md_file['id'], expected_md_name, dest_folder="/tmp/cache")
                        push_to_github(expected_md_path, existing_md_path, commit_message=f"Auto-sync from OCR: {expected_md_name}")
                        continue
                    
                    existing_md_id = md_file["id"]
                    
                    print(f"\n--- Updating {doc['name']} (Checking for internal modifications) ---")
                    existing_md_path = download_file(service, md_file['id'], expected_md_name, dest_folder="/tmp/cache")
                else:
                    print(f"\n--- Processing new file: {doc['name']} ---")
                    
                local_doc_path = download_file(service, doc['id'], doc['name'], dest_folder="/tmp")
                local_md_path = os.path.join("/tmp", expected_md_name)
                parent_id = doc.get('parents', [folder_id])[0]
                
                try:
                    clean_note_name = doc["name"].replace(".note", "")
                    is_daily = "Daily" in doc.get("folder_path", "") or clean_note_name.startswith("day_")
                    
                    success, internal_dt = process_note_to_markdown(local_doc_path, local_md_path, existing_md_path, service, parent_id, clean_note_name, is_daily, github_folder_path=doc.get("folder_path", ""))
                except Exception as e:
                    if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        print("Hit Google AI API rate limit! Stopping processing for today, but will compile Master file.")
                        break
                    else:
                        print(f"Error processing {doc['name']}: {e}")
                        continue
                        
                if success:
                    original_modified_time = internal_dt or doc.get('modifiedTime')
                    source_md5 = doc.get("md5Checksum")
                    upload_to_drive(service, local_md_path, parent_id, existing_file_id=existing_md_id, modified_time=original_modified_time, source_md5=source_md5)
                    push_to_github(expected_md_path, local_md_path, commit_message=f"Auto-sync from OCR: {expected_md_name}")
                    processed_count += 1
                    total_processed_count += 1
                    
            compile_master_files(service, folder_id, target_folder_name)
                
        return f"Sync complete! Processed {total_processed_count} files.", 200
        
    except HttpError as error:
        print(f"An error occurred: {error}")
        return f"Error: {error}", 500
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Unexpected error: {e}")
        return f"Unexpected error: {e}", 500
