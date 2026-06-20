import io
import os
import time

import google.generativeai as genai
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

# Scopes for Google Drive API
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def get_drive_service():
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
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
    while done is False:
        status, done = downloader.next_chunk()
    return file_path

from google import genai

def process_pdf_to_markdown(pdf_path, output_path):
    print(f"Uploading {pdf_path} to Gemini for OCR...")
    client = genai.Client()
    
    # Upload the file to the Gemini API
    sample_file = client.files.upload(file=pdf_path)
    
    # Wait for the file to be processed
    while sample_file.state.name == "PROCESSING":
        print(".", end="", flush=True)
        time.sleep(2)
        sample_file = client.files.get(name=sample_file.name)
    print()

    if sample_file.state.name == "FAILED":
        print(f"Failed to process {pdf_path} in Gemini API.")
        return

    # Call Gemini to transcribe
    print(f"Extracting handwriting to Markdown...")
    prompt = "Transcribe the handwritten notes in this document into clean, structured Markdown. Preserve headings, bullet points, and paragraphs as accurately as possible."
    
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[sample_file, prompt]
    )
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(response.text)
    
    print(f"Saved Markdown to {output_path}")

    # Cleanup the file from Gemini storage
    client.files.delete(name=sample_file.name)

from dotenv import load_dotenv

def main():
    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Please set the GEMINI_API_KEY environment variable.")
        return

    try:
        service = get_drive_service()
        
        # Example: Just grabbing the first PDF to test the workflow
        print("Searching for a PDF to test...")
        query = "mimeType='application/pdf' and '1NoQlyn5swtg00vEB5g6C53NpCdfzfHan' in parents" # Assuming direct child, or we can use our recursive search
        # For simplicity in testing, let's just search anywhere in the drive for a file named 'NOTES 2026.pdf'
        query = "name='NOTES 2026.pdf' and trashed=false"
        results = service.files().list(q=query, fields="files(id, name)").execute()
        items = results.get("files", [])
        
        if not items:
            print("Could not find a test file.")
            return
            
        test_file = items[0]
        file_id = test_file['id']
        file_name = test_file['name']
        
        # 1. Download
        local_pdf_path = download_file(service, file_id, file_name)
        
        # 2. Process
        output_md_path = os.path.join("downloads", file_name.replace(".pdf", ".md"))
        process_pdf_to_markdown(local_pdf_path, output_md_path)
        
    except HttpError as error:
        print(f"An error occurred: {error}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    main()
