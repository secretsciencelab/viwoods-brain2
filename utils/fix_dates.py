import os
import json
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/drive']

def get_drive_service():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    return build('drive', 'v3', credentials=creds)

def main():
    print("Fixing modified dates for existing .md files...")
    service = get_drive_service()
    
    # 1. Get all files in Viwoods-Note
    query = f"mimeType='application/vnd.google-apps.folder' and name='Viwoods-Note' and trashed=false"
    folder_results = service.files().list(q=query, fields="files(id, name)").execute()
    folders = folder_results.get("files", [])
    if not folders:
        print("Folder not found.")
        return
        
    folder_id = folders[0]["id"]
    
    def get_files_in_folder(parent_id):
        all_files = []
        q = f"'{parent_id}' in parents and trashed=false"
        page_token = None
        while True:
            results = service.files().list(
                q=q, 
                fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime)",
                pageToken=page_token,
                pageSize=1000
            ).execute()
            
            items = results.get('files', [])
            for item in items:
                all_files.append(item)
                if item['mimeType'] == 'application/vnd.google-apps.folder' and item['name'] != '_attachments':
                    all_files.extend(get_files_in_folder(item['id']))
                    
            page_token = results.get('nextPageToken')
            if not page_token:
                break
        return all_files
        
    all_files = get_files_in_folder(folder_id)
    
    notes = {f['name']: f for f in all_files if f['name'].endswith('.note')}
    mds = {f['name']: f for f in all_files if f['name'].endswith('.md')}
    
    updated_count = 0
    for note_name, note_meta in notes.items():
        clean_name = note_name.replace('.note', '')
        md_name = f"{clean_name}.md"
        
        if md_name in mds:
            md_meta = mds[md_name]
            # Set md file's modified time to match note file's modified time
            body = {'modifiedTime': note_meta['modifiedTime']}
            print(f"Updating {md_name} to {note_meta['modifiedTime']}...")
            service.files().update(fileId=md_meta['id'], body=body).execute()
            updated_count += 1
            
    print(f"Done! Fixed {updated_count} files.")

if __name__ == '__main__':
    main()
