import re
import concurrent.futures
from drive_client import get_drive_service, download_file, upload_to_drive, get_files_in_folder
from github_client import push_to_github

def process_master_file(md):
    try:
        local_service = get_drive_service()
        local_md = download_file(local_service, md['id'], md['name'], dest_folder="/tmp/compile")
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

def compile_master_files(service, folder_id, target_folder_name):
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
        push_to_github(cat_data["filename"], master_path, commit_message=f"Auto-sync master file: {cat_data['filename']}")
        
    if todo_content != "# Master To-Do List\n\n":
        todo_path = "/tmp/TODO_Master.md"
        with open(todo_path, "w", encoding="utf-8") as f:
            f.write(todo_content)
            
        todo_search = [f for f in final_files if f["name"] == "TODO_Master.md"]
        todo_id = todo_search[0]["id"] if todo_search else None
        upload_to_drive(service, todo_path, folder_id, existing_file_id=todo_id)
        push_to_github("TODO_Master.md", todo_path, commit_message="Auto-sync master file: TODO_Master.md")
