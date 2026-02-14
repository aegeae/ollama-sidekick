# Usage

Ollama Sidekick is a minimal Brave/Chrome (Manifest V3) extension that lets you chat with a **local** Ollama instance, and optionally attach context from your current tab.

## Quick start

1) Start Ollama locally:

- `ollama serve`

2) Pull a model (example):

- `ollama pull llama3.1`

3) Open Sidekick:

- Click the extension toolbar icon.
- A movable/resizable chat window opens (or focuses if already open).

4) Choose a model in the top bar.

## Asking with page context

Sidekick can attach context from the active tab **on demand**.

- Open the **Context preview** drawer (top-right button).
- Choose what to include:
  - **Selection** — only the text you’ve selected on the page.
  - **Excerpt** — a text excerpt from the page body.
- Set **Budget** (max characters) to control how much text is included.

The drawer shows:

- **Context** preview (what will be attached)
- **Final prompt** preview (the exact prompt sent to Ollama)

Notes:

- Context extraction only works on normal webpages (`http(s)://`). It won’t work on restricted pages like `chrome://`, `brave://`, the extensions gallery, etc.
- If you disable both **Selection** and **Excerpt**, no page text is read or attached.

## Context menu

- Select text on a page → right click → **Ask Ollama about selection**
- Sidekick opens the chat window with the selection prefilled and auto-sent.

## Chat history

- Conversations are saved locally in the browser (`chrome.storage.local`).
- Use the left sidebar to create chats, search, and organize into folders.
