import type { BackgroundRequest, BackgroundResponse } from '../types/messages';
import { getSettings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return await chrome.runtime.sendMessage(message);
}

function redirect() {
  const current = new URL(location.href);
  const prompt = current.searchParams.get('prompt') ?? '';
  const auto = current.searchParams.get('auto') === '1';
  const chatId = current.searchParams.get('chatId');
  const popout = current.searchParams.get('popout') === '1';
  const tabId = current.searchParams.get('tabId');

  const next = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  next.searchParams.set('mode', popout ? 'window' : 'window');
  if (prompt) next.searchParams.set('prompt', prompt);
  if (auto) next.searchParams.set('auto', '1');
  if (chatId) next.searchParams.set('chatId', chatId);
  if (tabId) next.searchParams.set('tabId', tabId);

  location.replace(next.toString());
}

redirect();

