import io
import os
import time
import datetime
import zipfile
import json
import hashlib
import re

import functions_framework
import google.auth
from google import genai
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/drive"]

def get_drive_service():
    token_json_str = os.environ.get("DRIVE_TOKEN_JSON")
    if token_json_str:
        print("Using user's DRIVE_TOKEN_JSON for Drive API authentication...")
        token_info = json.loads(token_json_str)
        credentials = Credentials.from_authorized_user_info(token_info, SCOPES)
    else:
        print("Falling back to Service Account for Drive API authentication...")
        credentials, project = google.auth.default(scopes=SCOPES)
        
    return build("drive", "v3", credentials=credentials)

def download_file(service, file_id, file_name, dest_folder="/tmp"):
    if not os.path.exists(dest_folder):
        os.makedirs(dest_folder)
    
    file_path = os.path.join(dest_folder, file_name)
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

def get_page_hashes_from_md(md_content):
    match = re.search(r'<!-- HASHES:\s*(.*?)\s*-->', md_content, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except:
            return {}
    return {}

def get_page_text_from_md(md_content, page_id):
    pattern = r'<!-- PAGE_' + page_id + r'_START -->(.*?)<!-- PAGE_' + page_id + r'_END -->'
    match = re.search(pattern, md_content, re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""

def process_note_to_markdown(note_path, output_path, existing_md_path=None, service=None, parent_folder_id=None, note_name=None, is_daily=False):
    print(f"Extracting and analyzing {note_path}...")
    
    attachments_folder_id = None
    if service and parent_folder_id and note_name:
        attachments_base_id = get_or_create_folder(service, "_attachments", parent_folder_id)
        # Create a subfolder named after the note inside _attachments
        attachments_folder_id = get_or_create_folder(service, note_name, attachments_base_id)
    
    existing_hashes = {}
    existing_md_content = ""
    if existing_md_path and os.path.exists(existing_md_path):
        with open(existing_md_path, "r", encoding="utf-8") as f:
            existing_md_content = f.read()
        existing_hashes = get_page_hashes_from_md(existing_md_content)
        
    api_key = os.environ.get("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key)
    prompt = "Transcribe the handwritten notes in this document into clean, structured Markdown. Preserve headings, bullet points, and paragraphs as accurately as possible. CRITICAL RULES: 1. If you see a hand-drawn empty square box next to a sentence, format it as a Markdown checkbox `- [ ]` (or `- [x]` if checked). 2. If you see a vertical line or bracket in the margin grouping multiple paragraphs together, wrap all those paragraphs in a Markdown blockquote (prefix lines with `> `) and include any hashtag written next to the bracket inside the block. 3. If you see a drawn horizontal line across the page, format it exactly as a Markdown horizontal rule (`---`) to act as a section break. 4. If you see any non-text drawings, doodles, or sketches, write a highly detailed visual description of them enclosed in brackets, like this: `[Drawing: A detailed description of what the sketch depicts]`. This ensures drawings become text-searchable."
    
    final_markdown = ""
    new_hashes = {}
    
    with zipfile.ZipFile(note_path, 'r') as z:
        note_list_file = next((f for f in z.namelist() if f.endswith('_NoteList.json')), None)
        page_list_file = next((f for f in z.namelist() if f.endswith('PageListFileInfo.json')), None)
        
        pages = []
        if note_list_file:
            with z.open(note_list_file) as f:
                note_list = json.load(f)
            for page in note_list:
                page_id = page.get('pageId', page.get('id'))
                pages.append({
                    'id': page_id,
                    'image_names': [f"{page_id}.png", f"{page_id}.jpg"],
                    'hash_files': [f"PATH_{page_id}.json", f"{page_id}_LayoutText.json", f"{page_id}_LayoutImage.json"]
                })
        elif page_list_file:
            with z.open(page_list_file) as f:
                page_list = json.load(f)
            for page in page_list:
                page_id = page['id']
                pages.append({
                    'id': page_id,
                    'image_names': [f"screenshotBmp_{page_id}.png", f"mainBmp_{page_id}.png"],
                    'hash_files': [f"screenshotBmp_{page_id}.png"]
                })
        else:
            print("Invalid .note file, no NoteList or PageList found.")
            return False
            
        for p in pages:
            page_id = p['id']
            
            page_hash_content = b""
            for hf in p['hash_files']:
                if hf in z.namelist():
                    with z.open(hf) as f:
                        page_hash_content += f.read()
                        
            page_hash = hashlib.md5(page_hash_content).hexdigest()
            new_hashes[page_id] = page_hash
            
            page_markdown = ""
            if page_id in existing_hashes and existing_hashes[page_id] == page_hash:
                print(f"Page {page_id} unchanged. Reusing existing markdown.")
                page_markdown = get_page_text_from_md(existing_md_content, page_id)
            else:
                print(f"Page {page_id} changed! OCRing with Gemini...")
                image_file = None
                for img_name in p['image_names']:
                    match = next((f for f in z.namelist() if f.endswith(img_name)), None)
                    if match:
                        image_file = match
                        break
                
                if image_file:
                    img_path = f"/tmp/{os.path.basename(image_file)}"
                    
                    # Extract the nested file to /tmp/
                    with z.open(image_file) as source, open(img_path, "wb") as target:
                        target.write(source.read())
                        
                    # Flatten image onto white background if transparent
                    is_blank = False
                    try:
                        from PIL import Image, ImageOps
                        with Image.open(img_path) as img:
                            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                                if img.mode == 'P':
                                    img = img.convert('RGBA')
                                alpha = img.split()[-1] # The alpha channel
                                inverted_alpha = ImageOps.invert(alpha)
                                inverted_alpha.save(img_path, 'PNG')
                                if inverted_alpha.getextrema() == (255, 255):
                                    is_blank = True
                            elif img.mode != 'RGB':
                                img = img.convert('RGB')
                                img.save(img_path, 'PNG')
                                if img.convert('L').getextrema() == (255, 255):
                                    is_blank = True
                    except ImportError:
                        print("Pillow not installed, skipping transparency flattening.")
                    except Exception as e:
                        print(f"Error processing image transparency: {e}")
                    
                    # Read the raw image bytes to send inline (bypassing the slow File API)
                    with open(img_path, "rb") as img_file:
                        image_bytes = img_file.read()
                        
                    if is_blank:
                        print(f"Page {page_id} is completely blank. Skipping Gemini OCR.")
                        page_markdown = ""
                    elif is_daily:
                        print(f"Page {page_id} is a Daily note. Skipping Gemini OCR as requested.")
                        page_markdown = ""
                    else:
                        try:
                            from google.genai import types
                            response = client.models.generate_content(
                                model="gemini-2.5-flash",
                                contents=[
                                    types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
                                    prompt
                                ]
                            )
                            if response.text:
                                timestamp = datetime.datetime.now().strftime("%B %d, %Y at %I:%M %p")
                                page_markdown = f"> *Last updated: {timestamp}*\n\n" + response.text.strip()
                            else:
                                page_markdown = "[No text generated or response blocked by safety filters]"
                        except Exception as e:
                            print(f"Gemini API Error for page {page_id}: {e}")
                            page_markdown = "[Error communicating with Gemini API]"
                        
                    if service and attachments_folder_id:
                        upload_image_to_drive(service, img_path, attachments_folder_id)
                        page_markdown = f"![Page {page_id}](_attachments/{note_name}/{os.path.basename(image_file)})\n\n" + page_markdown
                        
                    os.remove(img_path)
                else:
                    page_markdown = f"[Warning: Could not find image for page {page_id} in the .note file]\n\n" + page_markdown
            
            final_markdown += f"<!-- PAGE_{page_id}_START -->\n{page_markdown}\n<!-- PAGE_{page_id}_END -->\n\n"

    hashes_json = json.dumps(new_hashes)
    final_markdown += f"<!-- HASHES:\n{hashes_json}\n-->\n"
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(final_markdown)
        
    return True

def upload_to_drive(service, local_file_path, parent_folder_id, existing_file_id=None):
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
        file = service.files().update(fileId=existing_file_id, media_body=media, fields='id').execute()
    else:
        file_metadata = {
            'name': file_name,
            'parents': [parent_folder_id]
        }
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
            fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime)",
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

@functions_framework.http
def sync_drive_notes(request):
    """HTTP Cloud Function entry point."""
    if not os.environ.get("GEMINI_API_KEY"):
        return "Please set the GEMINI_API_KEY environment variable in Cloud Functions.", 500

    try:
        service = get_drive_service()
        
        target_folders_env = os.environ.get("DRIVE_FOLDERS", "Viwoods-Note")
        target_folders = [f.strip() for f in target_folders_env.split(",") if f.strip()]
        
        total_processed_count = 0
        
        for target_folder_name in target_folders:
            folder_query = f"mimeType='application/vnd.google-apps.folder' and name='{target_folder_name}' and trashed=false"
            folder_results = service.files().list(q=folder_query, fields="files(id, name)").execute()
            folders = folder_results.get("files", [])
    
            if not folders:
                continue
            
            folder_id = folders[0]["id"]
            print(f"Found '{target_folder_name}' folder. Scanning for documents...")
    
            all_files = get_files_in_folder(service, folder_id)
            
            existing_mds = {f["folder_path"] + "/" + f["name"]: f for f in all_files if f["name"].endswith(".md") and f["name"] not in ["All_Notes_Master.md", "Scratch_Master.md", "Work_Master.md", "TODO_Master.md"]}
            
            docs_to_process = [f for f in all_files if f["name"].endswith(".note")]
            
            processed_count = 0
            
            for doc in docs_to_process:
                expected_md_name = doc["name"].replace(".note", ".md")
                expected_md_path = doc["folder_path"] + "/" + expected_md_name
                    
                existing_md_id = None
                existing_md_path = None
                
                if expected_md_path in existing_mds:
                    md_file = existing_mds[expected_md_path]
                    
                    doc_time = datetime.datetime.fromisoformat(doc["modifiedTime"].replace("Z", "+00:00"))
                    md_time = datetime.datetime.fromisoformat(md_file["modifiedTime"].replace("Z", "+00:00"))
                    
                    if doc_time <= md_time:
                        print(f"Skipping {doc['name']} (Markdown is up to date).")
                        continue
                    
                    existing_md_id = md_file["id"]
                    
                    print(f"\n--- Updating {doc['name']} (Checking for internal modifications) ---")
                    # Download existing md so we can reuse page hashes
                    existing_md_path = download_file(service, md_file['id'], expected_md_name, dest_folder="/tmp/cache")
                else:
                    print(f"\n--- Processing new file: {doc['name']} ---")
                    
                local_doc_path = download_file(service, doc['id'], doc['name'], dest_folder="/tmp")
                local_md_path = os.path.join("/tmp", expected_md_name)
                
                parent_id = doc.get('parents', [folder_id])[0]
                
                try:
                    clean_note_name = doc["name"].replace(".note", "")
                    is_daily = "Daily" in doc.get("folder_path", "") or clean_note_name.startswith("day_")
                    success = process_note_to_markdown(local_doc_path, local_md_path, existing_md_path, service, parent_id, clean_note_name, is_daily)
                except Exception as e:
                    if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        print("Hit Google AI API rate limit! Stopping processing for today, but will compile Master file.")
                        break
                    else:
                        print(f"Error processing {doc['name']}: {e}")
                        continue
                        
                if success:
                    upload_to_drive(service, local_md_path, parent_id, existing_file_id=existing_md_id)
                    processed_count += 1
                    total_processed_count += 1
                    
            print(f"\n--- Compiling Master Markdown Files for {target_folder_name} ---")
            
            final_files = get_files_in_folder(service, folder_id)
            
            master_categories = {
                "main": {"filename": "All_Notes_Master.md", "content": "# All Notes Master File\n\n", "files": []},
                "scratch": {"filename": "Scratch_Master.md", "content": "# Scratch Master File\n\n", "files": []},
                "work": {"filename": "Work_Master.md", "content": "# Work Master File\n\n", "files": []}
            }
            master_filenames = [cat["filename"] for cat in master_categories.values()] + ["TODO_Master.md"]
            
            todo_content = "# Master To-Do List\n\n"
            
            for f in final_files:
                if f["name"].endswith(".md") and f["name"] not in master_filenames:
                    path_lower = f.get("folder_path", "").lower()
                    path_parts = path_lower.split("/")
                    
                    if "scratch" in path_parts:
                        master_categories["scratch"]["files"].append(f)
                    elif "work" in path_parts:
                        master_categories["work"]["files"].append(f)
                    else:
                        master_categories["main"]["files"].append(f)
            
            for cat_name, cat_data in master_categories.items():
                if not cat_data["files"]:
                    continue
                    
                for md in cat_data["files"]:
                    local_md = download_file(service, md['id'], md['name'], dest_folder="/tmp/compile")
                    try:
                        with open(local_md, "r", encoding="utf-8") as f:
                            content = f.read()
                        # strip out the hashes block so the master file is clean
                        clean_content = re.sub(r'<!-- HASHES:\s*.*?\s*-->', '', content, flags=re.DOTALL)
                        clean_content = re.sub(r'<!-- PAGE_.*_START -->', '', clean_content)
                        clean_content = re.sub(r'<!-- PAGE_.*_END -->', '', clean_content)
                        
                        cat_data["content"] += f"\n\n## Source: {md.get('folder_path', '')}/{md['name']}\n\n{clean_content.strip()}\n"
                        
                        todos = [line.strip() for line in clean_content.split("\n") if line.strip().startswith("- [ ]")]
                        if todos:
                            todo_content += f"## {md.get('folder_path', '')}/{md['name']}\n"
                            for t in todos:
                                todo_content += f"{t}\n"
                            todo_content += "\n"
                    except Exception as e:
                        pass
                        
                master_path = f"/tmp/{cat_data['filename']}"
                with open(master_path, "w", encoding="utf-8") as f:
                    f.write(cat_data["content"])
                    
                master_search = [f for f in final_files if f["name"] == cat_data["filename"]]
                master_id = master_search[0]["id"] if master_search else None
                upload_to_drive(service, master_path, folder_id, existing_file_id=master_id)
                
            if todo_content != "# Master To-Do List\n\n":
                todo_path = "/tmp/TODO_Master.md"
                with open(todo_path, "w", encoding="utf-8") as f:
                    f.write(todo_content)
                    
                todo_search = [f for f in final_files if f["name"] == "TODO_Master.md"]
                todo_id = todo_search[0]["id"] if todo_search else None
                upload_to_drive(service, todo_path, folder_id, existing_file_id=todo_id)
                
        return f"Sync complete! Processed {total_processed_count} files.", 200
        
    except HttpError as error:
        print(f"An error occurred: {error}")
        return f"Error: {error}", 500
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Unexpected error: {e}")
        return f"Unexpected error: {e}", 500
