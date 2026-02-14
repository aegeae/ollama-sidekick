type ContentContextRequest = { type: 'CONTENT_CONTEXT_GET'; maxChars: number };

type ContentContextResponse = {
  ok: true;
  context: { title: string; url: string; selection: string; textExcerpt: string };
};

type ContentErrorResponse = { ok: false; error: { message: string } };

function getContext(maxChars: number) {
  const selection = String(window.getSelection?.()?.toString?.() ?? '').trim();
  const title = document.title || '';
  const url = location.href;

  const bodyText = (document.body?.innerText ?? document.body?.textContent ?? '').trim();
  const textExcerpt = bodyText.length > maxChars ? bodyText.slice(0, maxChars) : bodyText;

  return { title, url, selection, textExcerpt };
}

chrome.runtime.onMessage.addListener((msg: ContentContextRequest, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || msg.type !== 'CONTENT_CONTEXT_GET') return;
      const rawMax = Number.isFinite(msg.maxChars) ? msg.maxChars : 8000;
      const maxChars = Math.max(500, Math.min(20_000, Math.floor(rawMax)));
      const context = getContext(maxChars);
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
