import sys
import os
import io
sys.path.insert(0, 'cloud_function')
from main import get_drive_service, get_files_in_folder
from googleapiclient.http import MediaIoBaseDownload

service = get_drive_service()
folder_id = service.files().list(q="name='Viwoods-Note' and trashed=false", fields='files(id)').execute()['files'][0]['id']
files = get_files_in_folder(service, folder_id)
concepts = next(f for f in files if f['name'] == 'Concepts 1.note')

print(f"Downloading {concepts['id']}")
fh = io.FileIO('Concepts_1.note', 'wb')
dl = MediaIoBaseDownload(fh, service.files().get_media(fileId=concepts['id']))
done = False
while not done:
    status, done = dl.next_chunk()

print('Downloaded Concepts_1.note')
