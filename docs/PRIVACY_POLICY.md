# Privacy Policy — Ollama Sidekick

Last updated: 2026-02-14

## Summary

Ollama Sidekick is a Chrome/Brave extension that lets you chat with **local** Ollama models running on your computer. The extension does not run any backend service and does not send your data to the developer.

## Data we access

Depending on how you use the extension:

- **Page content (optional):** If you enable **Context** or use the **Ask Ollama about selection** context-menu item, the extension extracts the current page’s **selection** and a **limited text excerpt** from the page.
- **Page metadata:** The page **title** and **URL** may be included as part of the extracted context.

## How data is used

- Page context is used only to build the prompt you send to Ollama.
- The prompt (including any context you chose to include) is sent only to your local Ollama server at:
  - `http://localhost:11434`, or
  - `http://127.0.0.1:11434`.

## What we store

The extension stores a small amount of configuration in `chrome.storage.local`:

- Base URL (restricted to local Ollama)
- Default model
- Theme / font settings
- Popup size and pop-out window bounds

Chat history is not persisted by the extension (it exists only in-memory while the popup/window is open).

## What we do not collect

- No analytics
- No advertising IDs
- No sale of data
- No developer-owned servers receive your content

## Third parties

- The only network calls are to your configured **local** Ollama instance.

## Contact

If you have questions or requests, contact: **TODO: add support email / URL**
