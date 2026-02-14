import type { BackgroundRequest, BackgroundResponse } from '../types/messages';
import { DEFAULT_SETTINGS, getSettings, setSettings, type Settings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';
import {
  appendMessage,
  createChat,
  createFolder,
  deleteChat,
  deleteFolder,
  ensureInitialized,
  getActiveChat,
  getChatSummaries,
  getFolders,
  getState,
  moveChatToFolder,
  renameChat,
  renameFolder,
  searchChats,
  setActiveChat,
  toggleFolderCollapsed,
  type ChatStoreStateV1,
  type ChatSummary,
  type StoredMessage
} from '../lib/chatStore';
import { getHistoryDirectoryHandle, setHistoryDirectoryHandle, clearHistoryDirectoryHandle } from '../lib/persistedHandles';
import {
  exportHistoryAsDownload,
  exportHistoryToDirectory,
  pickDirectory,
  supportsFileSystemAccessApi
} from '../lib/historyExportFs';
import { computeSidebarWidthExpanded } from '../lib/sidebarResizeMath';
import { tabTitleToChatTitle } from '../lib/tabTitleToChatTitle';
import { getChatIdForTab, setChatIdForTab } from '../lib/sessionTabChatMap';
import { buildPromptWithOptionalContext } from '../lib/promptWithContext';

const FOLDER_UNAVAILABLE_HINT =
  'Folder picker is not available in this browser. Use Export now (download), and enable “Ask where to save each file” in browser download settings if you want to pick a folder.';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return await chrome.runtime.sendMessage(message);
}

type PopupSize = { width: number; height: number };
type WindowBounds = { left: number; top: number; width: number; height: number };

type PageMode = 'popup' | 'window';

let pageMode: PageMode = 'popup';
let popupActiveTabId: number | null = null;

const SESSION_POPOUT_WINDOW_ID_KEY = 'popoutWindowId';
const SESSION_POPOUT_NAV_TAB_ID_KEY = 'popoutNavTabId';
const SESSION_POPOUT_NAV_NONCE_KEY = 'popoutNavNonce';

const POPUP_SIZE_DEFAULT: PopupSize = { width: 380, height: 600 };
const POPUP_SIZE_MIN: PopupSize = { width: 360, height: 420 };
const POPUP_SIZE_MAX: PopupSize = { width: 640, height: 900 };

const SIDEBAR_WIDTH_DEFAULT = 220;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 420;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getPageModeFromUrl(): PageMode {
  const url = new URL(location.href);
  return url.searchParams.get('mode') === 'window' ? 'window' : 'popup';
}

function getQueryStateFromUrl(): { chatId: string | null; prompt: string; auto: boolean } {
  const url = new URL(location.href);
  const chatId = url.searchParams.get('chatId');
  const prompt = url.searchParams.get('prompt') ?? '';
  const auto = url.searchParams.get('auto') === '1';
  return { chatId: chatId && chatId.trim() ? chatId : null, prompt, auto };
}

function getTabIdFromUrl(): number | null {
  const url = new URL(location.href);
  const raw = url.searchParams.get('tabId');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const tabId = Math.floor(n);
  return tabId > 0 ? tabId : null;
}

function getContextTargetTabId(): number | null {
  // Only use an explicit override when provided (e.g. opened from context menu).
  // Otherwise, let the background resolve the currently active browser tab each time.
  return getTabIdFromUrl();
}

async function getActiveTabInfo(explicitTabId?: number): Promise<{ title: string; url: string }> {
  const tabId = typeof explicitTabId === 'number' ? explicitTabId : getContextTargetTabId();
  const resp = await sendMessage({ type: 'TAB_INFO_GET', tabId: tabId ?? undefined });
  if (!resp.ok) return { title: '', url: '' };
  if (resp.type !== 'TAB_INFO_GET_RESULT') return { title: '', url: '' };
  return resp.tab;
}

async function getPopupActiveNormalTabId(): Promise<number | null> {
  if (typeof popupActiveTabId === 'number' && Number.isFinite(popupActiveTabId) && popupActiveTabId > 0) {
    return popupActiveTabId;
  }

  try {
    // Best-effort: should work for active tab when opening the action popup.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    const id = typeof tab?.id === 'number' && Number.isFinite(tab.id) ? tab.id : null;
    popupActiveTabId = id;
    return id;
  } catch {
    popupActiveTabId = null;
    return null;
  }
}

async function getSessionPopoutWindowId(): Promise<number | null> {
  try {
    const data = await chrome.storage.session.get([SESSION_POPOUT_WINDOW_ID_KEY]);
    const id = data?.[SESSION_POPOUT_WINDOW_ID_KEY];
    if (typeof id !== 'number' || !Number.isFinite(id)) return null;
    return id;
  } catch {
    return null;
  }
}

async function setSessionPopoutWindowId(windowId: number | null): Promise<void> {
  try {
    if (typeof windowId === 'number' && Number.isFinite(windowId)) {
      await chrome.storage.session.set({ [SESSION_POPOUT_WINDOW_ID_KEY]: windowId });
    } else {
      await chrome.storage.session.remove([SESSION_POPOUT_WINDOW_ID_KEY]);
    }
  } catch {
    // Best-effort.
  }
}

async function requestPopoutNavigateToTab(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.set({
      [SESSION_POPOUT_NAV_TAB_ID_KEY]: tabId,
      [SESSION_POPOUT_NAV_NONCE_KEY]: Date.now()
    });
  } catch {
    // Best-effort.
  }
}

async function buildPopoutUrlForTab(tabId: number | null): Promise<string> {
  const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  url.searchParams.set('mode', 'window');

  if (tabId != null) {
    url.searchParams.set('tabId', String(tabId));
    const mappedChatId = await getChatIdForTab(tabId);
    if (mappedChatId) url.searchParams.set('chatId', mappedChatId);
  } else {
    const activeChatId = getActiveChatId();
    if (activeChatId) url.searchParams.set('chatId', activeChatId);
  }

  return url.toString();
}

async function openOrFocusPopoutWindowForTab(tabId: number | null): Promise<void> {
  const existingId = await getSessionPopoutWindowId();
  if (existingId != null) {
    try {
      const win = await chrome.windows.get(existingId);
      if (win?.id == null) throw new Error('Missing pop-out window id');
      await chrome.windows.update(win.id, { focused: true });
      if (tabId != null) await requestPopoutNavigateToTab(tabId);
      return;
    } catch {
      // Stale id; fall through to creating a new window.
    }

    await setSessionPopoutWindowId(null);
  }

  const bounds = (await getSavedChatWindowBounds()) ?? {
    left: 80,
    top: 80,
    ...getCurrentPopupSize()
  };

  const created = await chrome.windows.create({
    url: await buildPopoutUrlForTab(tabId),
    type: 'popup',
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });

  if (created?.id != null) {
    await setSessionPopoutWindowId(created.id);
  }
}

function isEmptyConversation(chat: { messages: StoredMessage[] } | null): boolean {
  if (!chat) return false;
  return !chat.messages.some((m) => m.role === 'user' || m.role === 'assistant');
}

async function ensureChatForActiveTabOnOpen(): Promise<void> {
  if (pageMode !== 'popup') return;
  if (!chatStoreState) return;

  const tabId = await getPopupActiveNormalTabId();
  if (tabId == null) return;

  const mappedChatId = await getChatIdForTab(tabId);
  if (mappedChatId && chatStoreState.chats.some((c) => c.id === mappedChatId)) {
    if (chatStoreState.activeChatId !== mappedChatId) {
      await selectChat(mappedChatId);
    }
    return;
  }

  // Avoid creating a duplicate chat on a fresh install when ensureAtLeastOneChat() already created the first empty chat.
  const active = getActiveChat(chatStoreState);
  if (chatStoreState.chats.length === 1 && active && isEmptyConversation(active)) {
    void setChatIdForTab(tabId, active.id);
    return;
  }

  const folderId = active?.folderId ?? null;
  const { state: st, chatId } = await createChat(folderId);
  chatStoreState = st;

  try {
    const info = await getActiveTabInfo(tabId);
    const nextTitle = tabTitleToChatTitle(info.title);
    if (nextTitle) chatStoreState = await renameChat(chatId, nextTitle);
  } catch {
    // ignore
  }

  chatStoreState = await appendMessage(chatId, { role: 'system', text: 'Ready.', ts: Date.now() });
  void setChatIdForTab(tabId, chatId);
  await selectChat(chatId);
}

async function ensureChatForUrlTabOnOpen(): Promise<void> {
  if (!chatStoreState) return;

  // Window mode doesn't know the active browser tab; only act if we were given a tabId.
  const tabId = getTabIdFromUrl();
  if (tabId == null) return;

  const mappedChatId = await getChatIdForTab(tabId);
  if (mappedChatId && chatStoreState.chats.some((c) => c.id === mappedChatId)) {
    if (chatStoreState.activeChatId !== mappedChatId) {
      await selectChat(mappedChatId);
    }
    return;
  }

  const active = getActiveChat(chatStoreState);
  const folderId = active?.folderId ?? null;
  const { state: st, chatId } = await createChat(folderId);
  chatStoreState = st;

  try {
    const info = await getActiveTabInfo(tabId);
    const nextTitle = tabTitleToChatTitle(info.title);
    if (nextTitle) chatStoreState = await renameChat(chatId, nextTitle);
  } catch {
    // ignore
  }

  chatStoreState = await appendMessage(chatId, { role: 'system', text: 'Ready.', ts: Date.now() });
  void setChatIdForTab(tabId, chatId);
  await selectChat(chatId);
}

function canAutoNameChatFromTab(chat: { title: string; messages: StoredMessage[] } | null): boolean {
  if (!chat) return false;
  if (chat.title !== 'New chat') return false;
  // Allow initial system messages (e.g. "Ready."), but don't rename real conversations.
  return !chat.messages.some((m) => m.role === 'user' || m.role === 'assistant');
}

async function maybeAutoNameActiveChatFromTabTitle(): Promise<void> {
  if (!chatStoreState) return;
  const active = getActiveChat(chatStoreState);
  if (!canAutoNameChatFromTab(active)) return;

  try {
    const info = await getActiveTabInfo();
    const nextTitle = tabTitleToChatTitle(info.title);
    if (!nextTitle) return;
    chatStoreState = await renameChat(active!.id, nextTitle);
  } catch {
    // Best-effort only; chat naming shouldn't block UI.
  }
}

async function getSavedSidebarPrefs(): Promise<{ width: number; collapsed: boolean }> {
  const data = await chrome.storage.local.get(['sidebarWidth', 'sidebarCollapsed']);
  const widthRaw = typeof data.sidebarWidth === 'number' ? data.sidebarWidth : SIDEBAR_WIDTH_DEFAULT;
  const collapsed = data.sidebarCollapsed === true;
  return {
    width: clamp(Math.round(widthRaw), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
    collapsed
  };
}

async function saveSidebarWidth(width: number): Promise<void> {
  await chrome.storage.local.set({ sidebarWidth: clamp(Math.round(width), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX) });
}

async function saveSidebarCollapsed(collapsed: boolean): Promise<void> {
  await chrome.storage.local.set({ sidebarCollapsed: collapsed });
}

function applySidebarPrefs(prefs: { width: number; collapsed: boolean }) {
  document.documentElement.style.setProperty('--sidebar-width-expanded', `${prefs.width}px`);
  if (prefs.collapsed) {
    document.documentElement.dataset.sidebarCollapsed = '1';
  } else {
    delete document.documentElement.dataset.sidebarCollapsed;
  }

  const toggle = document.getElementById('sidebarToggleBtn') as HTMLButtonElement | null;
  if (toggle) {
    toggle.title = prefs.collapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-label', prefs.collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    // Flip chevron direction by rotating the SVG.
    const svg = toggle.querySelector('svg') as SVGElement | null;
    if (svg) svg.style.transform = prefs.collapsed ? 'rotate(180deg)' : '';
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function getSavedChatWindowBounds(): Promise<WindowBounds | null> {
  const data = await chrome.storage.local.get(['chatWinLeft', 'chatWinTop', 'chatWinWidth', 'chatWinHeight']);
  const left = typeof data.chatWinLeft === 'number' ? data.chatWinLeft : null;
  const top = typeof data.chatWinTop === 'number' ? data.chatWinTop : null;
  const width = typeof data.chatWinWidth === 'number' ? data.chatWinWidth : null;
  const height = typeof data.chatWinHeight === 'number' ? data.chatWinHeight : null;
  if (left == null || top == null || width == null || height == null) return null;
  return { left, top, width, height };
}

async function getSavedPopupSize(): Promise<PopupSize | null> {
  const data = await chrome.storage.local.get(['popupWidth', 'popupHeight']);
  const width = typeof data.popupWidth === 'number' ? data.popupWidth : null;
  const height = typeof data.popupHeight === 'number' ? data.popupHeight : null;
  if (width == null || height == null) return null;
  return { width, height };
}

async function savePopupSize(size: PopupSize): Promise<void> {
  await chrome.storage.local.set({ popupWidth: size.width, popupHeight: size.height });
}

function applyPopupSize(size: PopupSize) {
  const width = clamp(Math.round(size.width), POPUP_SIZE_MIN.width, POPUP_SIZE_MAX.width);
  const height = clamp(Math.round(size.height), POPUP_SIZE_MIN.height, POPUP_SIZE_MAX.height);

  document.documentElement.style.setProperty('--popup-width', `${width}px`);
  document.documentElement.style.setProperty('--popup-height', `${height}px`);

  // Extra forcing for extension popup sizing behavior.
  document.documentElement.style.width = `${width}px`;
  document.documentElement.style.height = `${height}px`;
  document.body.style.width = `${width}px`;
  document.body.style.height = `${height}px`;

  const app = document.querySelector('.app') as HTMLElement | null;
  if (app) {
    app.style.width = `${width}px`;
    app.style.height = `${height}px`;
  }
}

function formatError(resp: Extract<BackgroundResponse, { ok: false }>): string {
  const parts: string[] = [resp.error.message];
  if (resp.error.status) parts.push(`Status: ${resp.error.status}`);
  if (resp.error.url) parts.push(`URL: ${resp.error.url}`);
  if (resp.error.hint) parts.push(`Hint: ${resp.error.hint}`);
  return parts.join('\n');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err != null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

// Note: tab targeting is handled in the background so pop-out remains browser-aware.

type ChatRole = 'user' | 'assistant' | 'system' | 'error';
type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  pending?: boolean;
};

type TabContext = {
  title: string;
  url: string;
  selection: string;
  textExcerpt: string;
};

const CUSTOM_MODEL_VALUE = '__custom__';

type SettingsModelUiSync = {
  isOpen: () => boolean;
  syncModel: (model: string) => void;
  refreshModels: () => Promise<void>;
};

let settingsModelUiSync: SettingsModelUiSync | null = null;

let chatStoreState: ChatStoreStateV1 | null = null;
const draftsByChatId = new Map<string, string>();

type PromptHistoryNavState = {
  chatId: string | null;
  index: number | null;
  draftBeforeHistory: string;
  applying: boolean;
  composing: boolean;
};

const promptHistoryNav: PromptHistoryNavState = {
  chatId: null,
  index: null,
  draftBeforeHistory: '',
  applying: false,
  composing: false
};

const state: { messages: ChatMessage[]; generating: boolean } = {
  messages: [],
  generating: false
};

function uid() {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addMessageWithId(role: ChatRole, text: string, id: string, pending = false): string {
  state.messages.push({ id, role, text, ts: Date.now(), pending });
  renderChat();
  return id;
}

function scrollChatToBottom() {
  const chat = $('chat') as HTMLElement;
  chat.scrollTop = chat.scrollHeight;
}

function renderMessageText(container: HTMLElement, text: string) {
  // Simple fenced-code handling without a markdown parser.
  // Split by ``` and alternate between plain and code blocks.
  const parts = text.split('```');
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    if (!segment) continue;

    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.textContent = segment.replace(/^\n/, '').replace(/\n$/, '');
      container.appendChild(pre);
    } else {
      const p = document.createElement('div');
      p.className = 'text';
      p.textContent = segment;
      container.appendChild(p);
    }
  }
}

function renderChat() {
  const chat = $('chat') as HTMLElement;
  chat.innerHTML = '';

  for (const msg of state.messages) {
    const row = document.createElement('div');
    row.className = `msgRow role-${msg.role}`;

    const bubble = document.createElement('div');
    bubble.className = `bubble${msg.pending ? ' pending' : ''}`;

    renderMessageText(bubble, msg.text);

    row.appendChild(bubble);
    chat.appendChild(row);
  }

  scrollChatToBottom();
}

function addMessage(role: ChatRole, text: string, pending = false): string {
  const id = uid();
  state.messages.push({ id, role, text, ts: Date.now(), pending });
  renderChat();
  return id;
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) return;
  Object.assign(msg, patch);
  renderChat();
}

function removeMessage(id: string) {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  state.messages.splice(idx, 1);
  renderChat();
}

function setGenerating(isGenerating: boolean) {
  state.generating = isGenerating;
  const btn = $('generateBtn') as HTMLButtonElement;
  const prompt = $('prompt') as HTMLTextAreaElement;
  btn.disabled = isGenerating;
  prompt.disabled = isGenerating;
  btn.classList.toggle('isLoading', isGenerating);
}

function fmtRelativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'Just now';
  if (d < 60 * 60_000) return `${Math.round(d / 60_000)}m`;
  if (d < 24 * 60 * 60_000) return `${Math.round(d / (60 * 60_000))}h`;
  return `${Math.round(d / (24 * 60 * 60_000))}d`;
}

function getActiveChatId(): string | null {
  return chatStoreState?.activeChatId ?? null;
}

function resetPromptHistoryNav(nextChatId: string | null) {
  if (promptHistoryNav.chatId === nextChatId) return;
  promptHistoryNav.chatId = nextChatId;
  promptHistoryNav.index = null;
  promptHistoryNav.draftBeforeHistory = '';
  promptHistoryNav.applying = false;
}

function clearPromptHistoryNav() {
  promptHistoryNav.index = null;
  promptHistoryNav.draftBeforeHistory = '';
  promptHistoryNav.applying = false;
}

function buildUserPromptHistoryForActiveChat(): string[] {
  if (!chatStoreState) return [];
  const chat = getActiveChat(chatStoreState);
  if (!chat) return [];

  const history: string[] = [];
  let last: string | null = null;
  for (const m of chat.messages as StoredMessage[]) {
    if (m.role !== 'user') continue;
    const text = typeof m.text === 'string' ? m.text : '';
    if (!text.trim()) continue;
    if (last === text) continue;
    history.push(text);
    last = text;
  }
  return history;
}

function caretIsOnFirstLine(el: HTMLTextAreaElement): boolean {
  if (el.selectionStart !== el.selectionEnd) return false;
  const pos = el.selectionStart;
  if (pos <= 0) return true;
  return el.value.lastIndexOf('\n', pos - 1) === -1;
}

function caretIsOnLastLine(el: HTMLTextAreaElement): boolean {
  if (el.selectionStart !== el.selectionEnd) return false;
  const pos = el.selectionStart;
  if (pos >= el.value.length) return true;
  return el.value.indexOf('\n', pos) === -1;
}

function applyPromptValue(el: HTMLTextAreaElement, value: string) {
  promptHistoryNav.applying = true;
  el.value = value;
  autoGrowTextarea(el);
  const end = el.value.length;
  try {
    el.setSelectionRange(end, end);
  } catch {
    // ignore
  }
}

function handlePromptHistoryKey(el: HTMLTextAreaElement, direction: 'up' | 'down'): boolean {
  if (promptHistoryNav.composing) return false;

  const activeChatId = getActiveChatId();
  resetPromptHistoryNav(activeChatId);
  const history = buildUserPromptHistoryForActiveChat();
  if (history.length === 0) return false;

  if (direction === 'up') {
    if (!caretIsOnFirstLine(el)) return false;

    if (promptHistoryNav.index == null) {
      promptHistoryNav.draftBeforeHistory = el.value;
      promptHistoryNav.index = history.length - 1;
    } else {
      promptHistoryNav.index = Math.max(0, promptHistoryNav.index - 1);
    }

    const idx = Math.min(promptHistoryNav.index, history.length - 1);
    promptHistoryNav.index = idx;
    applyPromptValue(el, history[idx] ?? '');
    return true;
  }

  // down
  if (promptHistoryNav.index == null) return false;
  if (!caretIsOnLastLine(el)) return false;

  if (promptHistoryNav.index < history.length - 1) {
    promptHistoryNav.index++;
    applyPromptValue(el, history[promptHistoryNav.index] ?? '');
    return true;
  }

  // Past the newest: restore draft.
  const draft = promptHistoryNav.draftBeforeHistory;
  clearPromptHistoryNav();
  applyPromptValue(el, draft);
  return true;
}

function getActiveChatTitle(): string {
  const c = chatStoreState ? getActiveChat(chatStoreState) : null;
  return c?.title ?? 'Chat';
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (maxChars <= 1) return '…';
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function setTruncatedText(el: HTMLElement, fullText: string, maxChars: number) {
  const full = (fullText ?? '').trim();
  el.textContent = truncateWithEllipsis(full, maxChars);
  // Keep full value accessible via native tooltip.
  el.title = full;
}

function setActiveChatTitleUi() {
  const el = document.getElementById('chatTitle') as HTMLDivElement | null;
  if (!el) return;
  setTruncatedText(el, getActiveChatTitle(), 42);
}

function setMessagesFromActiveChat() {
  if (!chatStoreState) return;
  const chat = getActiveChat(chatStoreState);
  state.messages = [];
  if (!chat) {
    renderChat();
    return;
  }

  for (const m of chat.messages) {
    addMessageWithId(m.role as ChatRole, m.text, m.id, false);
  }
}

function renderFolderSelect() {
  const select = document.getElementById('chatFolderSelect') as HTMLSelectElement | null;
  if (!select || !chatStoreState) return;

  const active = getActiveChat(chatStoreState);
  const folders = getFolders(chatStoreState);
  select.innerHTML = '';

  const optInbox = document.createElement('option');
  optInbox.value = '';
  optInbox.textContent = 'Inbox';
  select.appendChild(optInbox);

  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    select.appendChild(opt);
  }

  select.value = active?.folderId ?? '';
}

function renderSidebar() {
  const container = document.getElementById('sidebarList') as HTMLDivElement | null;
  if (!container || !chatStoreState) return;

  const searchEl = document.getElementById('chatSearch') as HTMLInputElement | null;
  const query = (searchEl?.value ?? '').trim();

  const folders = getFolders(chatStoreState);
  const folderById = new Map(folders.map((f) => [f.id, f] as const));

  const summaries: ChatSummary[] = query ? searchChats(chatStoreState, query) : getChatSummaries(chatStoreState);
  const byFolder = new Map<string | null, ChatSummary[]>();
  for (const s of summaries) {
    const key = s.folderId ?? null;
    const arr = byFolder.get(key) ?? [];
    arr.push(s);
    byFolder.set(key, arr);
  }

  const activeChatId = getActiveChatId();
  container.innerHTML = '';

  const mkSvg = (kind: 'rename' | 'delete') => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'iconSvg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');

    const mkPath = (d: string, extra: Record<string, string> = {}) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v);
      return p;
    };

    if (kind === 'rename') {
      svg.appendChild(mkPath('M3 13h3l7-7-3-3-7 7v3Z', { 'stroke-width': '1.2', 'stroke-linejoin': 'round' }));
      svg.appendChild(mkPath('M9.5 4.5 11.5 6.5', { 'stroke-width': '1.2', 'stroke-linecap': 'round' }));
    } else {
      svg.appendChild(
        mkPath('M3.5 5h9M6.2 5V3.8c0-.4.3-.8.8-.8h2c.4 0 .8.3.8.8V5', {
          'stroke-width': '1.2',
          'stroke-linecap': 'round'
        })
      );
      svg.appendChild(
        mkPath('M5.5 5.5v7c0 .6.4 1 1 1h3c.6 0 1-.4 1-1v-7', {
          'stroke-width': '1.2',
          'stroke-linejoin': 'round'
        })
      );
      svg.appendChild(
        mkPath('M7 7.2v4.6M9 7.2v4.6', {
          'stroke-width': '1.2',
          'stroke-linecap': 'round'
        })
      );
    }

    return svg;
  };

  const renderChatList = (list: ChatSummary[]) => {
    const wrap = document.createElement('div');
    wrap.className = 'chatList';
    for (const c of list) {
      const row = document.createElement('div');
      row.className = `chatRow${c.id === activeChatId ? ' isActive' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chatItem${c.id === activeChatId ? ' isActive' : ''}`;
      btn.dataset.chatId = c.id;
      btn.draggable = true;

      const title = document.createElement('div');
      title.className = 'chatItemTitle';
      setTruncatedText(title, c.title, 36);

      const meta = document.createElement('div');
      meta.className = 'chatItemMeta';
      const snippet = c.lastSnippet || '—';
      meta.textContent = `${fmtRelativeTime(c.updatedAt)} · ${truncateWithEllipsis(snippet, 60)}`;

      btn.appendChild(title);
      btn.appendChild(meta);

      const tools = document.createElement('div');
      tools.className = 'chatTools';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'iconBtn small';
      renameBtn.title = 'Rename chat';
      renameBtn.setAttribute('aria-label', 'Rename chat');
      renameBtn.dataset.action = 'chat-rename';
      renameBtn.dataset.chatId = c.id;
      renameBtn.appendChild(mkSvg('rename'));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'iconBtn small';
      delBtn.title = 'Delete chat';
      delBtn.setAttribute('aria-label', 'Delete chat');
      delBtn.dataset.action = 'chat-delete';
      delBtn.dataset.chatId = c.id;
      delBtn.appendChild(mkSvg('delete'));

      tools.appendChild(renameBtn);
      tools.appendChild(delBtn);

      row.appendChild(btn);
      row.appendChild(tools);
      wrap.appendChild(row);
    }
    return wrap;
  };

  const renderFolderBlock = (
    folderId: string | null,
    name: string,
    collapsed: boolean,
    showTools: boolean
  ) => {
    const block = document.createElement('div');
    block.className = 'folderBlock';

    const header = document.createElement('div');
    header.className = 'folderHeader';
    header.dataset.dropFolderId = folderId ?? '';

    const headerBtn = document.createElement('button');
    headerBtn.type = 'button';
    headerBtn.className = 'folderHeaderBtn';
    headerBtn.textContent = `${collapsed ? '▶' : '▼'} ${name}`;
    if (folderId) headerBtn.dataset.toggleFolderId = folderId;
    header.appendChild(headerBtn);

    const tools = document.createElement('div');
    tools.className = 'folderTools';

    if (showTools && folderId) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'iconBtn small';
      renameBtn.title = 'Rename folder';
      renameBtn.setAttribute('aria-label', 'Rename folder');
      renameBtn.dataset.action = 'folder-rename';
      renameBtn.dataset.folderId = folderId;
      renameBtn.appendChild(mkSvg('rename'));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'iconBtn small';
      delBtn.title = 'Delete folder';
      delBtn.setAttribute('aria-label', 'Delete folder');
      delBtn.dataset.action = 'folder-delete';
      delBtn.dataset.folderId = folderId;
      delBtn.appendChild(mkSvg('delete'));

      tools.appendChild(renameBtn);
      tools.appendChild(delBtn);
    }

    header.appendChild(tools);
    block.appendChild(header);

    const list = byFolder.get(folderId) ?? [];
    if (!collapsed) {
      block.appendChild(renderChatList(list));
    }

    return block;
  };

  // Inbox first.
  container.appendChild(renderFolderBlock(null, 'Inbox', false, false));

  for (const f of folders) {
    const list = byFolder.get(f.id) ?? [];
    // Hide empty folders when searching to reduce clutter.
    if (query && list.length === 0) continue;
    container.appendChild(renderFolderBlock(f.id, f.name, !!f.collapsed, true));
  }

  // If there are chats only in Inbox and query is empty, ensure the list shows those.
  // (We rendered Inbox above, but it used byFolder which may be empty.)
  // Re-render Inbox list accurately:
  const first = container.firstElementChild as HTMLDivElement | null;
  if (first) {
    const inboxChats = byFolder.get(null) ?? [];
    const header = first.querySelector('.folderHeaderBtn') as HTMLButtonElement | null;
    const existingList = first.querySelector('.chatList');
    if (existingList) existingList.remove();
    header && (header.textContent = `▼ Inbox`);
    first.appendChild(renderChatList(inboxChats));
  }
}

async function selectChat(chatId: string) {
  if (!chatStoreState) return;

  const promptEl = document.getElementById('prompt') as HTMLTextAreaElement | null;
  const prev = getActiveChatId();
  if (promptEl && prev) draftsByChatId.set(prev, promptEl.value);

  chatStoreState = await setActiveChat(chatId);
  setActiveChatTitleUi();
  renderFolderSelect();
  setMessagesFromActiveChat();
  renderSidebar();

  if (promptEl) {
    promptEl.value = draftsByChatId.get(chatId) ?? '';
    autoGrowTextarea(promptEl);
    promptEl.focus();
  }

  resetPromptHistoryNav(chatId);

  // In popup mode, keep per-tab chat mapping aligned with the user's selection.
  if (pageMode === 'popup') {
    void (async () => {
      const tabId = await getPopupActiveNormalTabId();
      if (tabId != null) await setChatIdForTab(tabId, chatId);
    })();
  } else {
    const tabId = getTabIdFromUrl();
    if (tabId != null) void setChatIdForTab(tabId, chatId);
  }
}

async function ensureAtLeastOneChat() {
  chatStoreState = await ensureInitialized();
  if (!chatStoreState.chats.length) {
    const { state, chatId } = await createChat(null);
    chatStoreState = state;

    // Name the first chat after the active tab, best-effort.
    try {
      const info = await getActiveTabInfo();
      const nextTitle = tabTitleToChatTitle(info.title);
      if (nextTitle) chatStoreState = await renameChat(chatId, nextTitle);
    } catch {
      // ignore
    }

    // Persist a system message only once per created chat.
    chatStoreState = await appendMessage(chatId, {
      role: 'system',
      text: 'Ready.',
      ts: Date.now()
    });
  }
  if (!chatStoreState.activeChatId && chatStoreState.chats.length) {
    // Pick most recent.
    const summaries = getChatSummaries(chatStoreState);
    if (summaries[0]) chatStoreState = await setActiveChat(summaries[0].id);
  }
}

function getMaxHeightPx(el: HTMLElement): number | null {
  const maxHeight = getComputedStyle(el).maxHeight;
  if (!maxHeight || maxHeight === 'none') return null;
  const px = Number.parseFloat(maxHeight);
  return Number.isFinite(px) ? px : null;
}

function getCssVarPx(name: string): number | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return null;
  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function getCurrentPopupSize(): PopupSize {
  const app = document.querySelector('.app') as HTMLElement | null;
  const rect = app?.getBoundingClientRect();
  const rectWidth = rect && rect.width > 0 ? rect.width : null;
  const rectHeight = rect && rect.height > 0 ? rect.height : null;
  return {
    width: getCssVarPx('--popup-width') ?? rectWidth ?? document.body.getBoundingClientRect().width ?? POPUP_SIZE_DEFAULT.width,
    height: getCssVarPx('--popup-height') ?? rectHeight ?? document.body.getBoundingClientRect().height ?? POPUP_SIZE_DEFAULT.height
  };
}

function setupPopupResize() {
  const bar = document.getElementById('resizeBar') as HTMLDivElement | null;
  if (!bar) return;
  const grip = document.getElementById('resizeGrip') as HTMLDivElement | null;

  type Mode = 'height' | 'width' | 'both';

  const finish = () => {
    document.body.classList.remove('resizing', 'both');
    const size = getCurrentPopupSize();
    void savePopupSize({
      width: clamp(Math.round(size.width), POPUP_SIZE_MIN.width, POPUP_SIZE_MAX.width),
      height: clamp(Math.round(size.height), POPUP_SIZE_MIN.height, POPUP_SIZE_MAX.height)
    });
  };

  const startDrag = (mode: Mode, startX: number, startY: number) => {
    const start = getCurrentPopupSize();
    document.body.classList.add('resizing');
    if (mode === 'both') document.body.classList.add('both');

    const onMove = (clientX: number, clientY: number) => {
      const dx = clientX - startX;
      const dy = clientY - startY;
      applyPopupSize({
        width: mode === 'width' || mode === 'both' ? start.width + dx : start.width,
        height: mode === 'height' || mode === 'both' ? start.height + dy : start.height
      });
    };

    // Mouse fallback (most reliable in extension popups)
    const onMouseMove = (ev: MouseEvent) => onMove(ev.clientX, ev.clientY);
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      finish();
    };

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
  };

  const onBarMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();

    const edge = 28;
    const inRightEdge = ev.offsetX >= bar.clientWidth - edge;
    const mode: Mode = ev.shiftKey ? 'both' : inRightEdge ? 'width' : 'height';
    startDrag(mode, ev.clientX, ev.clientY);
  };

  const onGripMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    startDrag('both', ev.clientX, ev.clientY);
  };

  // Pointer events for touch / trackpads.
  const onPointerDown = (mode: Mode) => (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();

    const startX = ev.clientX;
    const startY = ev.clientY;
    const start = getCurrentPopupSize();
    document.body.classList.add('resizing');
    if (mode === 'both') document.body.classList.add('both');

    const target = ev.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    const onMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      applyPopupSize({
        width: mode === 'width' || mode === 'both' ? start.width + dx : start.width,
        height: mode === 'height' || mode === 'both' ? start.height + dy : start.height
      });
    };

    const onUp = (upEv: PointerEvent) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      try {
        target.releasePointerCapture(upEv.pointerId);
      } catch {
        // ignore
      }
      finish();
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  bar.addEventListener('mousedown', onBarMouseDown);
  bar.addEventListener('pointerdown', (ev) => {
    const edge = 28;
    const mode: Mode = ev.shiftKey ? 'both' : ev.offsetX >= bar.clientWidth - edge ? 'width' : 'height';
    onPointerDown(mode)(ev);
  });
  if (grip) {
    grip.addEventListener('mousedown', onGripMouseDown);
    grip.addEventListener('pointerdown', onPointerDown('both'));
  }
}

function startWindowBoundsPersistence(mode: PageMode) {
  if (mode !== 'window') return;

  const save = () => {
    chrome.windows.getCurrent((win) => {
      if (!win) return;
      const left = typeof win.left === 'number' ? win.left : undefined;
      const top = typeof win.top === 'number' ? win.top : undefined;
      const width = typeof win.width === 'number' ? win.width : undefined;
      const height = typeof win.height === 'number' ? win.height : undefined;
      if (left == null || top == null || width == null || height == null) return;
      void chrome.storage.local.set({
        chatWinLeft: left,
        chatWinTop: top,
        chatWinWidth: width,
        chatWinHeight: height
      });
    });
  };

  save();
  const t = window.setInterval(save, 1500);
  window.addEventListener('beforeunload', () => {
    window.clearInterval(t);
    save();
  });
}

function startPopoutNavigationListener(): void {
  if (pageMode !== 'window') return;

  let lastSeenNonce: number | null = null;

  const maybeNavigate = async (tabId: number) => {
    const current = getTabIdFromUrl();
    if (current === tabId) return;

    const mappedChatId = await getChatIdForTab(tabId);

    const url = new URL(location.href);
    url.searchParams.set('mode', 'window');
    url.searchParams.set('tabId', String(tabId));
    if (mappedChatId) url.searchParams.set('chatId', mappedChatId);
    else url.searchParams.delete('chatId');

    // Avoid accidental auto-send when switching contexts.
    url.searchParams.delete('prompt');
    url.searchParams.delete('auto');

    location.href = url.toString();
  };

  const checkNow = async () => {
    try {
      const data = await chrome.storage.session.get([
        SESSION_POPOUT_NAV_TAB_ID_KEY,
        SESSION_POPOUT_NAV_NONCE_KEY
      ]);

      const nonceRaw = data?.[SESSION_POPOUT_NAV_NONCE_KEY];
      const nonce = typeof nonceRaw === 'number' && Number.isFinite(nonceRaw) ? nonceRaw : null;
      const tabIdRaw = data?.[SESSION_POPOUT_NAV_TAB_ID_KEY];
      const tabId = typeof tabIdRaw === 'number' && Number.isFinite(tabIdRaw) ? Math.floor(tabIdRaw) : null;
      if (nonce == null || tabId == null || tabId <= 0) return;

      if (lastSeenNonce == null) {
        // Initialize without navigating on stale values.
        lastSeenNonce = nonce;
        return;
      }

      if (nonce === lastSeenNonce) return;
      lastSeenNonce = nonce;
      await maybeNavigate(tabId);
    } catch {
      // ignore
    }
  };

  // Primary: listen for changes.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') return;
    if (!changes[SESSION_POPOUT_NAV_NONCE_KEY]) return;
    void checkNow();
  });

  // Fallback: poll in case the event is missed.
  void checkNow();
  const t = window.setInterval(() => void checkNow(), 500);
  window.addEventListener('beforeunload', () => window.clearInterval(t));
}

function setupSettingsModal(onSaved: () => void) {
  const overlay = document.getElementById('settingsOverlay') as HTMLDivElement | null;
  const openBtn = document.getElementById('settingsBtn') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('settingsCloseBtn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('settingsCancelBtn') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('settingsSaveBtn') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('settingsResetBtn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('settingsStatus') as HTMLSpanElement | null;

  const baseUrlEl = document.getElementById('settingsBaseUrl') as HTMLInputElement | null;
  const modelSelectEl = document.getElementById('settingsModelSelect') as HTMLSelectElement | null;
  const modelCustomEl = document.getElementById('settingsModelCustom') as HTMLInputElement | null;
  const themeEl = document.getElementById('settingsTheme') as HTMLSelectElement | null;
  const fontEl = document.getElementById('settingsFontFamily') as HTMLSelectElement | null;
  const sizeEl = document.getElementById('settingsFontSize') as HTMLInputElement | null;

  const historyModeEl = document.getElementById('settingsHistoryStorageMode') as HTMLSelectElement | null;
  const historyFormatEl = document.getElementById('settingsHistoryExportFormat') as HTMLSelectElement | null;
  const historyFolderRow = document.getElementById('settingsHistoryFolderRow') as HTMLDivElement | null;
  const chooseHistoryFolderBtn = document.getElementById('settingsChooseHistoryFolderBtn') as HTMLButtonElement | null;
  const clearHistoryFolderBtn = document.getElementById('settingsClearHistoryFolderBtn') as HTMLButtonElement | null;
  const historyFolderStatusEl = document.getElementById('settingsHistoryFolderStatus') as HTMLSpanElement | null;
  const exportHistoryBtn = document.getElementById('settingsExportHistoryBtn') as HTMLButtonElement | null;
  const historyExportStatusEl = document.getElementById('settingsHistoryExportStatus') as HTMLSpanElement | null;

  if (!overlay || !openBtn || !closeBtn || !cancelBtn || !saveBtn || !resetBtn) return;
  if (!baseUrlEl || !modelSelectEl || !modelCustomEl || !themeEl || !fontEl || !sizeEl || !statusEl) return;
  if (!historyModeEl || !historyFormatEl) return;
  if (!historyFolderRow || !chooseHistoryFolderBtn || !clearHistoryFolderBtn || !historyFolderStatusEl) return;
  if (!exportHistoryBtn || !historyExportStatusEl) return;

  let lastLoaded: Settings | null = null;

  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  const setHistoryStatus = (text: string) => {
    historyExportStatusEl.textContent = text;
  };

  const refreshHistoryFolderStatus = async () => {
    const handle = await getHistoryDirectoryHandle();
    historyFolderStatusEl.textContent = handle ? 'Folder selected.' : 'No folder selected.';
  };

  const updateHistoryUi = () => {
    const mode = historyModeEl.value as Settings['historyStorageMode'];
    historyFolderRow.style.display = mode === 'folder' && supportsFileSystemAccessApi() ? 'flex' : 'none';
  };

  const setModelUiMode = (mode: 'select' | 'custom') => {
    const showCustom = mode === 'custom';
    modelCustomEl.hidden = !showCustom;
    modelSelectEl.hidden = showCustom;
  };

  const populateModelUi = async (savedModel: string) => {
    const models = await fetchModels();

    modelSelectEl.innerHTML = '';

    if (models.length === 0) {
      // Ollama unreachable or returned no models; still allow a custom model name.
      setModelUiMode('custom');
      modelCustomEl.value = savedModel;
      return;
    }

    // Model list available.
    setModelUiMode('select');

    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      modelSelectEl.appendChild(opt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM_MODEL_VALUE;
    customOpt.textContent = 'Custom…';
    modelSelectEl.appendChild(customOpt);

    const saved = savedModel.trim();
    const effectiveModel = saved && models.includes(saved) ? saved : models[0];
    modelSelectEl.value = effectiveModel;
    modelCustomEl.value = effectiveModel;
    modelCustomEl.hidden = true;

    if (effectiveModel !== saved) {
      // Persist immediately so the extension doesn't keep using a missing model.
      await setSettings({ model: effectiveModel });
    }
  };

  const getSelectedModelFromUi = (): string => {
    if (!modelSelectEl.hidden) {
      if (modelSelectEl.value === CUSTOM_MODEL_VALUE) return modelCustomEl.value.trim();
      return modelSelectEl.value.trim();
    }
    return modelCustomEl.value.trim();
  };

  const populate = async () => {
    const s = await getSettings();
    lastLoaded = s;
    baseUrlEl.value = s.baseUrl;
    await populateModelUi(s.model);
    themeEl.value = s.theme;
    fontEl.value = s.fontFamily;
    sizeEl.value = String(s.fontSize);

    historyModeEl.value = s.historyStorageMode;
    historyFormatEl.value = s.historyExportFormat;

    // If folder picking isn't supported, disable the option and auto-heal to local.
    const folderSupported = supportsFileSystemAccessApi();
    const folderOpt = Array.from(historyModeEl.options).find((o) => o.value === 'folder');
    if (folderOpt) folderOpt.disabled = !folderSupported;

    if (!folderSupported) {
      if (s.historyStorageMode === 'folder') {
        await setSettings({ historyStorageMode: 'local' });
        const healed = await getSettings();
        historyModeEl.value = healed.historyStorageMode;
        historyFormatEl.value = healed.historyExportFormat;
      }
    }

    updateHistoryUi();
    await refreshHistoryFolderStatus();
    setHistoryStatus('');
  };

  const open = async () => {
    setStatus('');
    await populate();
    overlay.hidden = false;
    overlay.style.display = 'grid';
    baseUrlEl.focus();
    baseUrlEl.select();
  };

  const close = () => {
    overlay.hidden = true;
    overlay.style.display = 'none';
    setStatus('');
    openBtn.focus();
  };

  const syncModelToUi = (model: string) => {
    // If modal isn't open, don't do any work.
    if (overlay.hidden) return;

    if (modelSelectEl.hidden) {
      modelCustomEl.value = model;
      return;
    }

    // When select is visible, try to set it to the model if present, otherwise fall back to Custom.
    const hasModelOption = Array.from(modelSelectEl.options).some((o) => o.value === model);
    if (hasModelOption) {
      modelSelectEl.value = model;
      modelCustomEl.value = model;
      modelCustomEl.hidden = true;
    } else {
      modelSelectEl.value = CUSTOM_MODEL_VALUE;
      modelCustomEl.value = model;
      modelCustomEl.hidden = false;
    }
  };

  settingsModelUiSync = {
    isOpen: () => !overlay.hidden,
    syncModel: syncModelToUi,
    refreshModels: async () => {
      const s = await getSettings();
      await populateModelUi(s.model);
    }
  };

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });

  document.addEventListener('keydown', (ev) => {
    if (overlay.hidden) return;
    if (ev.key === 'Escape') close();
  });

  modelSelectEl.addEventListener('change', () => {
    if (modelSelectEl.value === CUSTOM_MODEL_VALUE) {
      modelCustomEl.hidden = false;
      modelCustomEl.focus();
      modelCustomEl.select();
    } else {
      modelCustomEl.hidden = true;
      modelCustomEl.value = modelSelectEl.value;
    }
  });

  // Ensure hidden overlays are not accidentally left visible due to CSS.
  overlay.style.display = overlay.hidden ? 'none' : 'grid';

  historyModeEl.addEventListener('change', () => {
    updateHistoryUi();
  });

  chooseHistoryFolderBtn.addEventListener('click', () => {
    setHistoryStatus('');
    chooseHistoryFolderBtn.disabled = true;
    Promise.resolve()
      .then(async () => {
        if (!supportsFileSystemAccessApi()) throw new Error(FOLDER_UNAVAILABLE_HINT);
        const dir = await pickDirectory();
        await setHistoryDirectoryHandle(dir);
        await refreshHistoryFolderStatus();
        setHistoryStatus('Folder selected.');
      })
      .catch((e) => setHistoryStatus(errorMessage(e)))
      .finally(() => {
        chooseHistoryFolderBtn.disabled = false;
      });
  });

  clearHistoryFolderBtn.addEventListener('click', () => {
    setHistoryStatus('');
    clearHistoryFolderBtn.disabled = true;
    Promise.resolve()
      .then(async () => {
        await clearHistoryDirectoryHandle();
        await refreshHistoryFolderStatus();
        setHistoryStatus('Folder cleared.');
      })
      .catch((e) => setHistoryStatus(errorMessage(e)))
      .finally(() => {
        clearHistoryFolderBtn.disabled = false;
      });
  });

  exportHistoryBtn.addEventListener('click', () => {
    setHistoryStatus('');
    exportHistoryBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        const mode = historyModeEl.value as Settings['historyStorageMode'];
        const format = historyFormatEl.value as Settings['historyExportFormat'];
        const state = await getState();

        if (mode === 'folder' && supportsFileSystemAccessApi()) {
          const existing = await getHistoryDirectoryHandle();
          const dir = existing ?? (await pickDirectory());
          if (!existing) {
            await setHistoryDirectoryHandle(dir);
            await refreshHistoryFolderStatus();
          }
          const res = await exportHistoryToDirectory(dir, state, format);
          setHistoryStatus(`Exported ${res.filesWritten} file(s).`);
          return;
        }

        const dl = exportHistoryAsDownload(state, format);
        setHistoryStatus(
          mode === 'folder' && !supportsFileSystemAccessApi()
            ? `Downloaded ${dl.fileName}. (${FOLDER_UNAVAILABLE_HINT})`
            : `Downloaded ${dl.fileName}.`
        );
      })
      .catch((e) => setHistoryStatus(errorMessage(e)))
      .finally(() => {
        exportHistoryBtn.disabled = false;
      });
  });

  openBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void open();
  });
  closeBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    close();
  });
  cancelBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    close();
  });

  saveBtn.addEventListener('click', () => {
    setStatus('');
    setHistoryStatus('');
    saveBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        const baseUrl = baseUrlEl.value.trim();
        const model = getSelectedModelFromUi();
        const theme = themeEl.value as Settings['theme'];
        const fontFamily = fontEl.value as Settings['fontFamily'];
        const fontSize = Number.parseInt(sizeEl.value, 10);

        const historyStorageMode = historyModeEl.value as Settings['historyStorageMode'];
        const historyExportFormat = historyFormatEl.value as Settings['historyExportFormat'];

        if (!baseUrl || !isValidHttpUrl(baseUrl)) throw new Error('Base URL must be http(s)://…');
        if (!model) throw new Error('Default model cannot be empty');
        if (!Number.isFinite(fontSize) || fontSize < 11 || fontSize > 20) throw new Error('Font size must be 11–20');

        await setSettings({
          baseUrl,
          model,
          theme,
          fontFamily,
          fontSize,
          historyStorageMode,
          historyExportFormat
        });
        const s = await getSettings();
        lastLoaded = s;
        applyUiSettings(s);
        onSaved();
        // Ensure the UI reflects the stored default model.
        syncModelToUi(s.model);
        // Close immediately after saving to keep the popup uncluttered.
        close();
      })
      .catch((e) => {
        setStatus(errorMessage(e));
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  resetBtn.addEventListener('click', () => {
    setStatus('');
    setHistoryStatus('');
    resetBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        await setSettings(DEFAULT_SETTINGS);
        const s = await getSettings();
        lastLoaded = s;
        applyUiSettings(s);
        onSaved();

        baseUrlEl.value = s.baseUrl;
        await populateModelUi(s.model);
        themeEl.value = s.theme;
        fontEl.value = s.fontFamily;
        sizeEl.value = String(s.fontSize);

        historyModeEl.value = s.historyStorageMode;
        historyFormatEl.value = s.historyExportFormat;
        updateHistoryUi();
        await refreshHistoryFolderStatus();
        setStatus('Reset.');
      })
      .catch((e) => setStatus(errorMessage(e)))
      .finally(() => {
        resetBtn.disabled = false;
      });
  });
}

function autoGrowTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const max = getMaxHeightPx(el);
  const height = max == null ? el.scrollHeight : Math.min(el.scrollHeight, max);
  el.style.height = `${height}px`;
}

function setContextBadge(text: string, visible: boolean) {
  const badge = document.getElementById('contextBadge') as HTMLSpanElement | null;
  if (!badge) return;
  badge.hidden = !visible;
  badge.textContent = text;
}

function formatContextAttachError(err: unknown): string {
  const msg = errorMessage(err).trim();

  // Keep it short and friendly for restricted pages.
  const lower = msg.toLowerCase();
  const looksRestricted =
    lower.includes('cannot be scripted') ||
    lower.includes('cannot run on this page') ||
    lower.includes('cannot access a chrome://') ||
    lower.includes('extensions gallery');

  if (looksRestricted) {
    return 'Context cannot be read on this page (Chrome Web Store / browser pages). Switch to a normal webpage and try again.';
  }

  return msg;
}

async function getTabContext(maxChars = 8000): Promise<TabContext> {
  const tabId = getContextTargetTabId();
  const resp = await sendMessage({ type: 'TAB_CONTEXT_GET', maxChars, tabId: tabId ?? undefined });
  if (!resp.ok) throw new Error(formatError(resp));
  if (resp.type !== 'TAB_CONTEXT_GET_RESULT') throw new Error('Unexpected response while reading tab context');
  return resp.context;
}

async function loadModels() {
  const modelSelect = $('modelSelect') as HTMLSelectElement;
  modelSelect.innerHTML = '';

  const settings = await getSettings();

  const models = await fetchModels();
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No models found (is Ollama running?)';
    modelSelect.appendChild(opt);
    modelSelect.value = '';
    return;
  }

  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    modelSelect.appendChild(opt);
  }

  const saved = settings.model.trim();
  const effectiveModel = saved && models.includes(saved) ? saved : models[0];
  modelSelect.value = effectiveModel;

  if (effectiveModel !== saved) {
    // Auto-heal stored settings so we don't keep sending a missing model.
    await setSettings({ model: effectiveModel });
    // Keep settings modal in sync if it's open.
    settingsModelUiSync?.syncModel(effectiveModel);
  }
}

async function fetchModels(): Promise<string[]> {
  try {
    const resp = await sendMessage({ type: 'OLLAMA_LIST_MODELS' });
    if (!resp.ok) return [];
    if (resp.type !== 'OLLAMA_LIST_MODELS_RESULT') return [];
    return Array.isArray(resp.models) ? resp.models : [];
  } catch {
    return [];
  }
}

async function onGenerate() {
  if (state.generating) return;

  if (!chatStoreState) {
    chatStoreState = await getState();
  }
  const activeChatId = getActiveChatId();
  if (!activeChatId) return;

  const promptEl = $('prompt') as HTMLTextAreaElement;
  const prompt = promptEl.value;
  const model = ($('modelSelect') as HTMLSelectElement).value;

  const trimmed = prompt.trim();
  if (!trimmed) return;

  // Sending a message exits prompt history navigation.
  clearPromptHistoryNav();

  promptEl.value = '';
  autoGrowTextarea(promptEl);

  // Persist only what the user typed (not the injected context).
  const userMsgId = uid();
  const userMessage: Omit<StoredMessage, 'id'> = { role: 'user', text: trimmed, ts: Date.now(), model };
  chatStoreState = await appendMessage(activeChatId, { ...userMessage, id: userMsgId });
  addMessageWithId('user', trimmed, userMsgId);

  const thinkingId = addMessage('assistant', 'Thinking…', true);
  setGenerating(true);

  try {
    let finalPrompt = trimmed;
    try {
      const ctx = await getTabContext(8000);
      finalPrompt = buildPromptWithOptionalContext(trimmed, ctx);
      setContextBadge('Context attached', true);
      setTimeout(() => setContextBadge('Context Aware', true), 1500);
    } catch (e) {
      // Context is best-effort; show a system message and continue without it.
      const text = `Context not attached: ${formatContextAttachError(e)}`;
      const id = uid();
      chatStoreState = await appendMessage(activeChatId, { role: 'system', text, ts: Date.now(), id });
      addMessageWithId('system', text, id);
      setContextBadge('Context unavailable', true);
      setTimeout(() => setContextBadge('Context Aware', true), 2000);
    }

    const resp = await sendMessage({ type: 'OLLAMA_GENERATE', prompt: finalPrompt, model });
    if (!resp.ok) {
      removeMessage(thinkingId);
      const text = formatError(resp);
      const id = uid();
      chatStoreState = await appendMessage(activeChatId, { role: 'error', text, ts: Date.now(), model, id });
      addMessageWithId('error', text, id);
      setActiveChatTitleUi();
      renderSidebar();
      return;
    }

    if (resp.type !== 'OLLAMA_GENERATE_RESULT') {
      removeMessage(thinkingId);
      const text = 'Unexpected response while generating';
      const id = uid();
      chatStoreState = await appendMessage(activeChatId, { role: 'error', text, ts: Date.now(), model, id });
      addMessageWithId('error', text, id);
      setActiveChatTitleUi();
      renderSidebar();
      return;
    }

    removeMessage(thinkingId);
    const text = resp.text || '(empty response)';
    const id = uid();
    chatStoreState = await appendMessage(activeChatId, { role: 'assistant', text, ts: Date.now(), model, id });
    addMessageWithId('assistant', text, id);
    setActiveChatTitleUi();
    renderSidebar();
  } catch (e) {
    removeMessage(thinkingId);
    const text = errorMessage(e);
    const id = uid();
    chatStoreState = await appendMessage(activeChatId, { role: 'error', text, ts: Date.now(), model, id });
    addMessageWithId('error', text, id);
    setActiveChatTitleUi();
    renderSidebar();
  } finally {
    setGenerating(false);
    promptEl.focus();
  }
}

async function main() {
  const mode = getPageModeFromUrl();
  pageMode = mode;
  document.documentElement.dataset.mode = mode;

  startPopoutNavigationListener();

  if (mode !== 'window') {
    applyPopupSize((await getSavedPopupSize()) ?? POPUP_SIZE_DEFAULT);
    setupPopupResize();
  } else {
    startWindowBoundsPersistence(mode);
  }

  // Always open/focus the pop-out window when the user clicks the extension icon.
  // MV3 requires a user gesture; the action popup open provides it.
  if (mode === 'popup') {
    const tabId = await getPopupActiveNormalTabId();
    await openOrFocusPopoutWindowForTab(tabId);
    window.close();
    return;
  }

  // Apply theme + typography ASAP.
  const settings = await getSettings();
  applyUiSettings(settings);

  const btn = $('generateBtn') as HTMLButtonElement;
  const promptEl = $('prompt') as HTMLTextAreaElement;
  const modelSelect = $('modelSelect') as HTMLSelectElement;

  btn.addEventListener('click', () => void onGenerate());

  setupSettingsModal(() => {
    // Reload models if base URL / default model changed.
    void loadModels();
  });

  modelSelect.addEventListener('change', () => {
    const model = modelSelect.value;
    void setSettings({ model });
    settingsModelUiSync?.syncModel(model);
  });

  promptEl.addEventListener('compositionstart', () => {
    promptHistoryNav.composing = true;
  });
  promptEl.addEventListener('compositionend', () => {
    promptHistoryNav.composing = false;
  });

  promptEl.addEventListener('input', () => {
    autoGrowTextarea(promptEl);
    // If the user types after selecting a history item, exit navigation.
    if (promptHistoryNav.applying) {
      promptHistoryNav.applying = false;
      return;
    }
    clearPromptHistoryNav();
  });
  promptEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp') {
      if (handlePromptHistoryKey(promptEl, 'up')) {
        ev.preventDefault();
        return;
      }
    }

    if (ev.key === 'ArrowDown') {
      if (handlePromptHistoryKey(promptEl, 'down')) {
        ev.preventDefault();
        return;
      }
    }

    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void onGenerate();
    }
  });

  autoGrowTextarea(promptEl);
  setGenerating(false);

  applySidebarPrefs(await getSavedSidebarPrefs());

  await ensureAtLeastOneChat();

  // When reopening the popup on a different tab, switch/create a new chat for that tab.
  await ensureChatForActiveTabOnOpen();

  // In window mode, optionally switch/create a chat for the provided tabId.
  await ensureChatForUrlTabOnOpen();

  setActiveChatTitleUi();
  renderFolderSelect();
  setMessagesFromActiveChat();
  renderSidebar();

  // Context is always-on by default.
  setContextBadge('Context Aware', true);

  try {
    await loadModels();
  } catch (e) {
    addMessage('error', `Failed to load models. Is Ollama running?\n${errorMessage(e)}`);
  }

  // URL param support (used by context-menu open and window-mode deep links)
  const qs = getQueryStateFromUrl();
  if (qs.chatId && qs.chatId !== getActiveChatId()) {
    await selectChat(qs.chatId);
  }

  // Auto-name a brand-new chat from the active tab title.
  await maybeAutoNameActiveChatFromTabTitle();
  setActiveChatTitleUi();
  renderSidebar();

  if (qs.prompt.trim()) {
    promptEl.value = qs.prompt;
    autoGrowTextarea(promptEl);
    if (qs.auto) {
      await onGenerate();
    }
  }

  // Sidebar interactions
  const sidebar = document.getElementById('sidebarList') as HTMLDivElement | null;
  const newChatBtn = document.getElementById('newChatBtn') as HTMLButtonElement | null;
  const newFolderBtn = document.getElementById('newFolderBtn') as HTMLButtonElement | null;
  const searchEl = document.getElementById('chatSearch') as HTMLInputElement | null;

  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn') as HTMLButtonElement | null;
  const splitter = document.getElementById('sidebarSplitter') as HTMLDivElement | null;

  const folderSelect = document.getElementById('chatFolderSelect') as HTMLSelectElement | null;
  const renameChatBtn = document.getElementById('renameChatBtn') as HTMLButtonElement | null;
  const deleteChatBtn = document.getElementById('deleteChatBtn') as HTMLButtonElement | null;

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      void (async () => {
        const prefs = await getSavedSidebarPrefs();
        const next = { ...prefs, collapsed: !prefs.collapsed };
        applySidebarPrefs(next);
        await saveSidebarCollapsed(next.collapsed);
      })();
    });
  }

  if (splitter) {
    const expandIfCollapsed = () => {
      if (document.documentElement.dataset.sidebarCollapsed === '1') {
        delete document.documentElement.dataset.sidebarCollapsed;
        void saveSidebarCollapsed(false);
      }
    };

    const startDrag = (startClientX: number) => {
      expandIfCollapsed();
      const startWidth = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
      document.body.classList.add('resizingSidebar');

      const apply = (clientX: number) => {
        const next = computeSidebarWidthExpanded(startWidth, startClientX, clientX, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
        document.documentElement.style.setProperty('--sidebar-width-expanded', `${next}px`);
      };

      const finish = () => {
        document.body.classList.remove('resizingSidebar');
        const width = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
        void saveSidebarWidth(width);
      };

      // Mouse fallback (more reliable in extension popups).
      const onMouseMove = (ev: MouseEvent) => apply(ev.clientX);
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);
        finish();
      };

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
    };

    splitter.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      startDrag(ev.clientX);
    });

    splitter.addEventListener('pointerdown', (ev) => {
      // Use pointer events for touch/pen; mouse uses mousedown above.
      if (ev.pointerType === 'mouse') return;
      ev.preventDefault();
      expandIfCollapsed();

      const startX = ev.clientX;
      const startWidth = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
      document.body.classList.add('resizingSidebar');

      try {
        splitter.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      const onMove = (moveEv: PointerEvent) => {
        const next = computeSidebarWidthExpanded(startWidth, startX, moveEv.clientX, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
        document.documentElement.style.setProperty('--sidebar-width-expanded', `${next}px`);
      };

      const onUp = (upEv: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        document.body.classList.remove('resizingSidebar');
        try {
          splitter.releasePointerCapture(upEv.pointerId);
        } catch {
          // ignore
        }
        const width = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
        void saveSidebarWidth(width);
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });

    splitter.addEventListener('keydown', (ev) => {
      if (document.documentElement.dataset.sidebarCollapsed === '1') return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const cur = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
      const next = clamp(cur + (ev.key === 'ArrowRight' ? 10 : -10), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
      document.documentElement.style.setProperty('--sidebar-width-expanded', `${next}px`);
      void saveSidebarWidth(next);
    });
  }

  if (searchEl) {
    searchEl.addEventListener('input', () => renderSidebar());
  }

  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      void (async () => {
        if (!chatStoreState) return;
        const active = getActiveChat(chatStoreState);
        const folderId = active?.folderId ?? null;
        const { state: st, chatId } = await createChat(folderId);
        chatStoreState = st;
        await (async () => {
          try {
            const info = await getActiveTabInfo();
            const nextTitle = tabTitleToChatTitle(info.title);
            if (nextTitle) chatStoreState = await renameChat(chatId, nextTitle);
          } catch {
            // ignore
          }
        })();
        chatStoreState = await appendMessage(chatId, { role: 'system', text: 'Ready.', ts: Date.now() });
        await selectChat(chatId);
      })();
    });
  }

  if (newFolderBtn) {
    newFolderBtn.addEventListener('click', () => {
      void (async () => {
        const name = prompt('Folder name?', 'New folder') ?? '';
        if (!name.trim()) return;
        const res = await createFolder(name);
        chatStoreState = res.state;
        renderFolderSelect();
        renderSidebar();
      })();
    });
  }

  if (sidebar) {
    sidebar.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const chatBtn = target.closest('.chatItem') as HTMLButtonElement | null;
      if (chatBtn?.dataset.chatId) {
        void selectChat(chatBtn.dataset.chatId);
        return;
      }

      const folderHeaderBtn = target.closest('.folderHeaderBtn') as HTMLButtonElement | null;
      if (folderHeaderBtn?.dataset.toggleFolderId) {
        void (async () => {
          chatStoreState = await toggleFolderCollapsed(folderHeaderBtn.dataset.toggleFolderId!);
          renderSidebar();
        })();
        return;
      }

      const actionBtn = target.closest('button[data-action]') as HTMLButtonElement | null;
      if (actionBtn?.dataset.action) {
        if (actionBtn.dataset.action === 'folder-rename' && actionBtn.dataset.folderId) {
          const folderId = actionBtn.dataset.folderId;
          void (async () => {
            const f = chatStoreState?.folders.find((x) => x.id === folderId);
            const name = prompt('Rename folder', f?.name ?? '') ?? '';
            if (!name.trim()) return;
            chatStoreState = await renameFolder(folderId, name);
            renderFolderSelect();
            renderSidebar();
          })();
          return;
        }

        if (actionBtn.dataset.action === 'folder-delete' && actionBtn.dataset.folderId) {
          const folderId = actionBtn.dataset.folderId;
          void (async () => {
            const f = chatStoreState?.folders.find((x) => x.id === folderId);
            const ok = confirm(`Delete folder "${f?.name ?? 'Folder'}"? Chats will be moved to Inbox.`);
            if (!ok) return;
            chatStoreState = await deleteFolder(folderId);
            renderFolderSelect();
            renderSidebar();
          })();
          return;
        }

        if (actionBtn.dataset.action === 'chat-rename' && actionBtn.dataset.chatId) {
          const chatId = actionBtn.dataset.chatId;
          void (async () => {
            if (!chatStoreState) return;
            const chat = chatStoreState.chats.find((c) => c.id === chatId);
            const title = prompt('Rename chat', chat?.title ?? '') ?? '';
            if (!title.trim()) return;
            chatStoreState = await renameChat(chatId, title);
            if (getActiveChatId() === chatId) setActiveChatTitleUi();
            renderSidebar();
          })();
          return;
        }

        if (actionBtn.dataset.action === 'chat-delete' && actionBtn.dataset.chatId) {
          const chatId = actionBtn.dataset.chatId;
          void (async () => {
            if (!chatStoreState) return;
            const chat = chatStoreState.chats.find((c) => c.id === chatId);
            const ok = confirm(`Delete chat "${chat?.title ?? 'Chat'}"?`);
            if (!ok) return;

            const wasActive = getActiveChatId() === chatId;
            chatStoreState = await deleteChat(chatId);

            if (wasActive) {
              // Pick new active if needed
              if (chatStoreState.activeChatId) {
                await selectChat(chatStoreState.activeChatId);
              } else if (chatStoreState.chats.length) {
                const summaries = getChatSummaries(chatStoreState);
                if (summaries[0]) await selectChat(summaries[0].id);
              } else {
                await ensureAtLeastOneChat();
                if (chatStoreState?.activeChatId) await selectChat(chatStoreState.activeChatId);
              }
            }

            renderFolderSelect();
            renderSidebar();
            setActiveChatTitleUi();
          })();
          return;
        }
      }
    });

    // Drag & drop: move chats into folders
    let dropHeader: HTMLDivElement | null = null;
    const clearDrop = () => {
      if (dropHeader) dropHeader.classList.remove('isDropTarget');
      dropHeader = null;
    };

    sidebar.addEventListener('dragstart', (ev) => {
      const t = ev.target as HTMLElement;
      const chatEl = t.closest('.chatItem') as HTMLButtonElement | null;
      if (!chatEl?.dataset.chatId) return;
      if (!ev.dataTransfer) return;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('application/x-ollama-sidekick', JSON.stringify({ type: 'chat', chatId: chatEl.dataset.chatId }));
    });

    sidebar.addEventListener('dragover', (ev) => {
      const t = ev.target as HTMLElement;
      const header = t.closest('.folderHeader') as HTMLDivElement | null;
      if (!header) return;
      // Allow drop
      ev.preventDefault();
      if (dropHeader !== header) {
        clearDrop();
        dropHeader = header;
        dropHeader.classList.add('isDropTarget');
      }
    });

    sidebar.addEventListener('dragleave', (ev) => {
      const t = ev.target as HTMLElement;
      const header = t.closest('.folderHeader') as HTMLDivElement | null;
      if (!header) return;
      // If leaving the current target header, clear.
      if (dropHeader === header) {
        clearDrop();
      }
    });

    sidebar.addEventListener('drop', (ev) => {
      void (async () => {
        const t = ev.target as HTMLElement;
        const header = t.closest('.folderHeader') as HTMLDivElement | null;
        if (!header) return;
        if (!ev.dataTransfer) return;
        const raw = ev.dataTransfer.getData('application/x-ollama-sidekick');
        if (!raw) return;
        let chatId: string | null = null;
        try {
          const parsed = JSON.parse(raw) as { type?: string; chatId?: string };
          if (parsed.type === 'chat' && typeof parsed.chatId === 'string') chatId = parsed.chatId;
        } catch {
          // ignore
        }
        if (!chatId) return;

        ev.preventDefault();
        clearDrop();

        const folderId = header.dataset.dropFolderId || null;
        chatStoreState = await moveChatToFolder(chatId, folderId);
        renderFolderSelect();
        renderSidebar();
        setActiveChatTitleUi();
      })();
    });

    sidebar.addEventListener('dragend', () => clearDrop());
  }

  if (folderSelect) {
    folderSelect.addEventListener('change', () => {
      void (async () => {
        const id = getActiveChatId();
        if (!id) return;
        const folderId = folderSelect.value || null;
        chatStoreState = await moveChatToFolder(id, folderId);
        renderFolderSelect();
        renderSidebar();
        setActiveChatTitleUi();
      })();
    });
  }

  if (renameChatBtn) {
    renameChatBtn.addEventListener('click', () => {
      void (async () => {
        const id = getActiveChatId();
        if (!id || !chatStoreState) return;
        const chat = getActiveChat(chatStoreState);
        const title = prompt('Rename chat', chat?.title ?? '') ?? '';
        if (!title.trim()) return;
        chatStoreState = await renameChat(id, title);
        setActiveChatTitleUi();
        renderSidebar();
      })();
    });
  }

  if (deleteChatBtn) {
    deleteChatBtn.addEventListener('click', () => {
      void (async () => {
        const id = getActiveChatId();
        if (!id) return;
        const ok = confirm('Delete this chat?');
        if (!ok) return;
        chatStoreState = await deleteChat(id);
        // Pick new active if needed
        if (chatStoreState.activeChatId) {
          await selectChat(chatStoreState.activeChatId);
        } else if (chatStoreState.chats.length) {
          const summaries = getChatSummaries(chatStoreState);
          if (summaries[0]) await selectChat(summaries[0].id);
        } else {
          await ensureAtLeastOneChat();
          if (chatStoreState?.activeChatId) await selectChat(chatStoreState.activeChatId);
        }
        renderFolderSelect();
        renderSidebar();
      })();
    });
  }
}

main().catch((e) => {
  addMessage('error', errorMessage(e));
});
