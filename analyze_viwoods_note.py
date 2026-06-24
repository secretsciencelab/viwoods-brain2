import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import io
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]

def main():
    if not os.path.exists("token.json"):
        print("token.json not found")
        return
        
    creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    service = build("drive", "v3", credentials=creds)

    # Find the Viwoods-Note folder
    folder_query = "mimeType='application/vnd.google-apps.folder' and name='Viwoods-Note' and trashed=false"
    folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
    folders = folder_results.get("files", [])

    if not folders:
        print("Could not find the 'Viwoods-Note' folder.")
        return
    
    folder_id = folders[0]["id"]
    print(f"Found 'Viwoods-Note' folder (ID: {folder_id})")

    def get_first_file(parent_id):
        query = f"'{parent_id}' in parents and trashed=false"
        results = service.files().list(q=query, fields="files(id, name, mimeType)").execute()
        items = results.get("files", [])
        
        for item in items:
            if item["mimeType"] != "application/vnd.google-apps.folder":
                return item
        
        for item in items:
            if item["mimeType"] == "application/vnd.google-apps.folder":
                found = get_first_file(item["id"])
                if found:
                    return found
        return None

    target_file = get_first_file(folder_id)
                    
    if not target_file:
        print("No files found.")
        return

    print(f"Downloading {target_file['name']}...")
    request = service.files().get_media(fileId=target_file['id'])
    
    fh = io.FileIO(target_file['name'], "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()
        
    print(f"Downloaded {target_file['name']}. Reading first few bytes:")
    
    # Analyze the file format
    with open(target_file['name'], 'rb') as f:
        header = f.read(256)
        print("Hex:", header.hex())
        print("Ascii:", repr(header))

if __name__ == "__main__":
    main()
