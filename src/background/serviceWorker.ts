import { getSettings } from '../lib/settings';
import { listModels, generate, HttpError } from '../lib/ollamaClient';
import { getRestrictedPageHint, isRestrictedUrl } from '../lib/restrictedUrl';
import type { BackgroundRequest, BackgroundResponse } from '../types/messages';

const SESSION_LAST_USER_TAB_ID_KEY = 'lastUserTabId';
const SESSION_LAST_NORMAL_WINDOW_ID_KEY = 'lastNormalWindowId';

let lastFocusedNormalWindowId: number | null = null;

let modelsCache:
  | {
      baseUrl: string;
      models: string[];
      ts: number;
    }
  | null = null;

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
    const tab = await chrome.tabs.get(explicitTabId);
    if (!tab?.id) throw new Error('No tab found for provided tabId');
    return tab.id;
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

async function getTabContext(maxChars = 8000, explicitTabId?: number) {
  const tabId = await getContextTabId(explicitTabId);

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

  try {
    // Inject our content script on-demand (requires activeTab + scripting).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const hint = getRestrictedPageHint() ??
      'Context cannot be read on this page (Chrome Web Store / browser pages). Switch to a normal webpage and try again.';
    // Keep user-facing message clean and stable; raw details vary by browser.
    console.warn('Context injection failed', { tabId, error: raw });
    throw new Error(hint);
  }

  const response = await new Promise<any>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'CONTENT_CONTEXT_GET', maxChars }, (resp) => {
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
    selection: String(result.selection ?? ''),
    textExcerpt: String(result.textExcerpt ?? '')
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

      if (message?.type === 'TAB_CONTEXT_GET') {
        const rawMax = typeof message.maxChars === 'number' && Number.isFinite(message.maxChars) ? message.maxChars : 8000;
        const maxChars = Math.max(500, Math.min(20_000, Math.floor(rawMax)));
        const rawTabId = typeof message.tabId === 'number' && Number.isFinite(message.tabId) ? message.tabId : undefined;
        const tabId = typeof rawTabId === 'number' ? Math.floor(rawTabId) : undefined;
        const context = await getTabContext(maxChars, tabId);
        const resp: BackgroundResponse = { ok: true, type: 'TAB_CONTEXT_GET_RESULT', context };
        sendResponse(resp);
        return;
      }

      const resp: BackgroundResponse = {
        ok: false,
        type: 'ERROR',
        error: { message: 'Unknown message type' }
      };
      sendResponse(resp);
    } catch (err) {
      sendResponse(toErrorResponse(err));
    }
  })();

  // Keep the message channel open for async sendResponse
  return true;
});
