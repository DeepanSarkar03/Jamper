# Perplexity-like Chat (Railway) — Sonar API

A **Railway.app-hostable** web app that:

- Prompts the user for a **Perplexity API key on first run** (stored in the browser via `localStorage`).
- Uses that key to call the **Perplexity Sonar API** via a lightweight Node/Express proxy.
- Supports a “Perplexity-ish” experience: **streaming**, **citations**, **search results**, **search filters**, **Pro Search options**, and **media attachments**.

## What’s included

### Core
- ✅ Chat UI (threads, export to Markdown)
- ✅ Streaming responses (SSE)
- ✅ Citations + search results display
- ✅ Model switcher: `sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`

### “Perplexity-like” features (as exposed by the Sonar API)
- ✅ Search mode: `web` / `academic` / `sec`
- ✅ Search filters: domain, language, recency
- ✅ Pro Search knobs (Sonar Pro): `web_search_options.search_type` and `stream_mode`
- ✅ Media:
  - Send images + documents (base64) for analysis
  - (Best-effort) receive images and videos when enabled
- ✅ Deep Research async support (best-effort): submit + poll

> Note: The Perplexity consumer product has additional UI/product features (accounts, sharing, collections, etc.) that are not part of the Sonar API. This template focuses on what’s achievable through the public API.

## Local run

```bash
npm install
npm start
```

Open: http://localhost:3000

## Deploy to Railway

1. Create a new Railway project.
2. Connect your GitHub repo (or upload this folder).
3. Railway should detect a Node app automatically.
4. No environment variables required (the user enters their key in the browser).

Railway will run `npm install` and then `npm start`.

## Security notes

- The API key is stored in **your browser only** and sent in the `x-pplx-key` header per request.
- The server **does not store** keys.
- Treat this as a template: add auth / rate limiting if you’re deploying publicly.

## Troubleshooting

- If you see "Request entity too large", reduce attachment size or increase the JSON body limit in `server.js`.
- If images/related questions don’t show up, your Perplexity account may require a specific usage tier for those features.
