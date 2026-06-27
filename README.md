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
1. Create a [Google Cloud Project](https://console.cloud.google.com/).
2. Enable the **Google Drive API** in your project.
3. Generate an OAuth Client ID (Desktop App) to authenticate your personal Google Drive account. You will need to export the resulting `token.json` file. (This bypasses strict storage quota limits placed on standard Service Accounts).

### Step 2: Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/) and generate a free API Key.
2. *(Note: The free tier currently allows 20 requests per day for Gemini 2.5. If you process more than 20 notebooks a day, enable "Pay-As-You-Go" billing on your Google Cloud project).*

### Step 3: Deploying to Cloud Run
1. Fork this repository to your own GitHub account.
2. In Google Cloud, navigate to **Cloud Run** and click **Deploy Container > Continuously deploy from a repository**.
3. Point it to your forked repository.
4. Set the Build Configuration:
   - **Build type:** Buildpacks
   - **Context directory:** `/cloud_function`
5. Under **Variables & Secrets**, add the following Environment Variables:
   - `GEMINI_API_KEY`: Your key from Step 2.
   - `DRIVE_TOKEN_JSON`: Paste the entire raw JSON string from your `token.json` file (from Step 1).
   - `DRIVE_FOLDERS` (Optional): A comma-separated list of folder names to scan. Defaults to `Viwoods-Note`.
6. Click **Deploy**.

### Step 4: Cloud Scheduler
1. Go to **Cloud Scheduler** in Google Cloud.
2. Create a new job targeting the HTTP URL of your newly deployed Cloud Run service.
3. **CRITICAL:** Under the "Configure the job's execution" > "Retry config" section, set the **Attempt deadline** to `30m` (30 minutes). The default is 3 minutes, which will cause a `DEADLINE_EXCEEDED` error if you process many handwriting files at once!
4. Set the frequency using Cron syntax (e.g., `0 2 * * *` to run at 2 AM every night).

## 🛠 Useful Commands

Tail the live logs for the Cloud Run function to debug any issues:
```bash
gcloud beta run services logs tail secondbrain-gdrive --region us-central1 --project YOUR_PROJECT_ID
```

## 🌐 Web Application

This repository includes a front-end **Web Application** (`/webapp`) hosted on GitHub Pages that provides a beautiful, native-like interface to view and read your processed Markdown files directly from your browser.

### Features
- **Interactive Dashboard:** Start your day with a customizable widget dashboard.
- **Weather Commute Widget:** A live weather widget using Chart.js to visualize temperature and rain probability for the next 24 hours, leveraging Open-Meteo's free geocoding and forecasting API (supports zip codes or browser geolocation).
- **Direct Google Drive Integration:** Connects securely to your Google Drive to load the transcribed `.md` files dynamically.
- **Auto-Sync:** Silently polls Google Drive every 60 seconds in the background to hot-swap content without disrupting your reading or closing expanded folders.
- **Persistent Sessions:** Your Google Drive token is securely cached in your browser's local storage so you don't have to log in on every page refresh.
- **Image Support:** Seamlessly loads embedded drawings and blank pages exported by the sync script, fully supporting dark/light mode via transparency rendering.
- **Tree Navigation:** Explore your Viwoods folder hierarchy easily via a collapsible file tree.
- **GitHub Pages Deployment:** Automatically deployed and hosted via the included `.github/workflows/webapp.yaml` configuration.

To use the web app, simply visit the hosted version here:
**👉 [https://secretsciencelab.github.io/viwoods-brain2/](https://secretsciencelab.github.io/viwoods-brain2/)**

Because the app is fully client-side and only connects directly to Google Drive via your browser, anyone can safely use this hosted URL by just plugging in their own Google Drive Client ID! You do not need to host your own copy.

### ⚠️ Handling the "Google hasn't verified this app" Warning
When setting up your OAuth Consent Screen, you must add the `https://www.googleapis.com/auth/tasks.readonly` scope (along with `drive.readonly`). Because these are classified as "Restricted" or "Sensitive" scopes, you will encounter a scary **"Google hasn't verified this app"** screen when logging in.

Since this is an open-source project where everyone brings their own Client ID, there are two ways to handle this:

**1. Personal Use (Recommended)**
If you are the only one using the dashboard, you do *not* need to get your app verified by Google.
* Keep your OAuth Consent Screen "Publishing status" set to **Testing**.
* Add your own `@gmail.com` email address to the **Test users** list.
* When you log in and see the warning, simply click **Advanced -> Go to [Your App Name] (unsafe)**. Since you own the cloud project, bypassing it is 100% secure. *(Note: "Testing" mode usually expires refresh tokens after 7 days, but since this web app fetches a fresh client-side token each session, you will not be affected).*

**2. Public Use (Not Recommended)**
If you are hosting a public instance of this web app for hundreds of other people to use, you *must* remove that warning. To do that, you have to set your app to **In production** and submit it for formal Google Trust & Safety Verification (requiring a domain, privacy policy, and a YouTube demo video explaining why you need the scopes).