# Troubleshooting

## Models don’t load / connection errors

- Ensure Ollama is running: `ollama serve`
- Check the endpoint: `curl -i http://localhost:11434/api/tags`
- Confirm **Base URL** is `http://localhost:11434` in Settings

## HTTP 403 Forbidden

Ollama may reject extension requests based on the `Origin` header.

- Try restarting Ollama with: `OLLAMA_ORIGINS=* ollama serve`

## Context is unavailable

Context extraction only works on normal webpages.

It will not work on:

- `chrome://` / `brave://`
- Chrome Web Store pages
- extension pages

## Context is empty

- If **Selection** is enabled, make sure you have selected text on the page.
- If **Excerpt** is enabled, some pages may not expose readable body text (highly dynamic pages).
- Increase **Budget** if the excerpt is being clipped too aggressively.

## Debugging

- Open the chat window → open DevTools for the extension window
- Reload the extension in `brave://extensions` / `chrome://extensions`
- Try again on a normal `https://` page

## Diagnostics capture doesn’t show anything

- Diagnostics capture only records events **after** you start capturing.
- Request capture only observes network calls made by the page via `fetch()` / `XMLHttpRequest` (it is not a full DevTools Network capture).
- Diagnostics capture is unavailable on restricted pages (`chrome://`, Web Store, extension pages), similar to Context extraction.
