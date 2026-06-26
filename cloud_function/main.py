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
        try:
            credentials, project = google.auth.default(scopes=SCOPES)
        except google.auth.exceptions.DefaultCredentialsError:
            print("Falling back to token.json for Drive API authentication...")
            token_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'token.json')
            if os.path.exists(token_path):
                credentials = Credentials.from_authorized_user_file(token_path, SCOPES)
            else:
                raise
        
    return build("drive", "v3", credentials=credentials)

def download_file(service, file_id, file_name, dest_folder="/tmp"):
    if not os.path.exists(dest_folder):
        os.makedirs(dest_folder)
    
    # Prepend file_id to guarantee unique local paths for files with identical names across different folders
    file_path = os.path.join(dest_folder, f"{file_id}_{file_name}")
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
    prompt = "Transcribe the handwritten notes in this document into clean, structured Markdown. You MUST extract all tags and isolate them on their own dedicated line at the very top of the output (e.g., `#idea #design`). If the user did not explicitly write tags, search the body of the text for any hashtags and move them to this top line. If there are no tags anywhere, extract or infer one or more from the subject matter. CRITICAL RULES: 1. NEVER invent or generate titles. Only format a Markdown H1 heading (e.g., `# Title`) if the user explicitly wrote a title at the very top of the page, OR if you see any text that is explicitly underlined anywhere on the page. If there is a title, place it on line 1, and place the isolated tags on line 2. If there is no title, place the tags on line 1. 2. NEVER insert a space between the '#' symbol and the tag word (e.g. use `#tagname` NOT `# tagname`). Headers MUST have a space (e.g. `# Header Name`). Pay incredibly close attention to words starting with `#` in the handwriting (e.g. `#maxim`, `#todo`), and ALWAYS transcribe them exactly as hashtags, never mistaking them for headers. 3. If you see a hand-drawn empty square box next to a sentence, format it as a Markdown checkbox `- [ ]` (or `- [x]` if checked). 4. If you see a vertical line or bracket in the margin grouping multiple paragraphs together, wrap all those paragraphs in a Markdown blockquote (prefix lines with `> `) and include any hashtag written next to the bracket inside the block. 5. If you see a drawn horizontal line across the page, format it exactly as a Markdown horizontal rule (`---`) to act as a section break. 6. If you see any hand-drawn diagram, sketch, or doodle, write a highly detailed visual description enclosed in brackets: `[Drawing: A detailed description of what the sketch depicts]`. Do not generate SVGs."
    
    final_markdown = ""
    new_hashes = {}
    
    with zipfile.ZipFile(note_path, 'r') as z:
        note_list_file = next((f for f in z.namelist() if f.endswith('_NoteList.json')), None)
        page_list_file = next((f for f in z.namelist() if f.endswith('PageListFileInfo.json')), None)
        
        internal_dt = None
        target_file = note_list_file or page_list_file
        if target_file:
            dt_tuple = z.getinfo(target_file).date_time
            internal_dt = f"{dt_tuple[0]:04d}-{dt_tuple[1]:02d}-{dt_tuple[2]:02d}T{dt_tuple[3]:02d}:{dt_tuple[4]:02d}:{dt_tuple[5]:02d}.000Z"
        
        pages = []
        if note_list_file:
            with z.open(note_list_file) as f:
                note_list = json.load(f)
            for page in note_list:
                page_id = page.get('pageId', page.get('id'))
                image_names = [f"{page_id}.png", f"{page_id}.jpg"]
                
                # Check for inserted layout images in V1
                layout_img_file = f"{note_name}_{page_id}_LayoutImage.json"
                if layout_img_file in z.namelist():
                    try:
                        with z.open(layout_img_file) as img_f:
                            layouts = json.load(img_f)
                            for lay in layouts:
                                if 'imgUrl' in lay:
                                    img_filename = lay['imgUrl'].split('/')[-1]
                                    image_names.append(img_filename)
                    except Exception as e:
                        print(f"Error parsing layout image for V1: {e}")
                
                pages.append({
                    'id': page_id,
                    'lastModifiedTime': page.get('lastModifiedTime'),
                    'image_names': image_names,
                    'hash_files': [f"PATH_{page_id}.json", f"{page_id}_LayoutText.json", layout_img_file]
                })
        elif page_list_file:
            with z.open(page_list_file) as f:
                page_list = json.load(f)
                
            # Try to load PageResource.json to find the actual mainBmp and path files for each page
            resource_file = next((f for f in z.namelist() if f.endswith('PageResource.json')), None)
            page_resources = {}
            if resource_file:
                with z.open(resource_file) as f:
                    resources = json.load(f)
                    for r in resources:
                        pid = r.get('pid')
                        if pid not in page_resources:
                            page_resources[pid] = {'main': None, 'screenshot': None, 'paths': []}
                        if r.get('resourceType') == 1 and r.get('fileName', '').startswith('mainBmp_'):
                            page_resources[pid]['main'] = r.get('fileName')
                        elif r.get('resourceType') == 2 and r.get('fileName', '').startswith('screenshotBmp_'):
                            page_resources[pid]['screenshot'] = r.get('fileName')
                        elif r.get('resourceType') == 7 and r.get('fileName', '').startswith('path_'):
                            page_resources[pid]['paths'].append(r.get('fileName'))
            
            for page in page_list:
                page_id = page['id']
                res = page_resources.get(page_id, {'main': None, 'screenshot': None, 'paths': []})
                main_bmp = res['main']
                screenshot_bmp = res['screenshot']
                paths = res['paths']
                
                # Prefer screenshotBmp if available, as it contains all rendered layers
                best_image = screenshot_bmp if screenshot_bmp else main_bmp
                
                image_names = [best_image] if best_image else [f"screenshotBmp_{page_id}.png", f"mainBmp_{page_id}.png"]
                hash_files = paths if paths else [f"path_{page_id}.json", f"screenshotBmp_{page_id}.png"]
                
                pages.append({
                    'id': page_id,
                    'lastModifiedTime': page.get('lastModifiedTime'),
                    'image_names': image_names,
                    'hash_files': hash_files
                })
        else:
            print("Invalid .note file, no NoteList or PageList found.")
            return False, None
            
        import threading
        _google_api_lock = threading.Lock()
            
        def process_single_page(p):
            page_id = p['id']
            page_hash_content = b""
            for hf in p['hash_files']:
                if hf in z.namelist():
                    with z.open(hf) as f:
                        page_hash_content += f.read()
                        
            page_hash = hashlib.md5(page_hash_content).hexdigest()
            
            page_markdown = ""
            if page_id in existing_hashes and existing_hashes[page_id] == page_hash:
                print(f"Page {page_id} unchanged. Reusing existing markdown.")
                page_markdown = get_page_text_from_md(existing_md_content, page_id)
            else:
                print(f"Page {page_id} changed! OCRing with Gemini...")
                valid_image_bytes = []
                img_path = None
                
                for img_name in p['image_names']:
                    match = next((f for f in z.namelist() if f.endswith(img_name)), None)
                    if match:
                        img_path = f"/tmp/{os.path.basename(match)}"
                        
                        # Extract the nested file to /tmp/
                        with z.open(match) as source, open(img_path, "wb") as target:
                            target.write(source.read())
                            
                        # Flatten image onto white background if transparent
                        is_blank = False
                        try:
                            from PIL import Image, ImageOps
                            with Image.open(img_path) as img:
                                if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                                    if img.mode == 'P':
                                        img = img.convert('RGBA')
                                    
                                    alpha = img.split()[-1]
                                    if alpha.getextrema() == (0, 0):
                                        is_blank = True
                                    else:
                                        # Correctly flatten onto white background
                                        background = Image.new('RGB', img.size, (255, 255, 255))
                                        background.paste(img, mask=alpha)
                                        
                                        # If the flattened image is entirely white, the strokes were white (dark mode)!
                                        if background.convert('L').getextrema() == (255, 255):
                                            # Flatten onto a black background instead so white strokes are visible
                                            background = Image.new('RGB', img.size, (0, 0, 0))
                                            background.paste(img, mask=alpha)
                                            
                                        background.save(img_path, 'PNG')
                                        
                                elif img.mode != 'RGB':
                                    img = img.convert('RGB')
                                    img.save(img_path, 'PNG')
                                    if img.convert('L').getextrema() == (255, 255):
                                        is_blank = True
                        except ImportError:
                            print("Pillow not installed, skipping transparency flattening.")
                        except Exception as e:
                            print(f"Error processing image transparency: {e}")
                        
                        if not is_blank:
                            # Read the raw image bytes to send inline (bypassing the slow File API)
                            with open(img_path, "rb") as img_file:
                                valid_image_bytes.append(img_file.read())
                                
                if not valid_image_bytes:
                    print(f"Page {page_id} is completely blank. Skipping Gemini OCR.")
                    page_markdown = ""
                elif is_daily:
                    print(f"Page {page_id} is a Daily note. Skipping Gemini OCR as requested.")
                    page_markdown = ""
                else:
                    try:
                        from google.genai import types
                        contents = [types.Part.from_bytes(data=b, mime_type="image/png") for b in valid_image_bytes]
                        contents.append(prompt)
                        
                        response = client.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=contents
                        )
                        if response.text:
                            if p.get('lastModifiedTime'):
                                dt = datetime.datetime.fromtimestamp(p['lastModifiedTime'] / 1000.0)
                                timestamp = dt.strftime("%B %d, %Y at %I:%M %p")
                            else:
                                timestamp = datetime.datetime.now().strftime("%B %d, %Y at %I:%M %p")
                            page_markdown = f"> *Last updated: {timestamp}*\n\n" + response.text.strip()
                        else:
                            page_markdown = "[No text generated or response blocked by safety filters]"
                    except Exception as e:
                        print(f"Gemini API Error for page {page_id}: {e}")
                        raise e
                    
                if service and attachments_folder_id and img_path:
                    with _google_api_lock:
                        upload_image_to_drive(service, img_path, attachments_folder_id)
                    page_markdown = f"![Page {page_id}](_attachments/{note_name}/{os.path.basename(img_path)})\n\n" + page_markdown
                    
                if img_path and os.path.exists(img_path):
                    os.remove(img_path)
            
            return page_id, page_hash, page_markdown
            
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            # Map retains the original order of the pages list
            results = list(executor.map(process_single_page, pages))
            
        for page_id, page_hash, page_markdown in results:
            new_hashes[page_id] = page_hash
            if page_markdown:
                final_markdown += f"<!-- PAGE_{page_id}_START -->\n{page_markdown}\n<!-- PAGE_{page_id}_END -->\n\n"

    hashes_json = json.dumps(new_hashes)
    final_markdown += f"<!-- HASHES:\n{hashes_json}\n-->\n"
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(final_markdown)
        
    return True, internal_dt

def upload_to_drive(service, local_file_path, parent_folder_id, existing_file_id=None, modified_time=None, source_md5=None):
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
        body = {}
        if modified_time:
            body['modifiedTime'] = modified_time
        if source_md5:
            body['appProperties'] = {'source_md5': source_md5}
        file = service.files().update(fileId=existing_file_id, body=body, media_body=media, fields='id').execute()
    else:
        file_metadata = {
            'name': file_name,
            'parents': [parent_folder_id]
        }
        if modified_time:
            file_metadata['modifiedTime'] = modified_time
        if source_md5:
            file_metadata['appProperties'] = {'source_md5': source_md5}
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
            fields="nextPageToken, files(id, name, mimeType, parents, modifiedTime, md5Checksum, appProperties)",
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
            
            docs_to_process = [f for f in all_files if f["name"].endswith(".note") and not f["name"].lower().endswith(".pdf.note")]
            
            processed_count = 0
            
            for doc in docs_to_process:
                clean_note_name = doc["name"].replace(".note", "")
                if clean_note_name.startswith("day_"):
                    print(f"Skipping daily note entirely: {doc['name']}")
                    continue

                expected_md_name = doc["name"].replace(".note", ".md")
                expected_md_path = doc["folder_path"] + "/" + expected_md_name
                    
                existing_md_id = None
                existing_md_path = None
                
                if expected_md_path in existing_mds:
                    md_file = existing_mds[expected_md_path]
                    
                    doc_md5 = doc.get("md5Checksum")
                    md_app_props = md_file.get("appProperties", {})
                    
                    if doc_md5 and md_app_props and doc_md5 == md_app_props.get("source_md5"):
                        print(f"Skipping {doc['name']} (MD5 checksum matches).")
                        continue
                        
                    doc_time = datetime.datetime.fromisoformat(doc["modifiedTime"].replace("Z", "+00:00"))
                    md_time = datetime.datetime.fromisoformat(md_file["modifiedTime"].replace("Z", "+00:00"))
                    
                    if doc_time <= md_time:
                        print(f"Skipping {doc['name']} (Markdown is up to date based on timestamp).")
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
                    
                    success, internal_dt = process_note_to_markdown(local_doc_path, local_md_path, existing_md_path, service, parent_id, clean_note_name, is_daily)
                except Exception as e:
                    if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        print("Hit Google AI API rate limit! Stopping processing for today, but will compile Master file.")
                        break
                    else:
                        print(f"Error processing {doc['name']}: {e}")
                        continue
                        
                if success:
                    original_modified_time = internal_dt or doc.get('modifiedTime')
                    source_md5 = doc.get("md5Checksum")
                    upload_to_drive(service, local_md_path, parent_id, existing_file_id=existing_md_id, modified_time=original_modified_time, source_md5=source_md5)
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
                    
                def process_master_file(md):
                    try:
                        local_md = download_file(service, md['id'], md['name'], dest_folder="/tmp/compile")
                        with open(local_md, "r", encoding="utf-8") as f:
                            content = f.read()
                        
                        clean_content = re.sub(r'<!-- HASHES:\s*.*?\s*-->', '', content, flags=re.DOTALL)
                        clean_content = re.sub(r'<!-- PAGE_.*_START -->', '', clean_content)
                        clean_content = re.sub(r'<!-- PAGE_.*_END -->', '', clean_content)
                        
                        folder_path = md.get('folder_path', '')
                        name = md['name']
                        chunk = f"\n\n## Source: {folder_path}/{name}\n\n{clean_content.strip()}\n"
                        
                        todos = []
                        in_todo = False
                        current_todo = []
                        for line in clean_content.split("\n"):
                            if re.search(r'\[\s*\]|☐|\(\s*\)', line):
                                if in_todo:
                                    todos.append(" ".join(current_todo))
                                in_todo = True
                                clean_line = line.strip()
                                if re.match(r'^[☐\[\(]', clean_line):
                                    clean_line = "- " + clean_line
                                clean_line = re.sub(r'☐|\(\s*\)', '[ ]', clean_line, count=1)
                                current_todo = [clean_line]
                            elif in_todo:
                                if not line.strip() or re.search(r'^\s*(?:[-*+]|\d+\.)\s+', line):
                                    todos.append(" ".join(current_todo))
                                    in_todo = False
                                else:
                                    current_todo.append(line.strip())
                        if in_todo:
                            todos.append(" ".join(current_todo))
                        todo_chunk = ""
                        if todos:
                            todo_chunk = f"## {folder_path}/{name}\n" + "\n".join(todos) + "\n\n"
                            
                        return chunk, todo_chunk
                    except Exception as e:
                        import traceback
                        tb = traceback.format_exc()
                        return f"\n\n## ERROR PROCESSING {md['name']}\n\n```\n{tb}\n```\n\n", ""

                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
                    results = list(executor.map(process_master_file, cat_data["files"]))
                    
                for chunk, todo_chunk in results:
                    cat_data["content"] += chunk
                    if todo_chunk:
                        todo_content += todo_chunk
                        
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
