# Copilot instructions (Ollama Sidekick)

This repo is a minimal **Chrome/Brave Manifest V3** extension that chats with a **local** Ollama instance and can optionally extract current-tab text/selection as context.

## Quick map (entry points)

- Manifest (MV3): `manifest.json`
  - `background.service_worker`: `background.js` (built from `src/background/serviceWorker.ts`)
  - `action.default_popup`: `src/popup/popup.html`
  - `options_ui.page`: `src/options/options.html`
  - CSP: `content_security_policy.extension_pages = "script-src 'self'; object-src 'self'"`
  - Host permissions are intentionally local-only (`localhost:11434`, `127.0.0.1:11434`).

- Background/service worker: `src/background/serviceWorker.ts`
  - Handles runtime messages and does all network calls to Ollama.
  - On-demand injects `contentScript.js` to extract tab context.
  - Creates a context-menu item (“Ask Ollama about selection”).

- Content script: `src/content/contentScript.ts`
  - Responds to `CONTENT_CONTEXT_GET` with `{ title, url, selection, textExcerpt }`.

- Popup UI: `src/popup/popup.html`, `src/popup/popup.ts`, `src/popup/popup.css`
  - Main chat UI + settings drawer.

- Options UI: `src/options/options.html`, `src/options/options.ts`, `src/options/options.css`
  - Settings page (base URL, model, theme, font, font size).

- Chat tab ("Pop out"): `src/chat/chat.html`, `src/chat/chat.ts`, `src/chat/chat.css`
  - Separate chat window (supports URL query `?prompt=...&auto=1`).

- Message types: `src/types/messages.ts`

## Build system

- Tooling: Vite + TypeScript (strict)
  - Config: `vite.config.ts`
  - Output: `dist/`
  - Multi-entry build:
    - popup/options/chat HTML
    - `src/background/serviceWorker.ts` -> `dist/background.js`
    - `src/content/contentScript.ts` -> `dist/contentScript.js`
  - Static copy:
    - `manifest.json` -> `dist/manifest.json`
    - CSS files copied into `dist/src/**`.

### NPM scripts (common)

- `npm run build` — store-friendly build (no sourcemaps by default)
- `npm run build:debug` — build with sourcemaps
- `npm run dev` — watch rebuild (debug mode)
- `npm run typecheck` — `tsc --noEmit`
- `npm run package:zip` — builds + creates `ollama-sidekick.zip` from `dist/`

## Data flow (what calls what)

### Model list

- UI (popup/chat) -> `chrome.runtime.sendMessage({ type: 'OLLAMA_LIST_MODELS' })`
- Background (`src/background/serviceWorker.ts`) -> `listModels()` in `src/lib/ollamaClient.ts` -> `GET /api/tags`

### Generate response

- UI -> `chrome.runtime.sendMessage({ type: 'OLLAMA_GENERATE', prompt, model? })`
- Background -> `generate()` in `src/lib/ollamaClient.ts` -> `POST /api/generate` (non-streaming)
- Background returns `{ type: 'OLLAMA_GENERATE_RESULT', text }`

### Tab context extraction

- UI -> `chrome.runtime.sendMessage({ type: 'TAB_CONTEXT_GET' })`
- Background injects `contentScript.js` using `chrome.scripting.executeScript`
- Background sends tab message `{ type: 'CONTENT_CONTEXT_GET', maxChars }`
- Content script returns `{ selection, textExcerpt, title, url }`

## Settings model

- Source of truth: `src/lib/settings.ts`
  - Stored in `chrome.storage.local` keys: `baseUrl`, `model`, `theme`, `fontFamily`, `fontSize`
  - UI window sizing/persistence keys also exist in popup/chat (e.g. `popupWidth`, `popupHeight`, `chatWinLeft`, ...).

- Defaults: `DEFAULT_SETTINGS` in `src/lib/settings.ts`
- Validation:
  - `baseUrl` must be `http://` and **local-only** (`localhost` or `127.0.0.1`) on port `11434`.
  - Invalid stored values fall back to defaults.

## UI conventions (themes + fonts)

- Centralized UI application: `src/lib/uiSettings.ts`
  - `applyUiSettings(settings)` sets:
    - `documentElement.dataset.theme = settings.theme`
    - CSS vars: `--ui-font-family`, `--ui-font-size`

- CSS theme tokens are implemented with `:root[data-theme='light'|'dark'|'system']`.

- Bundled font: JetBrains Mono
  - Assets: `public/fonts/jetbrains-mono/*.woff2` + `public/fonts/jetbrains-mono/OFL.txt`
  - `@font-face` lives in `src/popup/popup.css`, `src/options/options.css` (and chat CSS similarly).
  - Do not load fonts remotely.

## Security / store constraints (do not regress)

- No remote scripts; keep MV3 extension-page CSP strict (`'self'` only).
- Keep Ollama calls local by default (manifest host permissions + `settings.ts` validation).
- Do not widen `host_permissions` or `permissions` without explicit justification + doc update.
- Avoid collecting or persisting browsing/page content by default.

## Release automation (protected `main`)

- `main` is treated as a protected release branch.
- Auto bump/tag workflow: `.github/workflows/auto-release.yml`
  - Computes bump from Conventional Commits since last `v*` tag (see scripts below)
  - Commits: `chore(release): vX.Y.Z [skip ci]`
  - Creates annotated tag `vX.Y.Z`

- Version scripts:
  - `scripts/next-version.mjs` — reads git tags + commit messages to compute bump/next version
  - `scripts/apply-version.mjs` — writes version to `package.json` + `manifest.json` (+ `package-lock.json` if present)

- Tag release workflow: `.github/workflows/release.yml` builds `ollama-sidekick.zip` and creates a GitHub Release on `v*` tags.
- Details: `docs/RELEASING.md`

## Coding conventions (repo-specific)

- Prefer minimal diffs and no new dependencies.
- Keep TypeScript strict; avoid `any` unless unavoidable.
- Background should be the only place doing network I/O.
- Use typed message unions in `src/types/messages.ts` for any new runtime messages.
- Error UX: propagate useful error details (status/url/hints) via `BackgroundResponse`.

## Common tasks (recipes)

### Add a new background message

1) Add request/response types in `src/types/messages.ts`.
2) Handle it in `src/background/serviceWorker.ts`.
3) Call it from UI via `chrome.runtime.sendMessage(...)`.

### Add a new setting

1) Extend `Settings` + `DEFAULT_SETTINGS` in `src/lib/settings.ts`.
2) Update `getSettings()`/`setSettings()` (validation + clamping).
3) Wire UI controls in `src/options/options.ts` and/or `src/popup/popup.ts`.
4) If it affects look-and-feel, apply via `applyUiSettings()` and CSS vars.

### Add a new extension page (HTML)

1) Create `src/<page>/<page>.html|.ts|.css`.
2) Add it to `vite.config.ts` `rollupOptions.input`.
3) Add any required manifest wiring (keep permissions minimal).

## Unknown / verify (before big changes)

- If you change any network behavior or permissions, cross-check: `manifest.json`, `src/lib/settings.ts`, and `STORE_LISTING.md`.
- If you touch releases, cross-check: `.github/workflows/*.yml` and `docs/RELEASING.md`.
