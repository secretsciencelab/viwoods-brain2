import os
import json
import zipfile
import hashlib
import re
import concurrent.futures
import threading

from drive_client import get_or_create_folder, upload_image_to_drive
from gemini_ocr import run_gemini_ocr

_google_api_lock = threading.Lock()

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
        attachments_folder_id = get_or_create_folder(service, note_name, attachments_base_id)
    
    existing_hashes = {}
    existing_md_content = ""
    if existing_md_path and os.path.exists(existing_md_path):
        with open(existing_md_path, "r", encoding="utf-8") as f:
            existing_md_content = f.read()
        existing_hashes = get_page_hashes_from_md(existing_md_content)
        
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
                    'hash_files': image_names
                })
        elif page_list_file:
            with z.open(page_list_file) as f:
                page_list = json.load(f)
                
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
                
                best_image = screenshot_bmp if screenshot_bmp else main_bmp
                image_names = [best_image] if best_image else [f"screenshotBmp_{page_id}.png", f"mainBmp_{page_id}.png"]
                hash_files = image_names
                
                pages.append({
                    'id': page_id,
                    'lastModifiedTime': page.get('lastModifiedTime'),
                    'image_names': image_names,
                    'hash_files': hash_files
                })
        else:
            print("Invalid .note file, no NoteList or PageList found.")
            return False, None
            
        def process_single_page(p):
            page_id = p['id']
            page_hash_content = b""
            for hf in p['hash_files']:
                match = next((f for f in z.namelist() if f.endswith(hf)), None)
                if match:
                    with z.open(match) as f:
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
                        
                        with z.open(match) as source, open(img_path, "wb") as target:
                            target.write(source.read())
                            
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
                                        background = Image.new('RGB', img.size, (255, 255, 255))
                                        background.paste(img, mask=alpha)
                                        
                                        if background.convert('L').getextrema() == (255, 255):
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
                            with open(img_path, "rb") as img_file:
                                valid_image_bytes.append(img_file.read())
                                
                page_markdown = run_gemini_ocr(valid_image_bytes, page_id, p.get('lastModifiedTime'), is_daily)
                
                if service and attachments_folder_id and img_path:
                    with _google_api_lock:
                        upload_image_to_drive(service, img_path, attachments_folder_id)
                    page_markdown = f"![Page {page_id}](_attachments/{note_name}/{os.path.basename(img_path)})\n\n" + page_markdown
                    
                if img_path and os.path.exists(img_path):
                    os.remove(img_path)
            
            return page_id, page_hash, page_markdown
            
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
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
