import zipfile
import json
import os

def analyze():
    # Find the downloaded .note file
    note_files = [f for f in os.listdir('.') if f.endswith('.note')]
    if not note_files:
        print("No .note files found.")
        return
        
    target = note_files[0]
    print(f"Extracting {target}...")
    
    with zipfile.ZipFile(target, 'r') as z:
        z.extractall("viwoods_extracted")
        print("Files in archive:", z.namelist())
        
        for name in z.namelist():
            if name.endswith('.json'):
                print(f"\n--- {name} ---")
                try:
                    with z.open(name) as f:
                        data = json.load(f)
                        # Print first level keys or a snippet if too large
                        if isinstance(data, dict):
                            print("Keys:", list(data.keys()))
                            # If there's stroke data, maybe show length
                            for k, v in data.items():
                                if isinstance(v, list):
                                    print(f" {k}: list of {len(v)} items")
                        else:
                            print("Type:", type(data))
                            
                        # Dump a bit of the JSON to see structure
                        snippet = json.dumps(data, indent=2)[:500]
                        print("Snippet:\n", snippet)
                except Exception as e:
                    print(f"Could not parse {name} as JSON:", e)

if __name__ == '__main__':
    analyze()
