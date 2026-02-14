# Chrome Web Store listing copy — Ollama Sidekick

## Short description (<=132 chars)

Chat with local Ollama models from your browser, optionally using the current page selection/text as context.

## Detailed description

Ollama Sidekick lets you chat with **local Ollama models** from Chrome/Brave.

Key features:

- Choose a model from your local Ollama instance
- Chat in the popup, or “Pop out” a movable window
- Optional Context mode: include the current page selection / excerpt on-demand
- Right-click selected text → “Ask Ollama about selection”

Privacy & data use:

- No analytics, no tracking, no developer servers
- When you use Context features, the extension extracts the current page selection/excerpt and sends it only to your **local** Ollama server (`localhost:11434` or `127.0.0.1:11434`)

## Permissions justification (for review)

- `storage` — save settings (base URL, default model, theme/font, window sizing)
- `activeTab` + `scripting` — extract page selection/text only when you explicitly use Context features
- `contextMenus` — add “Ask Ollama about selection” right-click menu
- Host permissions: `http://localhost:11434/*` and `http://127.0.0.1:11434/*` — talk to the local Ollama HTTP API

## Support

- Support email: TODO
- Homepage / documentation URL: TODO
