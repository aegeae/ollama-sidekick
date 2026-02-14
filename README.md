# Ollama Sidekick

![CI](https://github.com/aegeae/ollama-sidekick/actions/workflows/ci.yml/badge.svg)

A minimal Brave/Chrome (Manifest V3) extension that chats with local Ollama.

This project is fully vibe-coded with GitHub Copilot.

## Branding

- Name: **Ollama Sidekick**
- Icons: `public/icons/` (generated from an original SVG via `npm run gen:icons`)

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

Notes:

- `npm run build` is store-ready by default (no sourcemaps).
- Use `npm run build:debug` if you want sourcemaps for local debugging.

This produces `dist/` which you can load as an unpacked extension.

For Chrome Web Store packaging:

- `npm run package:zip` → creates `ollama-sidekick.zip` from `dist/`
- See `STORE_CHECKLIST.md` for a submission checklist.

## Load in Brave

1. Open `brave://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

## Use

- Click the extension icon → pop-out window (default)
- If model list fails to load, confirm Ollama is reachable at `http://localhost:11434`
- Configure base URL / default model via **Settings** (in the popup)

### Popup resize / move

- The extension action popup is controlled by the browser UI, so it cannot be freely dragged to a different location.
- Use **Pop out** to open a movable + resizable chat window (this is the default behavior).
- **Pop in** closes the pop-out window. You can disable auto pop-out in **Settings** if you prefer the toolbar popup.

### Use current tab as context

In the popup:

- Context is attached automatically (best-effort) when you send a message.

Context is only extracted on user action (when you send) and is not persisted.

Notes / limitations:

- Context extraction only works on normal webpages (`http(s)://`). It does not work on restricted pages like `chrome://`, `brave://`, the extensions gallery, etc.
- In **Pop out** window mode, context targets the active tab in your focused normal browser window. Switch tabs in the browser, then send again to attach the new context.

### Chat history (local)

- Conversations are saved locally in the browser via `chrome.storage.local`.
- Use the left sidebar to create chats, search, and organize chats into folders.
- Use **Rename** / **Delete** in the header for the active chat.

### Chat history export (folder / formats)

- In **Settings**, you can choose how to export chat history:
  - **Local (browser storage)** — default (current behavior)
  - **Folder (export)** — pick a folder and export history to disk in JSON / JSONL / Markdown
- Folder export uses the browser’s File System Access API when available; otherwise it falls back to downloading a file.
- Note: the extension still keeps chat history in browser storage; folder export is an additional copy on disk.

Note: some browsers display the save prompt origin as `chrome-extension://<id>` (especially for unpacked extensions). That label is controlled by the browser UI and isn’t something the extension can override.

### Context menu

- Select text on a page → right click → **Ask Ollama about selection**
- This opens a movable extension chat window prefilled with the selection and auto-sends it.

## Dev loop

- Run `npm run dev` (watch rebuild)
- Reload the extension in `brave://extensions` after changes

## Regression checks

Before merging changes (especially `src/popup/*` and `src/background/*`), run:

- `npm run typecheck && npm test && npm run build`

The unit tests are intentionally browser-free: regression-prone logic is kept in small pure helpers under `src/lib/*`.

## Versioning / release

- `npm run release:patch` (or `release:minor` / `release:major`) bumps versions in `package.json` + `manifest.json` and then builds.

### Protected `main` auto-release

This repo treats `main` as a protected release branch. On each push/merge to `main`, GitHub Actions will:

- Compute a SemVer bump from Conventional Commit messages (`feat`/`fix`/breaking)
- Bump `package.json` + `manifest.json`
- Create and push a tag `vX.Y.Z`

The tag push then triggers the existing tag-based release workflow to build and upload `ollama-sidekick.zip`.

Details and required GitHub settings (branch protection + allowing Actions to push) are in [docs/RELEASING.md](docs/RELEASING.md).

### GitHub Release (tag)

- Create a tag like `v0.1.0` and push it; GitHub Actions will attach `ollama-sidekick.zip` to a GitHub Release.
- Example:
  - `git tag v0.1.0`
  - `git push origin v0.1.0`

Note: the badge will start working after the first push.

## Notes / Troubleshooting

- The extension requests host permissions for:
  - `http://localhost:11434/*`
  - `http://127.0.0.1:11434/*`
- By default, the extension only allows a **local** Base URL on port **11434**. If you want to use a different port/hostname, you must update the manifest host permissions and rebuild.

### Permissions

- `storage` — save base URL + default model
- `activeTab` + `scripting` — extract current page selection/excerpt on-demand when you use Context
- `contextMenus` — adds “Ask Ollama about selection”

## Security notes

- Chat history is stored locally using `chrome.storage.local` (isolated to this extension; normal websites cannot read it).
- The extension uses a strict extension-page CSP (`script-src 'self'`) and does not load remote scripts or fonts.
- Chat history is not encrypted at rest. If someone has access to your browser profile or device, they can likely access it.
- Malicious extensions or local malware can still exfiltrate data; use a separate browser profile and avoid untrusted extensions if you handle sensitive content.

## Chrome Web Store

- Privacy policy: `PRIVACY_POLICY.md`
- Listing copy + permissions justification: `STORE_LISTING.md`
- Submission checklist: `STORE_CHECKLIST.md`

## License

MIT — see `LICENSE`.

### HTTP 403 Forbidden

If the popup shows `HTTP 403 Forbidden`, Ollama is usually rejecting the browser `Origin` header (extensions send `Origin: chrome-extension://...`).

To confirm, try:

- `curl -i http://localhost:11434/api/tags`
- `curl -i -H "Origin: chrome-extension://test" http://localhost:11434/api/tags`

If the second command returns 403, restart Ollama allowing that origin. A common (broad) dev setting is:

- `OLLAMA_ORIGINS=* ollama serve`

Then reload the extension and retry.

## Manual checklist

- Build: `npm run typecheck` and `npm run build`.
- Popup: create a new chat, send a message, reload the popup — history remains.
- Folders: create folder, move chat via folder dropdown, collapse/expand folder.
- Search: search finds chats by title and message content.
- Delete: delete a chat; delete a folder moves its chats to **Inbox**.
- Context: with **Context** enabled, verify only your typed message is stored (not the injected page excerpt).
