import io
import os
# Force fresh container build
import time
import datetime

import functions_framework
import google.auth
from google import genai
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload

# Scope for full drive access
SCOPES = ["https://www.googleapis.com/auth/drive"]

import json
from google.oauth2.credentials import Credentials

def get_drive_service():
    token_json_str = os.environ.get("DRIVE_TOKEN_JSON")
    if token_json_str:
        print("Using user's DRIVE_TOKEN_JSON for Drive API authentication...")
        token_info = json.loads(token_json_str)
        credentials = Credentials.from_authorized_user_info(token_info, SCOPES)
    else:
        print("Falling back to Service Account for Drive API authentication...")
        credentials, project = google.auth.default(scopes=SCOPES)
        
    return build("drive", "v3", credentials=credentials)

def download_file(service, file_id, file_name, dest_folder="/tmp"):
    if not os.path.exists(dest_folder):
        os.makedirs(dest_folder)
    
    file_path = os.path.join(dest_folder, file_name)
    request = service.files().get_media(fileId=file_id)
    fh = io.FileIO(file_path, "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    print(f"Downloading {file_name}...")
    while not done:
        status, done = downloader.next_chunk()
    return file_path

def process_pdf_to_markdown(pdf_path, output_path):
    print(f"Uploading {pdf_path} to Gemini for OCR...")
    api_key = os.environ.get("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key)
    
    sample_file = client.files.upload(file=pdf_path)
    
    while sample_file.state.name == "PROCESSING":
        print(".", end="", flush=True)
        time.sleep(2)
        sample_file = client.files.get(name=sample_file.name)
    print()

    if sample_file.state.name == "FAILED":
        print(f"Failed to process {pdf_path} in Gemini API.")
        return False

    print(f"Extracting handwriting to Markdown...")
    prompt = "Transcribe the handwritten notes in this document into clean, structured Markdown. Preserve headings, bullet points, and paragraphs as accurately as possible. CRITICAL RULES: 1. If you see a hand-drawn empty square box next to a sentence, format it as a Markdown checkbox `- [ ]` (or `- [x]` if checked). 2. If you see a vertical line or bracket in the margin grouping multiple paragraphs together, wrap all those paragraphs in a Markdown blockquote (prefix lines with `> `) and include any hashtag written next to the bracket inside the block. 3. If you see a drawn horizontal line across the page, format it exactly as a Markdown horizontal rule (`---`) to act as a section break."
    
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[sample_file, prompt]
    )
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(response.text)
    
    client.files.delete(name=sample_file.name)
    return True

def upload_to_drive(service, local_file_path, parent_folder_id, existing_file_id=None):
    file_name = os.path.basename(local_file_path)
    media = MediaFileUpload(local_file_path, mimetype='text/markdown')
    if existing_file_id:
        print(f"Updating existing {file_name} in Google Drive...")
        file = service.files().update(fileId=existing_file_id, media_body=media, fields='id').execute()
    else:
        file_metadata = {
            'name': file_name,
            'parents': [parent_folder_id]
        }
        print(f"Uploading {file_name} back to Google Drive...")
        file = service.files().create(body=file_metadata, media_body=media, fields='id').execute()
    print(f"Successfully saved File ID: {file.get('id')}")

def get_files_in_folder(service, parent_id, current_path=""):
    all_files = []
    query = f"'{parent_id}' in parents and trashed=false"
    page_token = None
    
    while True:
        results = service.files().list(
            q=query, 
            fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime)",
            pageToken=page_token
        ).execute()
        items = results.get("files", [])
        
        for item in items:
            if item["mimeType"] == "application/vnd.google-apps.folder":
                folder_path = current_path + "/" + item["name"] if current_path else item["name"]
                all_files.extend(get_files_in_folder(service, item["id"], folder_path))
            else:
                item["folder_path"] = current_path
                all_files.append(item)
                
        page_token = results.get('nextPageToken')
        if not page_token:
            break
            
    return all_files

@functions_framework.http
def sync_drive_notes(request):
    """HTTP Cloud Function entry point."""
    if not os.environ.get("GEMINI_API_KEY"):
        return "Please set the GEMINI_API_KEY environment variable in Cloud Functions.", 500

    try:
        service = get_drive_service()
        
        target_folders_env = os.environ.get("DRIVE_FOLDERS", "Viwoods-PDF")
        target_folders = [f.strip() for f in target_folders_env.split(",") if f.strip()]
        
        total_processed_count = 0
        
        for target_folder_name in target_folders:
            folder_query = f"mimeType='application/vnd.google-apps.folder' and name='{target_folder_name}' and trashed=false"
            folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
            folders = folder_results.get("files", [])
    
            if not folders:
                print(f"Could not find folder '{target_folder_name}'. Skipping.")
                continue
            
            folder_id = folders[0]["id"]
            print(f"Found '{target_folder_name}' folder. Scanning for PDFs...")
    
            all_files = get_files_in_folder(service, folder_id)
            
            existing_mds = {f["name"]: f for f in all_files if f["name"].endswith(".md") and f["name"] not in ["All_Notes_Master.md", "Scratch_Master.md", "Work_Master.md", "TODO_Master.md"]}
            pdfs_to_process = [f for f in all_files if f["name"].endswith(".pdf")]
            
            processed_count = 0
            
            for pdf in pdfs_to_process:
                expected_md_name = pdf["name"].replace(".pdf", ".md")
                existing_md_id = None
                
                if expected_md_name in existing_mds:
                    md_file = existing_mds[expected_md_name]
                    pdf_time = datetime.datetime.fromisoformat(pdf["modifiedTime"].replace("Z", "+00:00"))
                    md_time = datetime.datetime.fromisoformat(md_file["modifiedTime"].replace("Z", "+00:00"))
                    
                    if pdf_time <= md_time:
                        print(f"Skipping {pdf['name']} (Markdown is up to date).")
                        continue
                    else:
                        print(f"\n--- Updating {pdf['name']} (PDF was modified since last sync) ---")
                        existing_md_id = md_file["id"]
                else:
                    print(f"\n--- Processing new file: {pdf['name']} ---")
                    
                local_pdf_path = download_file(service, pdf['id'], pdf['name'], dest_folder="/tmp")
                local_md_path = local_pdf_path.replace(".pdf", ".md")
                
                try:
                    success = process_pdf_to_markdown(local_pdf_path, local_md_path)
                except Exception as e:
                    if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        print("Hit Google AI API rate limit! Stopping PDF processing for today, but will compile the Master file now.")
                        break
                    else:
                        print(f"Error processing {pdf['name']}: {e}")
                        continue
                        
                if success:
                    parent_id = pdf.get('parents', [folder_id])[0]
                    upload_to_drive(service, local_md_path, parent_id, existing_file_id=existing_md_id)
                    processed_count += 1
                    total_processed_count += 1
                    
                    print("PDF successfully processed and saved to Google Drive.")
                    
            print(f"\n--- Compiling Master Markdown Files for {target_folder_name} ---")
            
            final_files = get_files_in_folder(service, folder_id)
            
            master_categories = {
                "main": {"filename": "All_Notes_Master.md", "content": "# All Notes Master File\n\n", "files": []},
                "scratch": {"filename": "Scratch_Master.md", "content": "# Scratch Master File\n\n", "files": []},
                "work": {"filename": "Work_Master.md", "content": "# Work Master File\n\n", "files": []}
            }
            master_filenames = [cat["filename"] for cat in master_categories.values()] + ["TODO_Master.md"]
            
            todo_content = "# Master To-Do List\n\n"
            
            for f in final_files:
                if f["name"].endswith(".md") and f["name"] not in master_filenames:
                    path_lower = f.get("folder_path", "").lower()
                    path_parts = path_lower.split("/")
                    
                    if "scratch" in path_parts:
                        master_categories["scratch"]["files"].append(f)
                    elif "work" in path_parts:
                        master_categories["work"]["files"].append(f)
                    else:
                        master_categories["main"]["files"].append(f)
            
            for cat_name, cat_data in master_categories.items():
                if not cat_data["files"]:
                    continue
                    
                for md in cat_data["files"]:
                    local_md = download_file(service, md['id'], md['name'], dest_folder="/tmp/compile")
                    try:
                        with open(local_md, "r", encoding="utf-8") as f:
                            content = f.read()
                        cat_data["content"] += f"\n\n## Source: {md.get('folder_path', '')}/{md['name']}\n\n{content}\n"
                        
                        # Extract open To-Dos from this file
                        todos = [line.strip() for line in content.split("\n") if line.strip().startswith("- [ ]")]
                        if todos:
                            todo_content += f"## {md.get('folder_path', '')}/{md['name']}\n"
                            for t in todos:
                                todo_content += f"{t}\n"
                            todo_content += "\n"
                    except Exception as e:
                        print(f"Skipping {md['name']} during compile: {e}")
                        
                master_path = f"/tmp/{cat_data['filename']}"
                with open(master_path, "w", encoding="utf-8") as f:
                    f.write(cat_data["content"])
                    
                master_search = [f for f in final_files if f["name"] == cat_data["filename"]]
                master_id = master_search[0]["id"] if master_search else None
                
                print(f"Uploading {cat_data['filename']}...")
                upload_to_drive(service, master_path, folder_id, existing_file_id=master_id)
                
            # Upload TODO_Master.md
            if todo_content != "# Master To-Do List\n\n":
                todo_path = "/tmp/TODO_Master.md"
                with open(todo_path, "w", encoding="utf-8") as f:
                    f.write(todo_content)
                    
                todo_search = [f for f in final_files if f["name"] == "TODO_Master.md"]
                todo_id = todo_search[0]["id"] if todo_search else None
                
                print("Uploading TODO_Master.md...")
                upload_to_drive(service, todo_path, folder_id, existing_file_id=todo_id)
                
        return f"Sync complete! Processed {total_processed_count} files.", 200
        
    except HttpError as error:
        print(f"An error occurred: {error}")
        return f"Error: {error}", 500
    except Exception as e:
        print(f"Unexpected error: {e}")
        return f"Unexpected error: {e}", 500
