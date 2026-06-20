import io
import os
import time

from dotenv import load_dotenv
from google import genai
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload

# We need full drive access to read existing files and upload new ones
SCOPES = ["https://www.googleapis.com/auth/drive"]

def get_drive_service():
    creds = None
    if os.path.exists("token.json"):
        # We try to load the token. If scopes changed, it might fail or we might need to re-auth.
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
        if creds and not creds.has_scopes(SCOPES):
            print("Scopes changed. Deleting old token.json to re-authenticate...")
            os.remove("token.json")
            creds = None

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception:
                if os.path.exists("token.json"):
                    os.remove("token.json")
                return get_drive_service()
        else:
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as token:
            token.write(creds.to_json())
    return build("drive", "v3", credentials=creds)

def download_file(service, file_id, file_name, dest_folder="downloads"):
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
    client = genai.Client()
    
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

def get_files_in_folder(service, parent_id):
    all_files = []
    query = f"'{parent_id}' in parents and trashed=false"
    results = service.files().list(q=query, fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime)").execute()
    items = results.get("files", [])
    
    for item in items:
        if item["mimeType"] == "application/vnd.google-apps.folder":
            all_files.extend(get_files_in_folder(service, item["id"]))
        else:
            all_files.append(item)
    return all_files

import datetime

def main():
    load_dotenv()
    if not os.environ.get("GEMINI_API_KEY"):
        print("Please set the GEMINI_API_KEY environment variable in the .env file.")
        return

    try:
        service = get_drive_service()
        
        # Find the Viwoods-PDF folder
        folder_query = "mimeType='application/vnd.google-apps.folder' and name='Viwoods-PDF' and trashed=false"
        folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
        folders = folder_results.get("files", [])

        if not folders:
            print("Could not find the 'Viwoods-PDF' folder in your Google Drive.")
            return
        
        folder_id = folders[0]["id"]
        print(f"Found 'Viwoods-PDF' folder. Scanning for PDFs...")

        all_files = get_files_in_folder(service, folder_id)
        
        # Map out existing Markdown files so we can check their modification times
        existing_mds = {f["name"]: f for f in all_files if f["name"].endswith(".md")}
        pdfs_to_process = [f for f in all_files if f["name"].endswith(".pdf")]
        
        for pdf in pdfs_to_process:
            expected_md_name = pdf["name"].replace(".pdf", ".md")
            existing_md_id = None
            
            if expected_md_name in existing_mds:
                md_file = existing_mds[expected_md_name]
                # Parse the ISO 8601 strings (Drive returns them ending in Z)
                pdf_time = datetime.datetime.fromisoformat(pdf["modifiedTime"].replace("Z", "+00:00"))
                md_time = datetime.datetime.fromisoformat(md_file["modifiedTime"].replace("Z", "+00:00"))
                
                # If the PDF hasn't been modified since we last updated the MD, skip it
                if pdf_time <= md_time:
                    print(f"Skipping {pdf['name']} (Markdown is up to date).")
                    continue
                else:
                    print(f"\n--- Updating {pdf['name']} (PDF was modified since last sync) ---")
                    existing_md_id = md_file["id"]
            else:
                print(f"\n--- Processing new file: {pdf['name']} ---")
                
            local_pdf_path = download_file(service, pdf['id'], pdf['name'])
            local_md_path = local_pdf_path.replace(".pdf", ".md")
            
            success = process_pdf_to_markdown(local_pdf_path, local_md_path)
            if success:
                # Upload back to the exact same directory in Google Drive where the PDF lives
                parent_id = pdf.get('parents', [folder_id])[0]
                upload_to_drive(service, local_md_path, parent_id)
                print("Sleeping for 15 seconds to respect free-tier rate limits...")
                time.sleep(15)
                
    except HttpError as error:
        print(f"An error occurred: {error}")

if __name__ == "__main__":
    main()
