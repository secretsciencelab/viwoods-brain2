import os
import datetime
import re
from google import genai
from google.genai import types

PROMPT = "Transcribe the handwritten notes in this document into clean, structured Markdown. If the user explicitly wrote tags (e.g., `#idea #design`) inline within sentences or paragraphs, or as standalone lines next to sections, you MUST preserve them exactly where they are written. DO NOT move them to the top of the output. If there are no tags anywhere on the page, extract or infer one or more from the subject matter and place them at the very top of the output. CRITICAL RULES: 1. DO NOT INVENT TITLES OR HEADINGS. IF THERE IS NO EXPLICIT HEADER WRITTEN IN THE HANDWRITING, YOU MUST NOT ADD ANY `#` HEADING AT ALL. Only format a Markdown H1 heading (e.g., `# Title`) if you see text that is explicitly underlined or explicitly styled as a large title in the handwriting. Otherwise, just transcribe it as normal text. 2. NEVER insert a space between the '#' symbol and the tag word (e.g. use `#tagname` NOT `# tagname`). Headers MUST have a space (e.g. `# Header Name`). Pay incredibly close attention to words starting with `#` in the handwriting (e.g. `#maxim`, `#todo`), and ALWAYS transcribe them exactly as hashtags, never mistaking them for headers. 3. If you see a hand-drawn empty square box next to a sentence, format it as a Markdown checkbox `- [ ]` (or `- [x]` if checked). 4. If you see a vertical line or bracket in the margin grouping multiple paragraphs together, wrap all those paragraphs in a Markdown blockquote (prefix lines with `> `) and include any hashtag written next to the bracket inside the block. 5. If you see a drawn horizontal line across the page, format it exactly as a Markdown horizontal rule (`---`) to act as a section break. 6. If you see any hand-drawn diagram, sketch, or doodle, write a highly detailed visual description enclosed in brackets: `[Drawing: A detailed description of what the sketch depicts]`. Do not generate SVGs."

def fix_hallucinated_tags(text):
    """Post-processes Gemini output to fix cases where it mistakenly added a space between '#' and tag words (e.g. '# AnimalSketch')."""
    lines = text.split('\n')
    for i, line in enumerate(lines):
        if line.startswith('# '):
            content = line[2:].strip()
            if not content: continue
            
            words = re.split(r'[\s,]+', content)
            is_tag_line = True
            has_tag_case = False
            
            for w in words:
                if not re.match(r'^[a-zA-Z0-9_/-]+$', w):
                    is_tag_line = False
                    break
                # If a word is CamelCase (contains an uppercase letter after the first character) or all lowercase, it's a tag signature.
                # Normal titles are usually ALL CAPS or Title Case (e.g. "Sketches") which won't trigger this.
                if re.search(r'[a-z]', w) and re.search(r'[A-Z]', w[1:]):
                    has_tag_case = True
                if w == w.lower() and re.search(r'[a-z]', w):
                    has_tag_case = True
                    
            if is_tag_line and has_tag_case:
                lines[i] = ' '.join(['#' + w for w in words])
                continue
                
        # Fix inline CamelCase tags that were given a space (e.g. "here is a # AnimalSketch")
        lines[i] = re.sub(r'#\s+([a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*)', r'#\1', lines[i])
        
    return '\n'.join(lines)

def run_gemini_ocr(valid_image_bytes, page_id, last_modified_time=None, is_daily=False):
    if not valid_image_bytes:
        print(f"Page {page_id} is completely blank. Skipping Gemini OCR.")
        return ""
    if is_daily:
        print(f"Page {page_id} is a Daily note. Skipping Gemini OCR as requested.")
        return ""

    api_key = os.environ.get("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key)
    
    try:
        contents = [types.Part.from_bytes(data=b, mime_type="image/png") for b in valid_image_bytes]
        contents.append(PROMPT)
        
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents
        )
        if response.text:
            if last_modified_time:
                dt = datetime.datetime.fromtimestamp(last_modified_time / 1000.0)
                timestamp = dt.strftime("%B %d, %Y at %I:%M %p")
            else:
                timestamp = datetime.datetime.now().strftime("%B %d, %Y at %I:%M %p")
                
            processed_text = fix_hallucinated_tags(response.text.strip())
            return f"> *Last updated: {timestamp}*\n\n" + processed_text
        else:
            return "[No text generated or response blocked by safety filters]"
    except Exception as e:
        print(f"Gemini API Error for page {page_id}: {e}")
        raise e
