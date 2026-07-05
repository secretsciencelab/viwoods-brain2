import sys
import os
import io
sys.path.insert(0, 'cloud_function')
from main import get_drive_service, get_files_in_folder
from googleapiclient.http import MediaIoBaseDownload

service = get_drive_service()
folder_id = service.files().list(q="name='Viwoods-Note' and trashed=false", fields='files(id)').execute()['files'][0]['id']
files = get_files_in_folder(service, folder_id)
todo = next((f for f in files if f['name'] == 'TO DO.md'), None)

if todo:
    print(f"Downloading {todo['id']}")
    fh = io.FileIO('TO_DO.md', 'wb')
    dl = MediaIoBaseDownload(fh, service.files().get_media(fileId=todo['id']))
    done = False
    while not done:
        status, done = dl.next_chunk()
    print('Downloaded TO_DO.md')
else:
    print('TO DO.md not found')
