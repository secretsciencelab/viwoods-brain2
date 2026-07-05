import os
import sys
sys.path.append(os.path.join(os.path.dirname(__file__), 'cloud_function'))
from main import get_drive_service

service = get_drive_service()
results = service.files().list(q="name='GAMING.md' and trashed=false", fields="files(id, name)").execute()
items = results.get('files', [])

if items:
    file_id = items[0]['id']
    from googleapiclient.http import MediaIoBaseDownload
    import io
    request = service.files().get_media(fileId=file_id)
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while done is False:
        status, done = downloader.next_chunk()
    print(fh.getvalue().decode('utf-8'))
else:
    print("File not found")
