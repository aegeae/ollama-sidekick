# Cross-platform UI verification (Chrome/Edge/Brave)

## What changed

- UI font stacks no longer include Apple-only defaults like `-apple-system` and `SFMono-Regular`.
- Popup, Options, and Chat now apply the same theme + typography variables from settings.
- The default UI font is now **JetBrains Mono**, bundled with the extension (no remote font loading).

## Quick sanity (any OS)

1. `npm run build`
2. Load `dist/` as unpacked.
3. Open:
   - Popup → check text rendering and code blocks.
   - Options page → confirm font/theme match popup.
   - Pop-out chat window → confirm font/theme match popup.
4. DevTools → Network: confirm there are **no** remote font requests (fonts should load from the extension itself).

## macOS

- Verify default sans text uses the system UI font (via `system-ui`).
- Switch `Font` setting between System UI / Sans / Serif / Monospace.

## Windows

- Verify sans fallbacks render well (typically Segoe UI via `system-ui` / `"Segoe UI"`).
- Verify monospace uses a Windows-available font (Cascadia Mono / Segoe UI Mono / Consolas fallback).

## Linux

- Verify sans fallbacks render well (Noto Sans / Liberation Sans fallbacks).
- Verify monospace falls back to Liberation Mono / monospace.

## Browser matrix

- Repeat the above in Chrome + Edge + Brave.
- Confirm there are no console CSP errors and no remote font requests.
