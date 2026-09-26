import os
import subprocess
import datetime
from google import genai
from google.genai import types

def get_git_files(since_time):
    """Finds markdown and text files modified since a given time using git history."""
    try:
        result = subprocess.run(
            ['git', 'log', f'--since="{since_time}"', '--name-only', '--pretty=format:', '--diff-filter=d'],
            capture_output=True, text=True, check=True
        )
        files = set(filter(None, result.stdout.split('\n')))
        # Only process md/txt files, ignore ai_feedback directory to avoid looping old feedback
        valid_files = {f for f in files if f.endswith(('.md', '.txt')) and not f.startswith('ai_feedback') and os.path.exists(f)}
        return valid_files
    except Exception as e:
        print(f"Error fetching git history for {since_time}: {e}")
        return set()

def read_files_content(file_set):
    """Reads and concatenates the content of a set of files."""
    content = ""
    for file_path in sorted(list(file_set)):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content += f"\n\n--- File: {file_path} ---\n{f.read()}"
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
    return content

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Error: GEMINI_API_KEY environment variable not set. Please set it in GitHub Secrets.")
        return

    client = genai.Client(api_key=api_key)
    
    # Get files for the two timeframes
    thirty_day_files = get_git_files("30 days ago")
    today_files = get_git_files("24 hours ago")
    
    # If there are no new notes today, exit to save API calls and avoid redundant summaries
    if not today_files:
        print("No new notes found in the last 24 hours. Exiting.")
        return

    # Historical files are everything in the 30-day window that wasn't modified today
    historical_files = thirty_day_files - today_files

    print(f"Found {len(today_files)} files from today, and {len(historical_files)} files from the prior 30 days.")
    
    history_content = read_files_content(historical_files)
    today_content = read_files_content(today_files)

    # Construct the context prompt with explicit separation
    notes_content = f"""
    <Historical_Context>
    {history_content if history_content else "No historical notes available."}
    </Historical_Context>
    
    <Todays_Notes>
    {today_content}
    </Todays_Notes>
    """

    system_instruction = """
    You are an incredibly insightful AI acting as a personal assistant, personal trainer, therapist, mentor, and friend. 
    You are provided with a sliding window of the user's raw notes:
    1. <Historical_Context>: Raw notes from the past 30 days.
    2. <Todays_Notes>: The raw notes from the last 24 hours.

    Your core task is to analyze the historical data to find hidden patterns, behavioral trends, and emotional baselines over time. Provide structured daily feedback specifically focused on how today's entry connects to that broader picture, maintaining a deeply supportive, challenging, and caring tone.

    Provide a structured daily summary formatted in clean Markdown, including:
    1. **Macro Trends & Patterns (Therapist & Mentor):** Highlight any major patterns in the 30-day historical data (e.g., recurring emotional themes in the journal, habits forming or breaking, behavioral loops) and how today fits into them. Provide gentle, insightful guidance.
    2. **Daily Themes (Friend):** A summary of today's thoughts, mood, or reflections, contextualized against the history. Offer a supportive, encouraging perspective.
    3. **Fitness & Recovery (Personal Trainer):** Observations on today's workouts. Compare today's volume, intensity, and recovery to the historical baseline. Provide expert advice and suggest adjustments for the next session.
    4. **Language & Learning (Mentor):** Corrections for today's language notes. Note if they are repeating mistakes seen in the historical context or successfully utilizing past corrections.
    5. **Creative/Drawing (Mentor):** Constructive, encouraging feedback based on today's creative notes and how they show progression from past sketches.
    6. **To-Do Audit (Personal Assistant):** Scan all notes for open tasks (formatted as `- [ ]`). Consolidate a list of active tasks, and explicitly flag any to-dos that have been open for multiple days/weeks. Actively help manage their workload by suggesting if stagnant tasks should be broken down, reprioritized, or abandoned.
    7. **Suggestions & Discoveries:** Based on the topics, struggles, or interests mentioned in the notes, proactively recommend 1-2 interesting resources or ideas (e.g., a relevant book, podcast, stretching routine, art technique, or mental framework) that would genuinely inspire or help them right now.
    8. **Actionable Takeaways:** 2-3 specific, highly tailored bullet points for tomorrow based on the combination of today's actions and historical trends.

    If a specific category has no notes for today, you can omit that section or briefly mention it wasn't logged today. Do not invent information.
    """

    print("Sending data to Gemini for analysis (this may take a moment with historical data)...")
    response = client.models.generate_content(
        model='gemini-2.5-pro',
        contents=notes_content,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.4,
        )
    )

    # Ensure the output directory exists
    feedback_dir = "ai_feedback"
    os.makedirs(feedback_dir, exist_ok=True)
    
    today_str = datetime.datetime.now().strftime("%Y-%m-%d")
    output_file = os.path.join(feedback_dir, f"Daily_Insights_{today_str}.md")
    
    # Save the feedback
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(response.text)
        
    print(f"Successfully wrote daily feedback to {output_file}")

if __name__ == "__main__":
    main()
