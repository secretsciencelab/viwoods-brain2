import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'cloud_function'))
from main import get_drive_service, get_files_in_folder

service = get_drive_service()
folder_query = f"mimeType='application/vnd.google-apps.folder' and name='Viwoods-Note' and trashed=false"
folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
folders = folder_results.get("files", [])

if not folders:
    print("Folder not found.")
    sys.exit()

folder_id = folders[0]["id"]
print(f"Scanning folder {folder_id}...")
all_files = get_files_in_folder(service, folder_id)

md_files = [f for f in all_files if f["name"].endswith(".md")]
print(f"Found {len(md_files)} .md files to delete.")

for md in md_files:
    print(f"Deleting {md['name']} ({md['id']})")
    try:
        service.files().delete(fileId=md['id']).execute()
    except Exception as e:
        print(f"Error deleting {md['name']}: {e}")

print("Deletion complete.")
