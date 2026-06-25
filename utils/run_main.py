import sys
import os

sys.path.append(os.path.join(os.path.dirname(__file__), 'cloud_function'))
import main

class DummyRequest:
    def get_json(self, silent=True):
        return None

from dotenv import load_dotenv
load_dotenv()

if __name__ == '__main__':
    result = main.sync_drive_notes(DummyRequest())
    print(result)
