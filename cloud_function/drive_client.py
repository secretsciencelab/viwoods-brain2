import os
import json
import io
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload
import google.auth
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/drive"]

def get_drive_service():
    token_json_str = os.environ.get("DRIVE_TOKEN_JSON")
    if token_json_str:
        print("Using user's DRIVE_TOKEN_JSON for Drive API authentication...")
        token_info = json.loads(token_json_str)
        credentials = Credentials.from_authorized_user_info(token_info, SCOPES)
    else:
        try:
            credentials, project = google.auth.default(scopes=SCOPES)
        except google.auth.exceptions.DefaultCredentialsError:
            print("Falling back to token.json for Drive API authentication...")
            token_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'token.json')
            if os.path.exists(token_path):
                credentials = Credentials.from_authorized_user_file(token_path, SCOPES)
            else:
                raise
        
    return build("drive", "v3", credentials=credentials)

def download_file(service, file_id, file_name, dest_folder="/tmp"):
    if not os.path.exists(dest_folder):
        os.makedirs(dest_folder)
    
    # Prepend file_id to guarantee unique local paths for files with identical names across different folders
    file_path = os.path.join(dest_folder, f"{file_id}_{file_name}")
    request = service.files().get_media(fileId=file_id)
    fh = io.FileIO(file_path, "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    print(f"Downloading {file_name}...")
    while not done:
        status, done = downloader.next_chunk()
    return file_path

def get_or_create_folder(service, folder_name, parent_id):
    query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and '{parent_id}' in parents and trashed=false"
    results = service.files().list(q=query, fields="files(id)").execute()
    items = results.get("files", [])
    if items:
        return items[0]['id']
    else:
        file_metadata = {
            'name': folder_name,
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [parent_id]
        }
        folder = service.files().create(body=file_metadata, fields='id').execute()
        return folder['id']

def upload_image_to_drive(service, local_file_path, parent_folder_id):
    file_name = os.path.basename(local_file_path)
    query = f"name='{file_name}' and '{parent_folder_id}' in parents and trashed=false"
    results = service.files().list(q=query, fields="files(id)").execute()
    items = results.get("files", [])
    
    media = MediaFileUpload(local_file_path, mimetype='image/png')
    if items:
        service.files().update(fileId=items[0]['id'], media_body=media).execute()
    else:
        file_metadata = {
            'name': file_name,
            'parents': [parent_folder_id]
        }
        service.files().create(body=file_metadata, media_body=media).execute()

def upload_to_drive(service, local_file_path, parent_folder_id, existing_file_id=None, modified_time=None, source_md5=None):
    file_name = os.path.basename(local_file_path)
    media = MediaFileUpload(local_file_path, mimetype='text/markdown')
    
    # Anti-duplication check: if no known ID, query Drive immediately before uploading
    # to catch any files created by concurrent Cloud Run instances (e.g. from Scheduler retries)
    if not existing_file_id:
        query = f"name='{file_name}' and '{parent_folder_id}' in parents and trashed=false"
        results = service.files().list(q=query, fields="files(id)").execute()
        items = results.get("files", [])
        if items:
            existing_file_id = items[0]['id']
            
    if existing_file_id:
        print(f"Updating existing {file_name} in Google Drive...")
        body = {}
        if modified_time:
            body['modifiedTime'] = modified_time
        if source_md5:
            body['appProperties'] = {'source_md5': source_md5}
        file = service.files().update(fileId=existing_file_id, body=body, media_body=media, fields='id').execute()
    else:
        file_metadata = {
            'name': file_name,
            'parents': [parent_folder_id]
        }
        if modified_time:
            file_metadata['modifiedTime'] = modified_time
        if source_md5:
            file_metadata['appProperties'] = {'source_md5': source_md5}
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
            fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime, md5Checksum, appProperties)",
            pageToken=page_token
        ).execute()
        items = results.get("files", [])
        
        for item in items:
            if item["mimeType"] == "application/vnd.google-apps.folder":
                if item["name"].lower() in ["attachments", "_attachments", "scratch"]:
                    continue
                folder_path = current_path + "/" + item["name"] if current_path else item["name"]
                all_files.extend(get_files_in_folder(service, item["id"], folder_path))
            else:
                if item["name"].lower().endswith(".pdf"):
                    continue
                item["folder_path"] = current_path
                all_files.append(item)
                
        page_token = results.get('nextPageToken')
        if not page_token:
            break
            
    return all_files
