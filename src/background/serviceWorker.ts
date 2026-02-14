import { getSettings } from '../lib/settings';
import { listModels, generate, HttpError } from '../lib/ollamaClient';
import type { BackgroundRequest, BackgroundResponse } from '../types/messages';

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
  const base = chrome.runtime.getURL('src/chat/chat.html');
  const url = new URL(base);
  url.searchParams.set('prompt', prefillPrompt);
  url.searchParams.set('auto', '1');
  return url.toString();
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
  void chrome.tabs.create({ url: buildChatUrl(selection) });
});

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      if (message?.type === 'OLLAMA_LIST_MODELS') {
        const models = await listModels(settings.baseUrl);
        const resp: BackgroundResponse = { ok: true, type: 'OLLAMA_LIST_MODELS_RESULT', models };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'OLLAMA_GENERATE') {
        const model = message.model ?? settings.model;
        const result = await generate(settings.baseUrl, model, message.prompt);
        const resp: BackgroundResponse = { ok: true, type: 'OLLAMA_GENERATE_RESULT', text: result };
        sendResponse(resp);
        return;
      }

      if (message?.type === 'TAB_CONTEXT_GET') {
        const context = await getTabContext(message.maxChars ?? 8000);
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
