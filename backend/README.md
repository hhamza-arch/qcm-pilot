# QCM Pilot backend

Local FastAPI server used by the QCM Pilot Chrome extension. See the [main README](../README.md) for the complete installation guide.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then put your API key in .env
python main.py              # http://127.0.0.1:8000
```

Interactive API docs: <http://127.0.0.1:8000/docs>

## Endpoints

### `GET /health`

```json
{"status": "ok", "provider": "gemini", "model": "gemini-2.5-flash", "configured": true}
```

`configured` tells you whether an API key is present (the key itself is never returned).

### `POST /analyze-batch`

Used by **Practice Auto-Fill**: 1–15 questions (same fields as `/analyze`) answered in one AI call.

```json
{"questions": [{"question": "...", "options": ["...", "..."], "multiple": false}]}
```

Response: `{"results": [{"index": 0, "result": {...same as /analyze...}, "error": ""}]}`. A question the AI could not answer has `result: null` and a readable `error`.

### `POST /analyze`

Request:

```json
{
  "question": "What is the capital of France?",
  "options": ["Berlin", "Paris", "Madrid"],
  "multiple": false
}
```

| Field | Rules |
|---|---|
| `question` | 3–4000 characters |
| `options` | 2–12 items, each 1–1000 characters, none blank |
| `multiple` | `true` when several answers may be correct (checkboxes) |

Response:

```json
{
  "answer": "Option B",
  "choice_text": "Paris",
  "answer_indexes": [2],
  "explanation": "Paris is the capital and largest city of France.",
  "confidence": "High",
  "caution": ""
}
```

`answer`, `explanation`, `confidence` and `caution` follow the specified format. `choice_text` and `answer_indexes` are extras used by the extension to show the exact choice.

Errors are returned as `{"detail": "readable message"}`:

| Status | Meaning |
|---|---|
| 401 | Missing or wrong access token |
| 422 | Invalid input (the submitted text is not echoed back) |
| 429 | Provider rate limit or free quota reached (after retries) |
| 502 | Provider rejected the key or request, was unreachable, or returned an unreadable answer |
| 503 | Server configuration problem, such as a missing API key |
| 504 | Provider timeout |

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `gemini` | `gemini` or `openai` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-2.5-flash` | Gemini settings |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4.1-mini` | OpenAI settings |
| `PORT` | `8000` | Local port |
| `ACCESS_TOKEN` | – | When set, `/analyze` and `/analyze-batch` require header `X-Access-Token`. **Set it whenever the server is online.** |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` when hosting (the Dockerfile does) |
| `ALLOWED_ORIGIN_REGEX` | extension + localhost | Advanced: override the CORS rule |
| `REQUEST_TIMEOUT` | `60` | Seconds per provider attempt |
| `MAX_RETRIES` | `2` | Extra attempts for temporary errors (0–5) |
| `LOG_LEVEL` | `INFO` | Question text is never logged at any level |

## How it works

- **Gemini**: the OpenAI Python SDK is pointed at Google's OpenAI-compatible endpoint and uses Chat Completions with JSON mode.
- **OpenAI**: the Responses API with a strict JSON schema and `store=False`.
- The model returns the 1-based numbers of the correct choices; the server validates them against the submitted options and builds `answer` and `choice_text` itself, so the answer can never point to a choice that does not exist.
- Rate limits, timeouts, connection errors, 5xx errors and malformed model output are retried with exponential backoff. Authentication and bad-request errors are not retried.

## Tests

```bash
pip install httpx
python -m unittest -v
```
