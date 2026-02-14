# Chrome Web Store checklist

## Pre-flight

- `npm install`
- `npm run typecheck`
- `npm run build`
- Load `dist/` via **Load unpacked** and test:
  - Popup opens, chat works
  - Options page opens
  - “Use current tab as context” works on a normal webpage
  - Context menu entry works on selected text

## Package

- `npm run package:zip`
- Upload `ollama-sidekick.zip` to Chrome Web Store

## Store assets

- Provide icons (16/32/48/128) — already in `public/icons/`
- Provide screenshots and a short promo tile (created outside this repo)
- Provide a privacy policy link (required if you access page content)

## Review notes (expected)

- Permissions:
  - `storage` for settings
  - `activeTab` + `scripting` to extract context only on user action
  - `contextMenus` for the selection menu
- Host permissions:
  - Local Ollama only: `http://localhost:11434/*` and `http://127.0.0.1:11434/*`
