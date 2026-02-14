type ContentContextRequest = {
  type: 'CONTENT_CONTEXT_GET';
  maxChars: number;
  includeSelection?: boolean;
  includeExcerpt?: boolean;
};

type ContentContextResponse = {
  ok: true;
  context: { title: string; url: string; selection: string; textExcerpt: string };
};

type ContentErrorResponse = { ok: false; error: { message: string } };

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

chrome.runtime.onMessage.addListener((msg: ContentContextRequest, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || msg.type !== 'CONTENT_CONTEXT_GET') return;
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
});
