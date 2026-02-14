import { getSettings } from '../lib/settings';
import { listModels, generate, HttpError } from '../lib/ollamaClient';
import type { BackgroundRequest, BackgroundResponse } from '../types/messages';

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
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

async function getTabContext(maxChars = 8000) {
  const tabId = await getActiveTabId();

  try {
    // Inject our content script on-demand (requires activeTab + scripting).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  } catch (e) {
    const hint =
      'Cannot run on this page (chrome://, brave://, extensions gallery, PDF viewer, etc). Try a normal webpage.';
    throw new Error(`${e instanceof Error ? e.message : String(e)}. ${hint}`);
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

function buildChatUrl(prefillPrompt: string) {
  const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  url.searchParams.set('mode', 'window');
  url.searchParams.set('prompt', prefillPrompt);
  url.searchParams.set('auto', '1');
  return url.toString();
}

async function openChatWindow(prefillPrompt: string) {
  const data = await chrome.storage.local.get(['chatWinLeft', 'chatWinTop', 'chatWinWidth', 'chatWinHeight']);
  const left = typeof data.chatWinLeft === 'number' ? Math.round(data.chatWinLeft) : 80;
  const top = typeof data.chatWinTop === 'number' ? Math.round(data.chatWinTop) : 80;
  const width = typeof data.chatWinWidth === 'number' ? Math.round(data.chatWinWidth) : 520;
  const height = typeof data.chatWinHeight === 'number' ? Math.round(data.chatWinHeight) : 720;

  await chrome.windows.create({
    url: buildChatUrl(prefillPrompt),
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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'ask-ollama-selection') return;
  const selection = (info.selectionText ?? '').trim();
  if (!selection) return;
  void openChatWindow(selection);
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
        const context = await getTabContext(maxChars);
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
