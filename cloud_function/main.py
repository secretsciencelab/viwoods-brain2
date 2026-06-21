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
    prompt = "Transcribe the handwritten notes in this document into clean, structured Markdown. Preserve headings, bullet points, and paragraphs as accurately as possible."
    
    response = client.models.generate_content(
        model="gemini-2.5-flash-lite",
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

def get_files_in_folder(service, parent_id):
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
                all_files.extend(get_files_in_folder(service, item["id"]))
            else:
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
        
        # Find the Viwoods-PDF folder
        folder_query = "mimeType='application/vnd.google-apps.folder' and name='Viwoods-PDF' and trashed=false"
        folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
        folders = folder_results.get("files", [])

        if not folders:
            return "Could not find the 'Viwoods-PDF' folder. Make sure it is shared with the Service Account email.", 404
        
        folder_id = folders[0]["id"]
        print(f"Found 'Viwoods-PDF' folder. Scanning for PDFs...")

        all_files = get_files_in_folder(service, folder_id)
        
        existing_mds = {f["name"]: f for f in all_files if f["name"].endswith(".md") and f["name"] != "All_Notes_Master.md"}
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
                
            # Cloud Functions only allow writing to /tmp directory
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
                
                # Sleep to respect rate limits if we plan to process multiple
                print("Sleeping for 15 seconds to respect free-tier rate limits...")
                time.sleep(15)
                
        print("\n--- Compiling Master Markdown File ---")
        master_content = "# All Notes Master File\n\n"
        
        # Refresh the file list to include any newly created MD files
        final_files = get_files_in_folder(service, folder_id)
        final_mds = [f for f in final_files if f["name"].endswith(".md") and f["name"] != "All_Notes_Master.md"]
        
        for md in final_mds:
            local_md = download_file(service, md['id'], md['name'], dest_folder="/tmp/compile")
            try:
                with open(local_md, "r", encoding="utf-8") as f:
                    content = f.read()
                master_content += f"\n\n## Source: {md['name']}\n\n{content}\n"
            except Exception as e:
                print(f"Skipping {md['name']} during compile: {e}")
                
        master_path = "/tmp/All_Notes_Master.md"
        with open(master_path, "w", encoding="utf-8") as f:
            f.write(master_content)
            
        master_search = [f for f in final_files if f["name"] == "All_Notes_Master.md"]
        master_id = master_search[0]["id"] if master_search else None
        
        upload_to_drive(service, master_path, folder_id, existing_file_id=master_id)
                
        return f"Sync complete! Processed {processed_count} files.", 200
        
    except HttpError as error:
        print(f"An error occurred: {error}")
        return f"Error: {error}", 500
    except Exception as e:
        print(f"Unexpected error: {e}")
        return f"Unexpected error: {e}", 500
