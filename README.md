<div align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="webapp/wireframe_brain_light.png">
    <source media="(prefers-color-scheme: dark)" srcset="webapp/wireframe_brain.png">
    <img src="webapp/wireframe_brain.png" width="120" alt="brain2 logo">
  </picture>
  <h1>brain2</h1>
  <p><b>Viwoods Second Brain Sync</b></p>
</div>

A completely serverless, automated pipeline that turns your Viwoods e-ink tablet into a smart, searchable Second Brain.

This tool automatically detects new handwritten Viwoods .note files in your Google Drive, uses the **Gemini 2.5 Pro** model to transcribe your handwriting into formatted Markdown, and syncs the text back to Google Drive. It compiles "Master" Markdown files formatted for ingestion into **Google NotebookLM** or **Obsidian**.

## ✨ Features

- **Handwriting OCR:** Uses Gemini 2.5 Pro to transcribe messy handwriting.
- **Visual Syntax Recognition:** Draw specific shapes and syntax on your tablet to trigger powerful Markdown formatting:
  - **Checklists & Tasks:** Draw an empty square (`[ ]`) or box at the start of a sentence to create a Markdown Checkbox (`- [ ]`). *Note: The cloud function automatically scans every single note and compiles all open/unchecked items into a centralized `TODO_Master.md` file!*
  - **Headings & Titles:** Underlined titles at the top of the page or in a new section in the text automatically become headings in the Markdown (`#`).
  - **Tagging:** Add `#hashtags` (e.g., `#idea`, `#important`) to sections of a page to dynamically tag and link them within the Knowledge Graph.
  - **Blockquotes:** Draw a vertical line `|` or bracket `[` in the left margin next to a paragraph to create a Markdown Blockquote (`>`).
  - **Dividers:** Draw a horizontal line completely across the page to create a section break (`---`).
- **Folder Aware & Master Compiling:** Automatically categorizes your notes into `All_Notes_Master.md` and `Work_Master.md` based on their subdirectories, allowing you to easily separate contexts in NotebookLM.
- **Smart Syncing:** Compares timestamps. It only processes Viwoods .note files that are new or have been recently modified, aggressively saving API quota.
- **Serverless:** Runs entirely on Google Cloud Functions for free.

## 📝 Note-Taking System

This repository is designed around a specific organizational workflow on the Viwoods e-ink tablet:

- **Folders (Contexts):** Used to separate completely different lives (e.g., `Personal` vs `Work`).
- **Notebooks (Topics):** Used to separate specific topics within a context (e.g., `Notes`, `Sketches`, `To-do`, `Fitness`). Notebooks are created for each calendar year and retired at the end of the year.
- **Hashtags (Linking):** Inside each notebook, hashtags are written directly in the handwriting to link content to specific tags. For example, a `Fitness` notebook might contain `#running`, `#mtb`, and `#climbing` log entries.

Using a combination of AI (Gemini OCR), cloud processing, and the powerful web app included in this repository, this raw handwriting is dynamically parsed and synthesized to generate a rich Knowledge Graph mapping all of your Folders, Notebooks, Notes, Pages, and Tags together.

## 🏗 Architecture

1. **E-Ink Tablet:** Syncs raw handwritten `.note` files to a specific Google Drive folder (e.g., `Viwoods-Note`).
2. **Google Cloud Scheduler:** Wakes up the Cloud Run Function on a daily or hourly schedule.
3. **Cloud Run Function:** Scans the Drive folder and downloads new/modified Viwoods .note files.
4. **Gemini API:** Reads the Viwoods .note files and converts the handwriting to structured Markdown (`.md`).
5. **Google Drive:** The Cloud Function uploads the individual `.md` files back to their original subfolders and updates the combined Master files in the root folder.
6. **NotebookLM / Obsidian:** Connects directly to the Master Markdown files for your final Knowledge Graph and AI search.

## 🚀 Setup Guide

### Step 1: Google Cloud & Drive Setup
1. Create a [Google Cloud Project](https://console.cloud.google.com/) and enable the **Google Drive API**.
2. Create an **OAuth Client ID** (Desktop App type) and download the JSON file as `credentials.json` into this folder.
3. Run `python utils/generate_token.py` locally. This will open a browser to log in and automatically generate your required `token.json` file!

### Step 2: Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/) and generate a free API Key.

### Step 3: Deploying to Cloud Run
1. Fork this repository to your own GitHub account.
2. In Google Cloud, go to **Cloud Run** and click **Deploy Container > Continuously deploy from a repository**.
3. Point it to your forked repository and set:
   - **Build type:** Buildpacks
   - **Context directory:** `/cloud_function`
4. Under **Variables & Secrets**, add the following Environment Variables:
   - `GEMINI_API_KEY`: Your key from Step 2.
   - `DRIVE_TOKEN_JSON`: Paste the entire contents of your generated `token.json` file.
   - `DRIVE_FOLDERS` (Optional): E.g., `Viwoods-Note`.

### Step 4: Cloud Scheduler
1. Go to **Cloud Scheduler** in Google Cloud and create a new HTTP job targeting your Cloud Run URL.
2. **CRITICAL:** Under Retry config, set the **Attempt deadline** to `30m` (30 minutes) to prevent timeouts when processing many files.
3. Set your cron schedule (e.g., `0 2 * * *` for nightly).

## 🛠 Useful Commands

Tail the live logs for the Cloud Run function to debug any issues:
```bash
gcloud beta run services logs tail secondbrain-gdrive --region us-central1 --project YOUR_PROJECT_ID
```

## 🌐 Web Application

This repository includes a front-end **Web Application** (`/webapp`) that can be easily hosted on GitHub Pages. It provides a beautiful, native-like interface to view and read your processed Markdown files directly from your browser.

### Features
- **Interactive Dashboard:** Start your day with a customizable widget dashboard.
- **Weather Commute Widget:** A live weather widget using Chart.js to visualize temperature and rain probability for the next 24 hours, leveraging Open-Meteo's free geocoding and forecasting API (supports zip codes or browser geolocation).
- **Direct Google Drive Integration:** Connects securely to your Google Drive to load the transcribed `.md` files dynamically.
- **Auto-Sync:** Silently polls Google Drive every 60 seconds in the background to hot-swap content without disrupting your reading or closing expanded folders.
- **Persistent Sessions:** Your Google Drive token is securely cached in your browser's local storage so you don't have to log in on every page refresh.
- **Image Support:** Seamlessly loads embedded drawings and blank pages exported by the sync script, fully supporting dark/light mode via transparency rendering.
- **Tree Navigation:** Explore your Viwoods folder hierarchy easily via a collapsible file tree.

### Hosting on GitHub Pages
To use the web app, simply fork this repository to your own GitHub account. Once forked, the included `.github/workflows/webapp.yaml` configuration will automatically deploy and host your very own copy of the web app via GitHub Pages! 

You can then visit your newly hosted dashboard URL (e.g., `https://<your-username>.github.io/<your-repo-name>/`) and plug in your Google Drive Client ID to safely connect it to your Google account.

### ⚠️ Handling the "Google hasn't verified this app" Warning
When setting up your OAuth Consent Screen, you must add the `https://www.googleapis.com/auth/tasks.readonly` scope (along with `drive.readonly`). Because these are classified as "Restricted" or "Sensitive" scopes, you will encounter a scary **"Google hasn't verified this app"** screen when logging in.

Since this is an open-source project where everyone brings their own Client ID, there are two ways to handle this:

**1. Personal Use (Recommended)**
If you are the only one using the dashboard and backend, you do *not* need to get your app verified by Google.
* In the Google Cloud Console, navigate to **Google Auth Platform -> Audience**.
* Set your "Publishing status" to **In production** (or click **Publish App**).
* When you log in and see the "unverified" warning, simply click **Advanced -> Go to [Your App Name] (unsafe)**. Since you own the cloud project, bypassing it is 100% secure. *(Note: Setting the app to "In production" is critical; if you leave it in "Testing", Google will automatically expire your backend Cloud Run refresh token every 7 days! Unverified production apps have a 100-user limit, which is perfect for personal use).*

**2. Public Use (Not Recommended)**
If you are hosting a public instance of this web app for hundreds of other people to use, you *must* remove that warning. To do that, you have to keep your app **In production** and submit it for formal Google Trust & Safety Verification (requiring a domain, privacy policy, and a YouTube demo video explaining why you need the scopes).