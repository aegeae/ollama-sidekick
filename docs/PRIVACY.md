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
- If you enable **Diagnostics → console capture** or **Diagnostics → request capture**, captured diagnostics are **not** saved to browser storage. They live in memory only and reset when you stop capture or reload.

For request capture, Sidekick only captures **metadata** about `fetch()` / `XMLHttpRequest` calls initiated by the page (method, URL, status, duration, error). It does not capture request/response bodies.

If you enable **Include bodies** in request capture, Sidekick will try to capture **text** request/response bodies for `fetch()` / `XMLHttpRequest` when possible (still in-memory only, and truncated). This may include sensitive information.

## What is sent to Ollama

When you send a message, Sidekick sends:

- Your prompt
- Optional context (selection and/or excerpt) depending on your Context preview drawer toggles

Diagnostics console capture does **not** send anything to Ollama by itself.

If you click **Attach to context** in Diagnostics, the currently captured diagnostics are included in the prompt context and therefore **will be sent to Ollama** as part of that message.

## Local-only design

- Host permissions are intentionally restricted to:
  - `http://localhost:11434/*`
  - `http://127.0.0.1:11434/*`

## Disabling context

To avoid reading page text:

- Open the **Context preview** drawer
- Disable both **Selection** and **Excerpt**

For the formal policy used for store listings, see `docs/PRIVACY_POLICY.md`.
