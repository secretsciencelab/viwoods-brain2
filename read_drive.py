import os.path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# If modifying these scopes, delete the file token.json.
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def main():
  """Shows basic usage of the Drive v3 API.
  Prints the names and ids of the first 10 files the user has access to.
  """
  creds = None
  # The file token.json stores the user's access and refresh tokens, and is
  # created automatically when the authorization flow completes for the first
  # time.
  if os.path.exists("token.json"):
    creds = Credentials.from_authorized_user_file("token.json", SCOPES)
  # If there are no (valid) credentials available, let the user log in.
  if not creds or not creds.valid:
    if creds and creds.expired and creds.refresh_token:
      creds.refresh(Request())
    else:
      flow = InstalledAppFlow.from_client_secrets_file(
          "credentials.json", SCOPES
      )
      creds = flow.run_local_server(port=0)
    # Save the credentials for the next run
    with open("token.json", "w") as token:
      token.write(creds.to_json())

  try:
    service = build("drive", "v3", credentials=creds)

    # 1. Find the Viwoods-PDF folder
    folder_query = "mimeType='application/vnd.google-apps.folder' and name='Viwoods-PDF' and trashed=false"
    folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
    folders = folder_results.get("files", [])

    if not folders:
      print("Could not find the 'Viwoods-PDF' folder in your Google Drive.")
      return
    
    folder_id = folders[0]["id"]
    print(f"Found 'Viwoods-PDF' folder (ID: {folder_id})\n")

    # Recursive function to get all files
    def get_files_in_folder(service, parent_id, path=""):
      all_files = []
      
      # Query for files and folders inside this parent
      query = f"'{parent_id}' in parents and trashed=false"
      results = service.files().list(q=query, fields="nextPageToken, files(id, name, mimeType)").execute()
      items = results.get("files", [])
      
      for item in items:
        if item["mimeType"] == "application/vnd.google-apps.folder":
          # It's a subdirectory, recurse into it
          sub_path = f"{path}{item['name']}/"
          all_files.extend(get_files_in_folder(service, item["id"], sub_path))
        else:
          # It's a file
          all_files.append({"name": item["name"], "id": item["id"], "path": path})
          
      return all_files

    # 2. Get all files recursively
    print("Scanning for files...")
    all_files = get_files_in_folder(service, folder_id)

    if not all_files:
      print("No files found inside the 'Viwoods-PDF' folder or its subdirectories.")
      return
      
    print(f"\nFound {len(all_files)} files in 'Viwoods-PDF' and its subdirectories:")
    for f in all_files:
      folder_path = f"/{f['path']}" if f['path'] else "/"
      print(f"- {folder_path}{f['name']} (ID: {f['id']})")

  except HttpError as error:
    # TODO(developer) - Handle errors from drive API.
    print(f"An error occurred: {error}")


if __name__ == "__main__":
  main()
