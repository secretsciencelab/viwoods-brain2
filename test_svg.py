import json
import zipfile
import os

def examine_path():
    note_files = [f for f in os.listdir('.') if f.endswith('.note')]
    if not note_files:
        print("No .note files found.")
        return
        
    target = note_files[0]
    
    with zipfile.ZipFile(target, 'r') as z:
        path_files = [n for n in z.namelist() if n.startswith('PATH_') and n.endswith('.json')]
        for path_file in path_files:
            print(f"Examining {path_file}")
            with z.open(path_file) as f:
                data = json.load(f)
                print(f"Data type: {type(data)}")
                if isinstance(data, list):
                    print(f"Number of strokes: {len(data)}")
                    if len(data) > 0:
                        first_stroke = data[0]
                        print("First stroke keys:", list(first_stroke.keys()))
                        print("First stroke snippet:", json.dumps(first_stroke, indent=2)[:300])

if __name__ == '__main__':
    examine_path()
