import os
from github import Github
from github.GithubException import UnknownObjectException

def push_to_github(file_path, local_file_path, commit_message="Auto-commit from Gemini OCR"):
    token = os.environ.get("GITHUB_TOKEN")
    repo_name = os.environ.get("GITHUB_REPO")
    
    if not token or not repo_name:
        print("GitHub integration not configured (missing GITHUB_TOKEN or GITHUB_REPO). Skipping.")
        return
        
    try:
        g = Github(token)
        repo = g.get_repo(repo_name)
        
        with open(local_file_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        # Clean up leading slash if any
        if file_path.startswith("/"):
            file_path = file_path[1:]
            
        try:
            contents = repo.get_contents(file_path)
            repo.update_file(contents.path, commit_message, content, contents.sha)
            print(f"Updated {file_path} in GitHub.")
        except UnknownObjectException:
            # File doesn't exist, create it
            repo.create_file(file_path, commit_message, content)
            print(f"Created {file_path} in GitHub.")
        except Exception as e:
            print(f"Failed to update/create {file_path} in GitHub: {e}")
    except Exception as e:
        print(f"GitHub client error: {e}")
