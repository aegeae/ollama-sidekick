# brave-ollama-extension

A minimal Brave/Chrome (Manifest V3) extension that calls local Ollama.

## Prereqs

- Node.js 18+ (recommended)
- Ollama installed and running locally

Start Ollama (example):

- `ollama serve`
- Pull a model (example): `ollama pull llama3.1`

## Install

- `npm install`

## Build

- `npm run build`

This produces `dist/` which you can load as an unpacked extension.

## Load in Brave

1. Open `brave://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

## Use

- Click the extension icon → popup
- If model list fails to load, confirm Ollama is reachable at `http://localhost:11434`
- Configure base URL / default model via **Options**

## Dev loop

- Run `npm run dev` (watch rebuild)
- Reload the extension in `brave://extensions` after changes

## Notes / Troubleshooting

- The extension requests host permissions for:
  - `http://localhost:11434/*`
  - `http://127.0.0.1:11434/*`
- If you use a different port or hostname, update Options (and manifest host permissions accordingly).

### HTTP 403 Forbidden

If the popup shows `HTTP 403 Forbidden`, Ollama is usually rejecting the browser `Origin` header (extensions send `Origin: chrome-extension://...`).

To confirm, try:

- `curl -i http://localhost:11434/api/tags`
- `curl -i -H "Origin: chrome-extension://test" http://localhost:11434/api/tags`

If the second command returns 403, restart Ollama allowing that origin. A common (broad) dev setting is:

- `OLLAMA_ORIGINS=* ollama serve`

Then reload the extension and retry.
