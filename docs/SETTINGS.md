# Settings

Open **Settings** from the chat window.

## Base URL

- Default: `http://localhost:11434`
- Sidekick intentionally validates that the Base URL is **local-only** (`localhost` or `127.0.0.1`) on port **11434**.

If the model list is empty or requests fail:

- Confirm Ollama is running: `ollama serve`
- Confirm the endpoint works: `curl -i http://localhost:11434/api/tags`

### HTTP 403 Forbidden

If you see `HTTP 403 Forbidden`, Ollama may be rejecting the browser `Origin` header (extensions send `Origin: chrome-extension://...`).

A broad dev setting that often resolves this is:

- `OLLAMA_ORIGINS=* ollama serve`

## Model

- Choose a model from the dropdown.
- Sidekick uses the selected model for requests.

## Theme and font

- Theme: light/dark/system
- Font family and font size apply to the extension UI.

## Export

If export options are enabled in this build, they control how chat history is exported (browser storage remains the primary storage).
