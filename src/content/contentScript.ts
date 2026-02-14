type ContentContextRequest = {
  type: 'CONTENT_CONTEXT_GET';
  maxChars: number;
  includeSelection?: boolean;
  includeExcerpt?: boolean;
};

type ContentConsoleCaptureSetRequest = {
  type: 'CONTENT_CONSOLE_CAPTURE_SET';
  enabled: boolean;
};

type ContentNetCaptureSetRequest = {
  type: 'CONTENT_NET_CAPTURE_SET';
  enabled: boolean;
};

type ContentContextResponse = {
  ok: true;
  context: { title: string; url: string; selection: string; textExcerpt: string };
};

type ContentOkResponse = { ok: true };

type ContentErrorResponse = { ok: false; error: { message: string } };

(() => {
  const g = globalThis as any;
  if (g.__OLLAMA_SIDEKICK_CONTENT_SCRIPT_INSTALLED__ === true) return;
  g.__OLLAMA_SIDEKICK_CONTENT_SCRIPT_INSTALLED__ = true;

  let consoleCaptureEnabled = false;
  let netCaptureEnabled = false;

  function safeSendToBackground(message: unknown): void {
    try {
      chrome.runtime.sendMessage(message as any, () => {
        // Reading lastError inside the callback prevents noisy
        // "Unchecked runtime.lastError" logs when the extension is reloading
        // or the service worker isn't reachable momentarily.
        void chrome.runtime.lastError;
      });
    } catch {
      // Best-effort only.
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;

    const data = event.data as any;

    if (consoleCaptureEnabled && data && data.source === 'ollama-sidekick' && data.type === 'TAB_CONSOLE') {
      const levelRaw = typeof data.level === 'string' ? data.level : 'log';
      const level =
        levelRaw === 'log' || levelRaw === 'info' || levelRaw === 'warn' || levelRaw === 'error' || levelRaw === 'debug'
          ? levelRaw
          : 'log';
      const text = typeof data.text === 'string' ? data.text : '';
      const ts = typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now();

      safeSendToBackground({ type: 'TAB_CONSOLE_LOG_ENTRY', entry: { ts, level, text } });
      return;
    }

    if (netCaptureEnabled && data && data.source === 'ollama-sidekick' && data.type === 'TAB_NET') {
      const entry = data.entry as any;
      if (!entry || typeof entry !== 'object') return;

      const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : Date.now();
      const kindRaw = typeof entry.kind === 'string' ? entry.kind : 'fetch';
      const kind = kindRaw === 'fetch' || kindRaw === 'xhr' ? kindRaw : 'fetch';
      const method = typeof entry.method === 'string' ? entry.method : 'GET';
      const url = typeof entry.url === 'string' ? entry.url : '';
      const status = typeof entry.status === 'number' && Number.isFinite(entry.status) ? entry.status : null;
      const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? entry.durationMs : null;
      const error = typeof entry.error === 'string' ? entry.error : undefined;

      const requestBodyText = typeof entry.requestBodyText === 'string' ? entry.requestBodyText : undefined;
      const responseBodyText = typeof entry.responseBodyText === 'string' ? entry.responseBodyText : undefined;
      const bodyTruncated = entry.bodyTruncated === true ? true : undefined;

      safeSendToBackground({
        type: 'TAB_NET_LOG_ENTRY',
        entry: { ts, kind, method, url, status, durationMs, error, requestBodyText, responseBodyText, bodyTruncated }
      });
      return;
    }
  });

  function clip(s: string, maxChars: number): string {
    if (s.length > maxChars) return s.slice(0, maxChars);
    return s;
  }

  function getContext(maxChars: number, includeSelection: boolean, includeExcerpt: boolean) {
    const selectionRaw = includeSelection ? String(window.getSelection?.()?.toString?.() ?? '').trim() : '';
    const selection = includeSelection ? clip(selectionRaw, maxChars) : '';
    const title = document.title || '';
    const url = location.href;

    let textExcerpt = '';
    if (includeExcerpt) {
      const bodyText = (document.body?.innerText ?? document.body?.textContent ?? '').trim();
      textExcerpt = clip(bodyText, maxChars);
    }

    return { title, url, selection, textExcerpt };
  }

  chrome.runtime.onMessage.addListener(
    (msg: ContentContextRequest | ContentConsoleCaptureSetRequest | ContentNetCaptureSetRequest, _sender, sendResponse) => {
      (async () => {
        try {
          if (!msg) return;

          if (msg.type === 'CONTENT_CONSOLE_CAPTURE_SET') {
            consoleCaptureEnabled = Boolean(msg.enabled);
            const resp: ContentOkResponse = { ok: true };
            sendResponse(resp);
            return;
          }

          if (msg.type === 'CONTENT_NET_CAPTURE_SET') {
            netCaptureEnabled = Boolean(msg.enabled);
            const resp: ContentOkResponse = { ok: true };
            sendResponse(resp);
            return;
          }

          if (msg.type !== 'CONTENT_CONTEXT_GET') return;
          const rawMax = Number.isFinite(msg.maxChars) ? msg.maxChars : 8000;
          const maxChars = Math.max(500, Math.min(20_000, Math.floor(rawMax)));
          const includeSelection = msg.includeSelection !== false;
          const includeExcerpt = msg.includeExcerpt !== false;
          const context = getContext(maxChars, includeSelection, includeExcerpt);
          const resp: ContentContextResponse = { ok: true, context };
          sendResponse(resp);
        } catch (err) {
          const resp: ContentErrorResponse = {
            ok: false,
            error: { message: err instanceof Error ? err.message : String(err) }
          };
          sendResponse(resp);
        }
      })();

      return true;
    }
  );
})();
