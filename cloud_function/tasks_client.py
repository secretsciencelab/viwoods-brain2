import os
import re
from drive_client import get_tasks_service

def sync_todos_to_tasks(todo_path, task_list_name="ViWoods Notebooks"):
    service = get_tasks_service()
    
    # 1. Get or create the main Task List
    tasklists = service.tasklists().list().execute()
    items = tasklists.get('items', [])
    
    tasklist_id = None
    for lst in items:
        if lst['title'] == task_list_name:
            tasklist_id = lst['id']
            break
            
    if not tasklist_id:
        new_list = {'title': task_list_name}
        created_list = service.tasklists().insert(body=new_list).execute()
        tasklist_id = created_list['id']
        
    # 2. Read the master markdown file
    with open(todo_path, "r", encoding="utf-8") as f:
        content = f.read()
        
    # 3. Get all tasks currently in the list
    existing_tasks_resp = service.tasks().list(tasklist=tasklist_id, showHidden=True, maxResults=100).execute()
    existing_tasks = existing_tasks_resp.get('items', [])
    
    # Build quick lookup dictionaries
    existing_parents = {t['title']: t for t in existing_tasks if 'parent' not in t}
    
    existing_subtasks = {}
    for t in existing_tasks:
        if 'parent' in t:
            key = (t['parent'], t['title'])
            existing_subtasks[key] = t
            
    # 4. Parse markdown and sync
    lines = content.split('\n')
    current_parent_title = None
    current_parent_id = None
    
    for line in lines:
        header_match = re.match(r'^##\s+(.*)', line)
        if header_match:
            current_parent_title = header_match.group(1).strip()
            
            # Find or create parent task for the notebook
            if current_parent_title in existing_parents:
                current_parent_id = existing_parents[current_parent_title]['id']
            else:
                task = {'title': current_parent_title}
                created_task = service.tasks().insert(tasklist=tasklist_id, body=task).execute()
                existing_parents[current_parent_title] = created_task
                current_parent_id = created_task['id']
                
        elif current_parent_id:
            # Check for to-do items
            match = re.match(r'^\s*-\s+\[( |x)\]\s+(.*)', line)
            if match:
                is_completed = match.group(1).lower() == 'x'
                task_title = match.group(2).strip()
                
                key = (current_parent_id, task_title)
                
                if key in existing_subtasks:
                    # Update status if it changed
                    existing_task = existing_subtasks[key]
                    needs_update = False
                    
                    if is_completed and existing_task['status'] != 'completed':
                        existing_task['status'] = 'completed'
                        needs_update = True
                    elif not is_completed and existing_task['status'] == 'completed':
                        existing_task['status'] = 'needsAction'
                        existing_task['completed'] = None
                        needs_update = True
                        
                    if needs_update:
                        service.tasks().update(tasklist=tasklist_id, task=existing_task['id'], body=existing_task).execute()
                else:
                    # Create new subtask
                    task = {'title': task_title}
                    if is_completed:
                        task['status'] = 'completed'
                    created_task = service.tasks().insert(tasklist=tasklist_id, body=task, parent=current_parent_id).execute()
                    existing_subtasks[key] = created_task
