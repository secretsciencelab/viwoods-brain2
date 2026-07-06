import os
import datetime
from google import genai
from google.genai import types

PROMPT = "Transcribe the handwritten notes in this document into clean, structured Markdown. If the user explicitly wrote tags (e.g., `#idea #design`) inline within sentences or paragraphs, or as standalone lines next to sections, you MUST preserve them exactly where they are written. DO NOT move them to the top of the output. If there are no tags anywhere on the page, extract or infer one or more from the subject matter and place them at the very top of the output. CRITICAL RULES: 1. DO NOT INVENT TITLES OR HEADINGS. IF THERE IS NO EXPLICIT HEADER WRITTEN IN THE HANDWRITING, YOU MUST NOT ADD ANY `#` HEADING AT ALL. Only format a Markdown H1 heading (e.g., `# Title`) if you see text that is explicitly underlined or explicitly styled as a large title in the handwriting. Otherwise, just transcribe it as normal text. 2. NEVER insert a space between the '#' symbol and the tag word (e.g. use `#tagname` NOT `# tagname`). Headers MUST have a space (e.g. `# Header Name`). Pay incredibly close attention to words starting with `#` in the handwriting (e.g. `#maxim`, `#todo`), and ALWAYS transcribe them exactly as hashtags, never mistaking them for headers. 3. If you see a hand-drawn empty square box next to a sentence, format it as a Markdown checkbox `- [ ]` (or `- [x]` if checked). 4. If you see a vertical line or bracket in the margin grouping multiple paragraphs together, wrap all those paragraphs in a Markdown blockquote (prefix lines with `> `) and include any hashtag written next to the bracket inside the block. 5. If you see a drawn horizontal line across the page, format it exactly as a Markdown horizontal rule (`---`) to act as a section break. 6. If you see any hand-drawn diagram, sketch, or doodle, write a highly detailed visual description enclosed in brackets: `[Drawing: A detailed description of what the sketch depicts]`. Do not generate SVGs."

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
            return f"> *Last updated: {timestamp}*\n\n" + response.text.strip()
        else:
            return "[No text generated or response blocked by safety filters]"
    except Exception as e:
        print(f"Gemini API Error for page {page_id}: {e}")
        raise e
