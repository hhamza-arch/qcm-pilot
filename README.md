# QCM Pilot

A Chrome extension (Manifest V3) plus a small local Python backend that helps you **review Google Forms multiple-choice questions** with AI, for practice and assessments **where AI assistance is explicitly permitted**.

It detects the questions on a form, lets you fix them if needed, asks an AI model, and shows the suggested answer, the exact choice, an explanation, a confidence level and any warnings.

> **QCM Pilot never submits a form and never presses Next.** The only thing it can click is the answer choices, and only when *you* press **⚡ Practice Auto-Fill**. You always review the page and submit it yourself.

```
Google Form ──(read-only)──▶ extension popup ──▶ http://127.0.0.1:8000 (FastAPI) ──▶ Gemini / OpenAI
                                                      ▲
                                                 API key stays in backend/.env
```

## Contents

1. [Features](#features)
2. [Project structure](#project-structure)
3. [Installation on Ubuntu](#installation-on-ubuntu)
4. [Test with Google Forms](#test-with-google-forms)
5. [⚡ Practice Auto-Fill (one click)](#-practice-auto-fill-one-click)
6. [Put it online](#put-it-online)
7. [Using OpenAI instead of Gemini](#using-openai-instead-of-gemini)
8. [Running the tests](#running-the-tests)
9. [Security and privacy](#security-and-privacy)
10. [Troubleshooting](#troubleshooting)

## Features

- **⚡ Practice Auto-Fill:** one click scans the form, asks the AI about every question in a single request, and ticks the suggested answers on the page. It never submits.
- Scans the current Google Form and extracts every multiple-choice question (radio buttons, checkboxes, and dropdowns on a best-effort basis).
- Dark popup with: logo, **Scan Questions**, question selector, question editor, answer-choices editor, **Analyze**, loading indicator and AI response panel.
- Manual mode: add or fix a question and its choices yourself when detection fails.
- Result panel: suggested answer (e.g. `Option B`), exact choice text, explanation, confidence (High/Medium/Low) and warnings about ambiguity. The suggested choice is also highlighted in the editor.
- Backend: `GET /health`, `POST /analyze`, input validation, structured JSON output, retries with backoff for temporary errors, safe error messages.
- Two AI providers behind one setting: **Gemini free tier** (default) or the **OpenAI Responses API** (`store: false`).

## Project structure

```
qcm-pilot/
├── backend/
│   ├── main.py             FastAPI app (endpoints, validation, AI calls, retries)
│   ├── Dockerfile          For online hosting
│   ├── test_main.py        Backend tests (no real API calls)
│   ├── requirements.txt
│   ├── .env.example        Copy to .env and add your key
│   └── README.md           Backend-only notes
├── extension/
│   ├── manifest.json       Manifest V3
│   ├── content.js          Read-only question detection on Google Forms
│   ├── popup.html          Popup layout
│   ├── popup.css           Dark theme
│   └── popup.js            Popup logic and backend calls
├── render.yaml             One-click deploy blueprint for Render
├── README.md
└── .gitignore
```

## Installation on Ubuntu

These steps were written for Ubuntu 22.04/24.04 and need no prior Python experience. Lines starting with `#` are comments, so you do not type them.

### 1. Install Python and tools

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip unzip curl
python3 --version        # should print Python 3.9 or newer
```

- `python3-venv` lets you create an isolated environment so the project's packages do not mix with the system's.

### 2. Unzip the project

```bash
cd ~
unzip qcm-pilot.zip
cd qcm-pilot/backend
```

### 3. Create a virtual environment and install dependencies

```bash
python3 -m venv .venv            # creates the folder backend/.venv
source .venv/bin/activate        # your prompt now starts with (.venv)
pip install --upgrade pip
pip install -r requirements.txt
```

You must run `source .venv/bin/activate` again in every new terminal before starting the server.

### 4. Configure your API key

Get a **free Gemini key** at <https://aistudio.google.com/apikey> (sign in, press *Create API key*). Then:

```bash
cp .env.example .env
nano .env
```

Fill in the line `GEMINI_API_KEY=` with your key, for example `GEMINI_API_KEY=AIza...`. Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

The key lives only in `backend/.env`. It is never put in the extension, and `.gitignore` keeps `.env` out of Git.

### 5. Start the backend

```bash
python main.py
```

You should see `Uvicorn running on http://127.0.0.1:8000`. Leave this terminal open. (Alternative: `uvicorn main:app --host 127.0.0.1 --port 8000`.)

In a **second terminal**, check it:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","provider":"gemini","model":"gemini-2.5-flash","configured":true}
```

If `configured` is `false`, the key is missing from `.env`. Fix it and restart the server.

Optional end-to-end check of the AI call:

```bash
curl -s http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the capital of France?","options":["Berlin","Paris","Madrid"],"multiple":false}'
```

You should get JSON containing `"answer":"Option B"`, an explanation, a confidence level and `caution`.

### 6. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked**.
4. Select the folder `qcm-pilot/extension` (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and **pin** QCM Pilot.

(The extension ships without icon image files, so Chrome shows a default letter icon; the logo inside the popup is built in.)

## Test with Google Forms

1. Go to <https://forms.google.com> and create a short practice form with a few **multiple choice** and **checkboxes** questions. Press the eye icon (**Preview**) to open the fill-in view (the URL ends with `/viewform`).
2. Make sure the backend is running. Open the QCM Pilot popup: the badge at the top-right should show the model name in green.
3. Press **Scan Questions**. The questions appear in the selector. Choosing one scrolls to it on the page and briefly outlines it.
4. Check or edit the question text and the choices, then press **Analyze**.
5. Read the suggested answer, the exact choice, the explanation, the confidence level and any warning. The suggested choice is highlighted in the editor.
6. Select your answer **on the form yourself**. QCM Pilot never does it for you.

Tips:

- Forms with several pages only show one page at a time. Go to the next page and scan again.
- If a question is not detected (images, grids, unusual layouts), press **+ Manual** and type it.
- Your edits are kept while the browser session lasts, even if you close the popup.

## ⚡ Practice Auto-Fill (one click)

1. Start the backend and open a Google Form on its `/viewform` page.
2. Open QCM Pilot. At the top, tick **"I confirm AI assistance is allowed for this form"** (remembered afterwards).
3. Press **⚡ Practice Auto-Fill**.

It scans the page, sends all questions to the AI in one request (batches of 10), then ticks the suggested choices: radio buttons, checkboxes (it also unticks wrong ones) and dropdowns (best effort). A summary tells you how many were filled.

- **Leave low-confidence questions blank** (on by default) skips answers the AI is unsure about so you can decide them yourself.
- Forms with several pages: run it on each page. It never presses Next or Submit.
- Text-answer, grid and file-upload questions are ignored.
- **Always review the page** before you submit. The AI can be wrong.
- Use it only for practice or where AI help is allowed.

## Put it online

By default everything runs on your computer. To use it from any computer without starting Python, host the **backend** online and point the extension to it. There are two separate things to publish:

| Part | Where | Needed for |
|---|---|---|
| Backend (`backend/`) | A web host (Render, free) | The AI calls and your API key |
| Extension (`extension/`) | Chrome (unpacked, or the Chrome Web Store) | The popup and the Auto-Fill button |

### Step 1: Host the backend on Render (free)

1. Create a GitHub account and a **private** repository, then upload the whole `qcm-pilot` folder to it (`.env` is ignored by `.gitignore`, so your key is not uploaded).
2. Create a free account at <https://render.com>, then **New → Blueprint** and choose your repository. Render reads `render.yaml` and builds `backend/Dockerfile`.
3. When asked, paste your `GEMINI_API_KEY`. Render generates the `ACCESS_TOKEN` for you.
4. After the deploy, open the service: copy its URL (like `https://qcm-pilot-api.onrender.com`) and, under **Environment**, copy the `ACCESS_TOKEN` value.
5. Check it: open `https://YOUR-URL/health` in a browser. You should see `"configured":true`.

Notes: Render's free plan puts the service to sleep after about 15 minutes without traffic; the first request afterwards takes up to a minute. Other hosts work the same way with the Dockerfile (Railway, Fly.io, Google Cloud Run, Hugging Face Docker Space). Set these variables there: `GEMINI_API_KEY`, `ACCESS_TOKEN` (a long random string), and `HOST=0.0.0.0` (already set in the Dockerfile).

### Step 2: Point the extension to it

1. Open QCM Pilot → **Settings**.
2. Backend URL: `https://qcm-pilot-api.onrender.com` (your URL, no trailing slash).
3. Access token: the `ACCESS_TOKEN` from Render.
4. Press **Save** and accept Chrome's permission prompt for that one server. The badge turns green.

### Step 3 (optional): Publish the extension

- **Share with friends:** zip the `extension` folder. They use *Load unpacked* as in step 6 above, and enter the same backend URL and token.
- **Chrome Web Store:** go to <https://chrome.google.com/webstore/devconsole>, pay the one-time US$5 developer fee, upload the zipped `extension` folder (with `manifest.json` at the top level of the zip), add a description, screenshots, icons (128×128 px) and a **privacy policy** that says question text is sent to your server and an AI provider. Review takes from a few days to some weeks, and the listing must follow the store's policies.

### Important when it is online

- **Never run a public server without `ACCESS_TOKEN`.** Anyone who finds the URL could use up your AI quota.
- Everyone who has the token shares **your** Gemini free quota (a few requests per minute). For many users, give each person their own deployment and key.
- Question text now travels over the internet to your server (HTTPS) and then to the AI provider. Do not use it for confidential material.

## Using OpenAI instead of Gemini

Edit `backend/.env`:

```
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

Restart the backend. With this provider the backend calls the **OpenAI Responses API** with a strict JSON schema and `store=False`. With Gemini it uses Google's OpenAI-compatible endpoint through the same Python SDK, since that endpoint offers Chat Completions rather than the Responses API.

You can change the model at any time with `GEMINI_MODEL` or `OPENAI_MODEL`.

## Running the tests

```bash
cd ~/qcm-pilot/backend
source .venv/bin/activate
pip install httpx          # only needed for tests
python -m unittest -v
```

The 21 backend tests mock the AI provider, so they need no API key or internet connection. They cover validation, successful answers, multiple answers, retry logic, error mapping, missing key, CORS, the OpenAI call (including `store=False`), the batch endpoint and the access token.

## Security and privacy

- **You stay in control.** The extension ticks answer choices only after you press **⚡ Practice Auto-Fill** (and tick the confirmation box). It has no code that presses Next or Submit, and it does not type into text fields. The other change it makes is a temporary outline around the question you pick.
- **API key** only in `backend/.env`, never in JavaScript, and never returned by the API.
- **Local by default.** The server binds to `127.0.0.1`, and CORS only allows Chrome extension pages and localhost. The extension talks to the backend URL you set (localhost, or an `https://` server you approve in Chrome) and reads `docs.google.com/forms`.
- **Online mode.** `ACCESS_TOKEN` is checked on `/analyze` and `/analyze-batch` with a constant-time comparison. The token is stored in the extension's local storage, never in the code.
- **Validation** of every input (length limits, 2–12 non-empty choices) on both the extension and the backend.
- **No sensitive logging.** Logs contain only metadata (provider, number of choices, duration), never question text.
- **`store: false`** on OpenAI requests.
- **No Google account data** is collected. The extension reads question text and choices from the page and nothing else.
- **Prompt-injection hardening.** The prompt tells the model that page text is data, not instructions.
- **Provider privacy.** Question text is sent to the AI provider you choose. Google's Gemini **free tier** may use submitted content to improve its products, so do not send anything confidential. Check your provider's current terms.
- Only use QCM Pilot where AI help is allowed. Follow your school's or employer's rules.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid or missing access token` | Copy the exact `ACCESS_TOKEN` into the extension Settings and press Save. |
| Auto-Fill ticks nothing in a dropdown | Dropdowns are best effort; pick those by hand. |
| Online backend is slow the first time | Free hosts sleep when idle. Wait up to a minute and retry. |
| Badge says **Backend offline** | Start the server (`python main.py`) and check that it uses port 8000. If you changed `PORT`, update the URL in the popup's *Settings*. |
| Badge says **API key missing** | Add the key to `backend/.env` and restart the server. |
| `The AI provider rejected the API key` | The key is wrong or disabled. Create a new one and update `.env`. |
| `Rate limit or free quota reached` | The free tier has per-minute and daily limits. Wait and retry, or use a different model. |
| `Model '...' was not found` | Fix `GEMINI_MODEL` / `OPENAI_MODEL` in `.env`. |
| Scan finds nothing | Use the `/viewform` page, scroll so the questions load, reload the page, then scan again. Or use **+ Manual**. |
| `Scan failed` right after installing | Reload the Google Form tab once so Chrome loads the extension into it. |
| `externally-managed-environment` error from pip | You are outside the virtual environment. Run `source .venv/bin/activate` first. |
