import os
import zipfile
import json
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io
import datetime

SCOPES = ['https://www.googleapis.com/auth/drive']

def get_drive_service():
    creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    return build('drive', 'v3', credentials=creds)

def main():
    service = get_drive_service()
    
    # 2. Update .md dates using internal zip time
    query = "name contains '.note' and trashed=false"
    results = service.files().list(q=query, fields="files(id, name)").execute()
    
    for note in results.get('files', []):
        if not note['name'].endswith('.note') or note['name'].startswith('day_'):
            continue
            
        print(f"Processing {note['name']}...")
        request = service.files().get_media(fileId=note['id'])
        fh = io.BytesIO()
        downloader = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            status, done = downloader.next_chunk()
            
        fh.seek(0)
        internal_dt = None
        try:
            with zipfile.ZipFile(fh, 'r') as z:
                target = next((f for f in z.namelist() if f.endswith('_NoteList.json') or f.endswith('PageListFileInfo.json')), None)
                if target:
                    dt = z.getinfo(target).date_time
                    internal_dt = f"{dt[0]:04d}-{dt[1]:02d}-{dt[2]:02d}T{dt[3]:02d}:{dt[4]:02d}:{dt[5]:02d}.000Z"
        except Exception as e:
            print(f"Error reading zip: {e}")
            continue
            
        if internal_dt:
            # Find matching .md
            md_name = note['name'].replace('.note', '.md')
            q = f"name='{md_name}' and trashed=false"
            md_results = service.files().list(q=q, fields="files(id)").execute()
            for md in md_results.get('files', []):
                print(f"Updating {md_name} to {internal_dt}")
                service.files().update(fileId=md['id'], body={'modifiedTime': internal_dt}, fields='id, modifiedTime').execute()

if __name__ == '__main__':
    main()
