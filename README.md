# 🧠 E-Ink Second Brain Sync

A completely serverless, automated pipeline that turns your e-ink tablet (Viwoods, Boox, reMarkable, Supernote, etc.) into a smart, searchable Second Brain.

This tool automatically detects new handwritten PDFs in your Google Drive, uses Google's powerful **Gemini 2.5 Pro** model to flawlessly transcribe your handwriting into formatted Markdown, and syncs the text back to Google Drive. It even compiles "Master" Markdown files perfectly formatted for ingestion into **Google NotebookLM** or **Obsidian**.

## ✨ Features

- **Flawless Handwriting OCR:** Uses Gemini 2.5 Pro to transcribe messy handwriting with near-perfect accuracy.
- **Visual Syntax Recognition:** Draw specific shapes on your tablet to trigger Markdown formatting:
  - Draw an empty square `[ ]` to create a Markdown Checkbox (`- [ ]`).
  - Draw a vertical line `|` or bracket `[` in the margin to create a Markdown Blockquote (`>`).
  - Draw a horizontal line across the page to create a section break (`---`).
- **Folder Aware & Master Compiling:** Automatically categorizes your notes into `Scratch_Master.md` and `Work_Master.md` based on their subdirectories, allowing you to easily separate contexts in NotebookLM.
- **Smart Syncing:** Compares timestamps. It only processes PDFs that are new or have been recently modified, aggressively saving API quota.
- **Serverless:** Runs entirely on Google Cloud Functions for free.

## 🏗 Architecture

1. **E-Ink Tablet:** Syncs raw handwritten `.pdf` files to a specific Google Drive folder (e.g., `Viwoods-PDF`).
2. **Google Cloud Scheduler:** Wakes up the Cloud Run Function on a daily or hourly schedule.
3. **Cloud Run Function:** Scans the Drive folder and downloads new/modified PDFs.
4. **Gemini API:** Reads the PDFs and converts the handwriting to structured Markdown (`.md`).
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
6. Click **Deploy**.

### Step 4: Cloud Scheduler
1. Go to **Cloud Scheduler** in Google Cloud.
2. Create a new job targeting the HTTP URL of your newly deployed Cloud Run service.
3. Set the frequency using Cron syntax (e.g., `0 2 * * *` to run at 2 AM every night).

## 🛠 Useful Commands

Tail the live logs for the Cloud Run function to debug any issues:
```bash
gcloud beta run services logs tail secondbrain-gdrive --region us-central1 --project YOUR_PROJECT_ID
```