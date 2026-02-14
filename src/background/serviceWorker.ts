import { getSettings } from '../lib/settings';
import { listModels, generate, showModel, HttpError } from '../lib/ollamaClient';
import { extractTokenBudget } from '../lib/ollamaModelInfo';
import { getRestrictedPageHint, isRestrictedUrl } from '../lib/restrictedUrl';
import type { BackgroundRequest, BackgroundResponse, TabConsoleLogEntry, TabInfo, TabNetLogEntry } from '../types/messages';

const SESSION_LAST_USER_TAB_ID_KEY = 'lastUserTabId';
const SESSION_LAST_NORMAL_WINDOW_ID_KEY = 'lastNormalWindowId';
const SESSION_POPOUT_WINDOW_ID_KEY = 'popoutWindowId';

let lastFocusedNormalWindowId: number | null = null;

let modelsCache:
  | {
      baseUrl: string;
      models: string[];
      ts: number;
    }
  | null = null;

const TAB_CONSOLE_MAX_ENTRIES = 500;

const TAB_NET_MAX_ENTRIES = 300;

const tabConsoleCaptureEnabled = new Map<number, boolean>();
const tabConsoleLogs = new Map<number, TabConsoleLogEntry[]>();

const tabNetCaptureEnabled = new Map<number, boolean>();
const tabNetCaptureIncludeBodies = new Map<number, boolean>();
const tabNetLogs = new Map<number, TabNetLogEntry[]>();

async function sendToContentWithRetry(tabId: number, message: unknown): Promise<void> {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message as any, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || 'Failed to message content script'));
            return;
          }
          // Content script replies { ok: true } on success; treat missing response as failure.
          if (resp && typeof resp === 'object' && (resp as any).ok === true) {
            resolve();
            return;
          }
          reject(new Error('No acknowledgement from content script'));
        });
      });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

function getTabConsoleLogs(tabId: number): TabConsoleLogEntry[] {
  return tabConsoleLogs.get(tabId) ?? [];
}

function pushTabConsoleLog(tabId: number, entry: TabConsoleLogEntry): void {
  const existing = tabConsoleLogs.get(tabId) ?? [];
  const next = existing.length >= TAB_CONSOLE_MAX_ENTRIES ? existing.slice(existing.length - TAB_CONSOLE_MAX_ENTRIES + 1) : existing;
  next.push(entry);
  tabConsoleLogs.set(tabId, next);
}

function getTabNetLogs(tabId: number): TabNetLogEntry[] {
  return tabNetLogs.get(tabId) ?? [];
}

function pushTabNetLog(tabId: number, entry: TabNetLogEntry): void {
  const existing = tabNetLogs.get(tabId) ?? [];
  const next = existing.length >= TAB_NET_MAX_ENTRIES ? existing.slice(existing.length - TAB_NET_MAX_ENTRIES + 1) : existing;
  next.push(entry);
  tabNetLogs.set(tabId, next);
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const hint =
      getRestrictedPageHint() ??
      'This page cannot be scripted (Chrome Web Store / browser pages). Switch to a normal webpage and try again.';
    console.warn('Injection failed', { tabId, error: raw });
    throw new Error(hint);
  }
}

async function injectConsoleHook(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      try {
        const w = window as any;
        if (w.__OLLAMA_SIDEKICK_CONSOLE_HOOK__ === true) return;
        w.__OLLAMA_SIDEKICK_CONSOLE_HOOK__ = true;

        const SOURCE = 'ollama-sidekick';
        const TYPE = 'TAB_CONSOLE';
        const MAX_TEXT = 8000;

        const safeStringify = (val: unknown): string => {
          if (typeof val === 'string') return val;
          if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
          if (val == null) return String(val);
          if (val instanceof Error) return val.stack || `${val.name}: ${val.message}`;
          try {
            const s = JSON.stringify(val);
            return typeof s === 'string' ? s : String(val);
          } catch {
            return String(val);
          }
        };

        const wrap = (level: string) => {
          const orig = (console as any)[level];
          if (typeof orig !== 'function') return;
          (console as any)[level] = (...args: unknown[]) => {
            try {
              orig.apply(console, args);
            } finally {
              try {
                const text = args.map(safeStringify).join(' ');
                const clipped = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
                window.postMessage({ source: SOURCE, type: TYPE, level, text: clipped, ts: Date.now() }, '*');
              } catch {
                // ignore
              }
            }
          };
        };

        wrap('log');
        wrap('info');
        wrap('warn');
        wrap('error');
        wrap('debug');
      } catch {
        // ignore
      }
    }
  });
}

async function injectNetHook(tabId: number, includeBodies: boolean): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (wantBodies: boolean) => {
      try {
        const w = window as any;

        // This flag is consulted at request time, so it can be toggled without reinstalling wrappers.
        w.__OLLAMA_SIDEKICK_NET_INCLUDE_BODIES__ = wantBodies === true;

        if (w.__OLLAMA_SIDEKICK_NET_HOOK__ === true) return;
        w.__OLLAMA_SIDEKICK_NET_HOOK__ = true;

        const SOURCE = 'ollama-sidekick';
        const TYPE = 'TAB_NET';
        const MAX_URL = 2000;
        const MAX_TEXT = 4000;
        const MAX_BODY = 16_000;

        const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

        const includeBodies = () => {
          try {
            return (window as any).__OLLAMA_SIDEKICK_NET_INCLUDE_BODIES__ === true;
          } catch {
            return false;
          }
        };

        const clipBody = (text: string) => {
          const raw = typeof text === 'string' ? text : String(text);
          const truncated = raw.length > MAX_BODY;
          return { text: truncated ? raw.slice(0, MAX_BODY) : raw, truncated };
        };

        const formatUnavailable = (reason: string) => `[unavailable: ${clip(reason, MAX_TEXT)}]`;

        const emit = (entry: any) => {
          try {
            window.postMessage({ source: SOURCE, type: TYPE, entry }, '*');
          } catch {
            // ignore
          }
        };

        const now = () => Date.now();

        // fetch
        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
          window.fetch = (input: any, init?: any) => {
            const start = now();
            let method = 'GET';
            let url = '';
            let requestBodyText: string | undefined;
            let reqTrunc = false;

            try {
              if (init && typeof init.method === 'string') method = init.method.toUpperCase();
              if (typeof input === 'string') url = input;
              else if (input && typeof input.url === 'string') url = input.url;
              else url = String(input ?? '');
            } catch {
              // ignore
            }

            url = clip(url, MAX_URL);

            if (includeBodies()) {
              try {
                const body = init?.body;
                if (typeof body === 'string') {
                  const c = clipBody(body);
                  requestBodyText = c.text;
                  reqTrunc = c.truncated;
                } else if (body && typeof body.toString === 'function' && body.constructor && body.constructor.name === 'URLSearchParams') {
                  const c = clipBody(body.toString());
                  requestBodyText = c.text;
                  reqTrunc = c.truncated;
                } else if (body == null) {
                  requestBodyText = '';
                } else {
                  requestBodyText = formatUnavailable('non-text request body');
                }
              } catch (e: any) {
                requestBodyText = formatUnavailable(e?.message || 'request body capture failed');
              }
            }

            return (origFetch as any)(input, init)
              .then(async (resp: any) => {
                try {
                  const ts = start;
                  const status = typeof resp?.status === 'number' ? resp.status : null;
                  const durationMs = now() - start;

                  let responseBodyText: string | undefined;
                  let resTrunc = false;
                  if (includeBodies()) {
                    try {
                      if (resp && typeof resp.clone === 'function') {
                        const text = await resp.clone().text();
                        const c = clipBody(String(text ?? ''));
                        responseBodyText = c.text;
                        resTrunc = c.truncated;
                      } else {
                        responseBodyText = formatUnavailable('response clone/text not available');
                      }
                    } catch (e: any) {
                      responseBodyText = formatUnavailable(e?.message || 'response body capture failed');
                    }
                  }

                  emit({
                    ts,
                    kind: 'fetch',
                    method,
                    url,
                    status,
                    durationMs,
                    error: undefined,
                    requestBodyText,
                    responseBodyText,
                    bodyTruncated: reqTrunc || resTrunc
                  });
                } catch {
                  // ignore
                }
                return resp;
              })
              .catch((err: any) => {
                try {
                  const ts = start;
                  const durationMs = now() - start;
                  const msg = err && typeof err.message === 'string' ? err.message : String(err);
                  emit({
                    ts,
                    kind: 'fetch',
                    method,
                    url,
                    status: null,
                    durationMs,
                    error: clip(msg, MAX_TEXT),
                    requestBodyText: includeBodies() ? requestBodyText : undefined,
                    responseBodyText: undefined,
                    bodyTruncated: reqTrunc
                  });
                } catch {
                  // ignore
                }
                throw err;
              });
          };
        }

        // XMLHttpRequest
        const XHR = window.XMLHttpRequest;
        if (typeof XHR === 'function' && XHR.prototype) {
          const origOpen = XHR.prototype.open;
          const origSend = XHR.prototype.send;

          XHR.prototype.open = function (method: any, url: any, ...rest: any[]) {
            try {
              (this as any).__ollama_sidekick_method = typeof method === 'string' ? method.toUpperCase() : 'GET';
              (this as any).__ollama_sidekick_url = clip(String(url ?? ''), MAX_URL);
            } catch {
              // ignore
            }
            return origOpen.apply(this, [method, url, ...rest] as any);
          };

          XHR.prototype.send = function (...args: any[]) {
            try {
              const xhr: any = this as any;

              const want = includeBodies();
              xhr.__ollama_sidekick_wantBodies__ = want;
              xhr.__ollama_sidekick_reqBodyText = undefined;
              xhr.__ollama_sidekick_reqTrunc = false;
              if (want) {
                try {
                  const body = args && args.length ? args[0] : undefined;
                  if (typeof body === 'string') {
                    const c = clipBody(body);
                    xhr.__ollama_sidekick_reqBodyText = c.text;
                    xhr.__ollama_sidekick_reqTrunc = c.truncated;
                  } else if (body == null) {
                    xhr.__ollama_sidekick_reqBodyText = '';
                  } else {
                    xhr.__ollama_sidekick_reqBodyText = formatUnavailable('non-text request body');
                  }
                } catch (e: any) {
                  xhr.__ollama_sidekick_reqBodyText = formatUnavailable(e?.message || 'request body capture failed');
                }
              }

              if (xhr.__ollama_sidekick_listening__ !== true) {
                xhr.__ollama_sidekick_listening__ = true;
                xhr.addEventListener(
                  'loadend',
                  () => {
                    try {
                      const start = typeof xhr.__ollama_sidekick_start === 'number' ? xhr.__ollama_sidekick_start : now();
                      const ts = start;
                      const durationMs = now() - start;
                      const status = typeof xhr.status === 'number' && Number.isFinite(xhr.status) ? xhr.status : null;
                      const method = typeof xhr.__ollama_sidekick_method === 'string' ? xhr.__ollama_sidekick_method : 'GET';
                      const url = typeof xhr.__ollama_sidekick_url === 'string' ? xhr.__ollama_sidekick_url : '';
                      let responseBodyText: string | undefined;
                      let resTrunc = false;
                      const want = xhr.__ollama_sidekick_wantBodies__ === true;
                      if (want) {
                        try {
                          const rt = xhr.responseType;
                          if (rt === '' || rt === 'text') {
                            const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
                            const c = clipBody(text);
                            responseBodyText = c.text;
                            resTrunc = c.truncated;
                          } else {
                            responseBodyText = formatUnavailable('non-text response');
                          }
                        } catch (e: any) {
                          responseBodyText = formatUnavailable(e?.message || 'response body capture failed');
                        }
                      }

                      const reqBodyText = want ? xhr.__ollama_sidekick_reqBodyText : undefined;
                      const reqTrunc = want ? xhr.__ollama_sidekick_reqTrunc === true : false;

                      emit({
                        ts,
                        kind: 'xhr',
                        method,
                        url,
                        status,
                        durationMs,
                        error: undefined,
                        requestBodyText: reqBodyText,
                        responseBodyText,
                        bodyTruncated: reqTrunc || resTrunc
                      });
                    } catch {
                      // ignore
                    }
                  },
                  { passive: true }
                );
                xhr.addEventListener(
                  'error',
                  () => {
                    try {
                      const start = typeof xhr.__ollama_sidekick_start === 'number' ? xhr.__ollama_sidekick_start : now();
                      const ts = start;
                      const durationMs = now() - start;
                      const method = typeof xhr.__ollama_sidekick_method === 'string' ? xhr.__ollama_sidekick_method : 'GET';
                      const url = typeof xhr.__ollama_sidekick_url === 'string' ? xhr.__ollama_sidekick_url : '';

                      const want = xhr.__ollama_sidekick_wantBodies__ === true;
                      const reqBodyText = want ? xhr.__ollama_sidekick_reqBodyText : undefined;
                      const reqTrunc = want ? xhr.__ollama_sidekick_reqTrunc === true : false;

                      emit({
                        ts,
                        kind: 'xhr',
                        method,
                        url,
                        status: null,
                        durationMs,
                        error: 'XHR error',
                        requestBodyText: reqBodyText,
                        responseBodyText: undefined,
                        bodyTruncated: reqTrunc
                      });
                    } catch {
                      // ignore
                    }
                  },
                  { passive: true }
                );
              }

              xhr.__ollama_sidekick_start = now();
            } catch {
              // ignore
            }

            return origSend.apply(this, args as any);
          };
        }
      } catch {
        // ignore
      }
    },
    args: [includeBodies]
  });
}

async function getModelsCached(baseUrl: string): Promise<string[]> {
  const now = Date.now();
  if (modelsCache && modelsCache.baseUrl === baseUrl && now - modelsCache.ts < 10_000) {
    return modelsCache.models;
  }
  const models = await listModels(baseUrl);
  modelsCache = { baseUrl, models, ts: now };
  return models;
}

function toErrorResponse(err: unknown): BackgroundResponse {
  if (err instanceof HttpError) {
    return {
      ok: false,
      type: 'ERROR',
      error: {
        message: err.message,
        status: err.details.status,
        url: err.details.url,
        hint: err.details.hint
      }
    };
  }

  return {
    ok: false,
    type: 'ERROR',
    error: { message: err instanceof Error ? err.message : String(err) }
  };
}

async function clearPopoutWindowIdIfMatches(windowId: number): Promise<void> {
  try {
    const data = await chrome.storage.session.get([SESSION_POPOUT_WINDOW_ID_KEY]);
    const existing = data?.[SESSION_POPOUT_WINDOW_ID_KEY];
    if (typeof existing !== 'number' || !Number.isFinite(existing)) return;
    if (existing !== windowId) return;
    await chrome.storage.session.remove([SESSION_POPOUT_WINDOW_ID_KEY]);
  } catch {
    // Best-effort.
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (typeof windowId !== 'number' || !Number.isFinite(windowId)) return;
  void clearPopoutWindowIdIfMatches(windowId);
});

async function getActiveTabId(): Promise<number> {
  // Avoid selecting extension windows / popups by constraining to normal windows.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (!tab?.id) throw new Error('No active browser tab found');
  return tab.id;
}

async function rememberLastUserTabId(tabId: number): Promise<void> {
  try {
    // We intentionally do not store URLs or page content; just the tab id pointer.
    // Tab URL access can also be restricted without the `tabs` permission.
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id) return;
    await chrome.storage.session.set({ [SESSION_LAST_USER_TAB_ID_KEY]: tab.id });
  } catch {
    // Best-effort only.
  }
}

async function rememberLastNormalWindowId(windowId: number): Promise<void> {
  if (!Number.isFinite(windowId)) return;
  lastFocusedNormalWindowId = windowId;
  try {
    await chrome.storage.session.set({ [SESSION_LAST_NORMAL_WINDOW_ID_KEY]: windowId });
  } catch {
    // Best-effort only.
  }
}

async function getRememberedLastUserTabId(): Promise<number | null> {
  try {
    const data = await chrome.storage.session.get([SESSION_LAST_USER_TAB_ID_KEY]);
    const tabId = data?.[SESSION_LAST_USER_TAB_ID_KEY];
    if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return null;
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id) return null;
    return tab.id;
  } catch {
    return null;
  }
}

async function getRememberedLastNormalWindowId(): Promise<number | null> {
  if (typeof lastFocusedNormalWindowId === 'number' && Number.isFinite(lastFocusedNormalWindowId)) {
    return lastFocusedNormalWindowId;
  }
  try {
    const data = await chrome.storage.session.get([SESSION_LAST_NORMAL_WINDOW_ID_KEY]);
    const windowId = data?.[SESSION_LAST_NORMAL_WINDOW_ID_KEY];
    if (typeof windowId !== 'number' || !Number.isFinite(windowId)) return null;
    return windowId;
  } catch {
    return null;
  }
}

async function getActiveTabIdInNormalWindow(windowId: number): Promise<number | null> {
  try {
    const win = await chrome.windows.get(windowId);
    if (!win || win.type !== 'normal') return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab?.id) return null;
    return tab.id;
  } catch {
    return null;
  }
}

async function getContextTabId(explicitTabId?: number): Promise<number> {
  if (typeof explicitTabId === 'number' && Number.isFinite(explicitTabId)) {
    try {
      const tab = await chrome.tabs.get(explicitTabId);
      if (tab?.id) return tab.id;
    } catch {
      // Fall through to best-effort resolution.
      // This can happen when the pop-out window URL includes a stale tabId
      // or when the extension doesn't currently have access to that tab.
    }
  }

  // Prefer the active tab in the last-focused *normal* browser window.
  const rememberedWinId = await getRememberedLastNormalWindowId();
  if (rememberedWinId != null) {
    const tabId = await getActiveTabIdInNormalWindow(rememberedWinId);
    if (tabId != null) {
      void rememberLastUserTabId(tabId);
      return tabId;
    }
  }

  // Fallback: ask Chrome which normal window was last focused.
  try {
    const normalWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (normalWin?.id != null) {
      void rememberLastNormalWindowId(normalWin.id);
      const tabId = await getActiveTabIdInNormalWindow(normalWin.id);
      if (tabId != null) {
        void rememberLastUserTabId(tabId);
        return tabId;
      }
    }
  } catch {
    // ignore
  }

  // Last-resort fallback: a previously seen tab id.
  const rememberedTab = await getRememberedLastUserTabId();
  if (rememberedTab != null) return rememberedTab;

  return getActiveTabId();
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

async function getTabInfo(explicitTabId?: number): Promise<TabInfo> {
  const tabId = await getContextTabId(explicitTabId);

  try {
    const tab = await chrome.tabs.get(tabId);
    const title = typeof tab?.title === 'string' ? normalizeWhitespace(tab.title) : '';
    const url = typeof tab?.url === 'string' ? tab.url : '';
    return { title, url };
  } catch {
    return { title: '', url: '' };
  }
}

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function getTabContext(opts: {
  maxChars?: number;
  explicitTabId?: number;
  includeSelection?: boolean;
  includeExcerpt?: boolean;
}) {
  const rawMax = typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars) ? opts.maxChars : 8000;
  const maxChars = Math.max(500, Math.min(20_000, Math.floor(rawMax)));

  const includeSelection = opts.includeSelection !== false;
  const includeExcerpt = opts.includeExcerpt !== false;

  const tabId = await getContextTabId(opts.explicitTabId);

  // Best-effort early detection (URL can be unavailable without `tabs` permission).
  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    url = '';
  }
  if (url && isRestrictedUrl(url)) {
    const hint = getRestrictedPageHint(url);
    throw new Error(hint ?? 'Context cannot be read on this page. Open a normal webpage and try again.');
  }

  // If the caller doesn't want any page text, avoid injection entirely.
  if (!includeSelection && !includeExcerpt) {
    const info = await getTabInfo(tabId);
    return {
      title: info.title,
      url: info.url,
      selection: '',
      textExcerpt: ''
    };
  }

  try {
    // Inject our content script on-demand (requires activeTab + scripting).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const hint =
      getRestrictedPageHint() ??
      'Context cannot be read on this page (Chrome Web Store / browser pages). Switch to a normal webpage and try again.';
    // Keep user-facing message clean and stable; raw details vary by browser.
    console.warn('Context injection failed', { tabId, error: raw });
    throw new Error(hint);
  }

  const response = await new Promise<any>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'CONTENT_CONTEXT_GET', maxChars, includeSelection, includeExcerpt }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(resp);
    });
  });

  if (!response?.ok) {
    throw new Error(response?.error?.message ?? 'Failed to extract tab context');
  }

  const result = response.context;
  return {
    title: normalizeWhitespace(String(result.title ?? '')),
    url: String(result.url ?? ''),
    selection: includeSelection ? String(result.selection ?? '') : '',
    textExcerpt: includeExcerpt ? String(result.textExcerpt ?? '') : ''
  };
}

function buildChatUrl(prefillPrompt: string, tabId?: number) {
  const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  url.searchParams.set('mode', 'window');
  url.searchParams.set('prompt', prefillPrompt);
  url.searchParams.set('auto', '1');
  if (typeof tabId === 'number' && Number.isFinite(tabId)) {
    url.searchParams.set('tabId', String(Math.floor(tabId)));
  }
  return url.toString();
}

async function openChatWindow(prefillPrompt: string, tabId?: number) {
  const data = await chrome.storage.local.get(['chatWinLeft', 'chatWinTop', 'chatWinWidth', 'chatWinHeight']);
  const left = typeof data.chatWinLeft === 'number' ? Math.round(data.chatWinLeft) : 80;
  const top = typeof data.chatWinTop === 'number' ? Math.round(data.chatWinTop) : 80;
  const width = typeof data.chatWinWidth === 'number' ? Math.round(data.chatWinWidth) : 520;
  const height = typeof data.chatWinHeight === 'number' ? Math.round(data.chatWinHeight) : 720;

  await chrome.windows.create({
    url: buildChatUrl(prefillPrompt, tabId),
    type: 'popup',
    left,
    top,
    width,
    height
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // Context menu for asking about selected text.
  chrome.contextMenus.create({
    id: 'ask-ollama-selection',
    title: 'Ask Ollama about selection',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ask-ollama-selection') return;
  const selection = (info.selectionText ?? '').trim();
  if (!selection) return;
  const tabId = tab?.id;
  if (typeof tabId === 'number') {
    void rememberLastUserTabId(tabId);
    if (typeof tab?.windowId === 'number') {
      void rememberLastNormalWindowId(tab.windowId);
    }
  }
  void openChatWindow(selection, typeof tabId === 'number' ? tabId : undefined);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    try {
      const win = await chrome.windows.get(activeInfo.windowId);
      if (win?.type !== 'normal') return;
      await rememberLastNormalWindowId(activeInfo.windowId);
      await rememberLastUserTabId(activeInfo.tabId);
    } catch {
      // ignore
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabConsoleCaptureEnabled.delete(tabId);
  tabConsoleLogs.delete(tabId);
  tabNetCaptureEnabled.delete(tabId);
  tabNetLogs.delete(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    try {
      const win = await chrome.windows.get(windowId);
      if (win?.type !== 'normal') return;
      await rememberLastNormalWindowId(windowId);
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.id) await rememberLastUserTabId(tab.id);
    } catch {
      // ignore
    }
  })();
});

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      if (!message || typeof message !== 'object' || typeof (message as any).type !== 'string') {
        const resp: BackgroundResponse = {
          ok: false,
          type: 'ERROR',
          error: { message: 'Invalid message' }
        };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'OLLAMA_LIST_MODELS') {
        const models = await listModels(settings.baseUrl);
        const resp: BackgroundResponse = { ok: true, type: 'OLLAMA_LIST_MODELS_RESULT', models };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'OLLAMA_MODEL_INFO_GET') {
        const model = typeof message.model === 'string' ? message.model.trim() : '';
        if (!model) {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'Invalid model' }
          };
          sendResponse(resp);
          return;
        }

        const data = await showModel(settings.baseUrl, model);
        const tokenBudget = extractTokenBudget(data);
        const resp: BackgroundResponse = { ok: true, type: 'OLLAMA_MODEL_INFO_GET_RESULT', model, tokenBudget };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'OLLAMA_GENERATE') {
        if (typeof message.prompt !== 'string') {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'Invalid prompt' }
          };
          sendResponse(resp);
          return;
        }

        // Prevent extremely large payloads from being sent to Ollama.
        if (message.prompt.length > 200_000) {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'Prompt too large' }
          };
          sendResponse(resp);
          return;
        }

        const requestedModel = typeof message.model === 'string' ? message.model.trim() : '';
        const savedModel = typeof settings.model === 'string' ? settings.model.trim() : '';

        let modelToUse = requestedModel || savedModel;
        try {
          const models = await getModelsCached(settings.baseUrl);
          if (models.length > 0) {
            if (!modelToUse || !models.includes(modelToUse)) {
              modelToUse = models[0];
            }
          }
        } catch {
          // If Ollama is down, we'll attempt with whatever model we have.
        }

        if (!modelToUse) {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'No model selected (and no models found in Ollama)' }
          };
          sendResponse(resp);
          return;
        }

        const result = await generate(settings.baseUrl, modelToUse, message.prompt);
        const resp: BackgroundResponse = { ok: true, type: 'OLLAMA_GENERATE_RESULT', text: result };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_INFO_GET') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined;
        const tab = await getTabInfo(tabId);
        const resp: BackgroundResponse = { ok: true, type: 'TAB_INFO_GET_RESULT', tab };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_TARGET_GET') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const explicitTabId = typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined;

        const tabId = await getContextTabId(explicitTabId);

        let title = '';
        let url = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          title = typeof tab?.title === 'string' ? normalizeWhitespace(tab.title) : '';
          url = typeof tab?.url === 'string' ? tab.url : '';
        } catch {
          title = '';
          url = '';
        }

        const restricted = Boolean(url && isRestrictedUrl(url));
        const hint = restricted ? getRestrictedPageHint(url) ?? 'This page is restricted (Chrome Web Store / browser pages).' : undefined;
        const domain = url ? getDomainFromUrl(url) : '';

        const resp: BackgroundResponse = {
          ok: true,
          type: 'TAB_TARGET_GET_RESULT',
          tabId,
          title,
          url,
          domain,
          restricted,
          hint
        };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONTEXT_GET') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined;
        const includeSelection = message.includeSelection !== false;
        const includeExcerpt = message.includeExcerpt !== false;
        const context = await getTabContext({
          maxChars: message.maxChars,
          explicitTabId: tabId,
          includeSelection,
          includeExcerpt
        });
        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONTEXT_GET_RESULT', context };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONSOLE_CAPTURE_START') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);

        // Best-effort restricted page detection (URL can be unavailable without `tabs` permission).
        let url = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          url = typeof tab?.url === 'string' ? tab.url : '';
        } catch {
          url = '';
        }
        if (url && isRestrictedUrl(url)) {
          const hint = getRestrictedPageHint(url);
          throw new Error(hint ?? 'Console capture cannot run on this page. Open a normal webpage and try again.');
        }

        await ensureContentScriptInjected(tabId);
        await injectConsoleHook(tabId);

        // Tell the content script to forward window.postMessage events.
        await sendToContentWithRetry(tabId, { type: 'CONTENT_CONSOLE_CAPTURE_SET', enabled: true });

        tabConsoleCaptureEnabled.set(tabId, true);
        if (!tabConsoleLogs.has(tabId)) tabConsoleLogs.set(tabId, []);

        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONSOLE_CAPTURE_START_RESULT', tabId, capturing: true };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONSOLE_CAPTURE_STOP') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);

        tabConsoleCaptureEnabled.set(tabId, false);
        await sendToContentWithRetry(tabId, { type: 'CONTENT_CONSOLE_CAPTURE_SET', enabled: false });

        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONSOLE_CAPTURE_STOP_RESULT', tabId, capturing: false };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_NET_CAPTURE_START') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);

        const includeBodies = (message as any).includeBodies === true;

        let url = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          url = typeof tab?.url === 'string' ? tab.url : '';
        } catch {
          url = '';
        }
        if (url && isRestrictedUrl(url)) {
          const hint = getRestrictedPageHint(url);
          throw new Error(hint ?? 'Network capture cannot run on this page. Open a normal webpage and try again.');
        }

        await ensureContentScriptInjected(tabId);
        await injectNetHook(tabId, includeBodies);

        await sendToContentWithRetry(tabId, { type: 'CONTENT_NET_CAPTURE_SET', enabled: true });

        tabNetCaptureEnabled.set(tabId, true);
        tabNetCaptureIncludeBodies.set(tabId, includeBodies);
        if (!tabNetLogs.has(tabId)) tabNetLogs.set(tabId, []);

        const resp: BackgroundResponse = { ok: true, type: 'TAB_NET_CAPTURE_START_RESULT', tabId, capturing: true };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_NET_CAPTURE_STOP') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);

        tabNetCaptureEnabled.set(tabId, false);
        tabNetCaptureIncludeBodies.set(tabId, false);
        await sendToContentWithRetry(tabId, { type: 'CONTENT_NET_CAPTURE_SET', enabled: false });

        const resp: BackgroundResponse = { ok: true, type: 'TAB_NET_CAPTURE_STOP_RESULT', tabId, capturing: false };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_NET_LOGS_GET') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);
        const capturing = tabNetCaptureEnabled.get(tabId) === true;
        const logs = getTabNetLogs(tabId);
        const resp: BackgroundResponse = {
          ok: true,
          type: 'TAB_NET_LOGS_GET_RESULT',
          tabId,
          capturing,
          logs: logs.slice()
        };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_NET_LOGS_CLEAR') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);
        tabNetLogs.set(tabId, []);
        const resp: BackgroundResponse = { ok: true, type: 'TAB_NET_LOGS_CLEAR_RESULT', tabId };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_NET_LOG_ENTRY') {
        const tabId = _sender?.tab?.id;
        if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'Network log entry missing sender tab context' }
          };
          sendResponse(resp);
          return;
        }

        if (tabNetCaptureEnabled.get(tabId) === true) {
          const raw = message.entry as any;
          const ts = typeof raw?.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now();
          const kindRaw = typeof raw?.kind === 'string' ? raw.kind : 'fetch';
          const kind = kindRaw === 'fetch' || kindRaw === 'xhr' ? kindRaw : 'fetch';
          const method = typeof raw?.method === 'string' ? raw.method : 'GET';
          const url = typeof raw?.url === 'string' ? raw.url : '';
          const status = typeof raw?.status === 'number' && Number.isFinite(raw.status) ? raw.status : null;
          const durationMs = typeof raw?.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null;
          const error = typeof raw?.error === 'string' ? raw.error : undefined;

          const wantBodies = tabNetCaptureIncludeBodies.get(tabId) === true;
          const requestBodyText = wantBodies && typeof raw?.requestBodyText === 'string' ? raw.requestBodyText : undefined;
          const responseBodyText = wantBodies && typeof raw?.responseBodyText === 'string' ? raw.responseBodyText : undefined;
          const bodyTruncated = wantBodies && raw?.bodyTruncated === true ? true : undefined;

          pushTabNetLog(tabId, {
            ts,
            kind,
            method,
            url,
            status,
            durationMs,
            error,
            requestBodyText,
            responseBodyText,
            bodyTruncated
          });
        }

        const resp: BackgroundResponse = { ok: true, type: 'TAB_NET_LOG_ENTRY_ACK', tabId };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONSOLE_LOGS_GET') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);
        const capturing = tabConsoleCaptureEnabled.get(tabId) === true;
        const logs = getTabConsoleLogs(tabId);
        const resp: BackgroundResponse = {
          ok: true,
          type: 'TAB_CONSOLE_LOGS_GET_RESULT',
          tabId,
          capturing,
          logs: logs.slice()
        };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONSOLE_LOGS_CLEAR') {
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = await getContextTabId(typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined);
        tabConsoleLogs.set(tabId, []);
        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONSOLE_LOGS_CLEAR_RESULT', tabId };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONSOLE_LOG_ENTRY') {
        const tabId = _sender?.tab?.id;
        if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
          const resp: BackgroundResponse = {
            ok: false,
            type: 'ERROR',
            error: { message: 'Console log entry missing sender tab context' }
          };
          sendResponse(resp);
          return;
        }

        if (tabConsoleCaptureEnabled.get(tabId) === true) {
          const raw = message.entry as any;
          const ts = typeof raw?.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now();
          const levelRaw = typeof raw?.level === 'string' ? raw.level : 'log';
          const level =
            levelRaw === 'log' || levelRaw === 'info' || levelRaw === 'warn' || levelRaw === 'error' || levelRaw === 'debug'
              ? levelRaw
              : 'log';
          const text = typeof raw?.text === 'string' ? raw.text : '';
          pushTabConsoleLog(tabId, { ts, level, text });
        }

        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONSOLE_LOG_ENTRY_ACK', tabId };
        sendResponse(resp);
        return;
      }

      const resp: BackgroundResponse = {
        ok: false,
        type: 'ERROR',
        error: { message: `Unknown message type: ${(message as any).type}` }
      };
      sendResponse(resp);
    } catch (err) {
      sendResponse(toErrorResponse(err));
    }
  })();

  // Keep the message channel open for async sendResponse
  return true;
});
