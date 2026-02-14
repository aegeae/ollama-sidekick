# Privacy

Ollama Sidekick is designed to work with a **local** Ollama instance and avoid persisting browsing/page content by default.

## What is stored

Stored locally in your browser (`chrome.storage.local`):

- App settings (base URL, model, theme, font, font size)
- Chat history (messages you and the assistant exchanged)
- UI preferences (window sizing/position, sidebar state)

## What is *not* stored by default

- Full webpage contents are **not** saved.
- When you use context (Selection/Excerpt), the extracted text is used to build a prompt and sent to Ollama, but it is not written to disk by the extension as part of normal operation.

## What is sent to Ollama

When you send a message, Sidekick sends:

- Your prompt
- Optional context (selection and/or excerpt) depending on your Context preview drawer toggles

## Local-only design

- Host permissions are intentionally restricted to:
  - `http://localhost:11434/*`
  - `http://127.0.0.1:11434/*`

## Disabling context

To avoid reading page text:

- Open the **Context preview** drawer
- Disable both **Selection** and **Excerpt**

For the formal policy used for store listings, see `docs/PRIVACY_POLICY.md`.
