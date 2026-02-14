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

function getActiveChatTitle(): string {
  const c = chatStoreState ? getActiveChat(chatStoreState) : null;
  return c?.title ?? 'Chat';
}

function setActiveChatTitleUi() {
  const el = document.getElementById('chatTitle') as HTMLDivElement | null;
  if (!el) return;
  el.textContent = getActiveChatTitle();
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

  const optUnfiled = document.createElement('option');
  optUnfiled.value = '';
  optUnfiled.textContent = 'Unfiled';
  select.appendChild(optUnfiled);

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
      title.textContent = c.title;

      const meta = document.createElement('div');
      meta.className = 'chatItemMeta';
      meta.textContent = `${fmtRelativeTime(c.updatedAt)} · ${c.lastSnippet || '—'}`;

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

  // Unfiled first.
  container.appendChild(renderFolderBlock(null, 'Unfiled', false, false));

  for (const f of folders) {
    const list = byFolder.get(f.id) ?? [];
    // Hide empty folders when searching to reduce clutter.
    if (query && list.length === 0) continue;
    container.appendChild(renderFolderBlock(f.id, f.name, !!f.collapsed, true));
  }

  // If there are chats only in Unfiled and query is empty, ensure unfiled list shows those.
  // (We rendered Unfiled above, but it used byFolder which may be empty.)
  // Re-render unfiled list accurately:
  const first = container.firstElementChild as HTMLDivElement | null;
  if (first) {
    const unfiled = byFolder.get(null) ?? [];
    const header = first.querySelector('.folderHeaderBtn') as HTMLButtonElement | null;
    const existingList = first.querySelector('.chatList');
    if (existingList) existingList.remove();
    header && (header.textContent = `▼ Unfiled`);
    first.appendChild(renderChatList(unfiled));
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
}

async function ensureAtLeastOneChat() {
  chatStoreState = await ensureInitialized();
  if (!chatStoreState.chats.length) {
    const { state, chatId } = await createChat(null);
    chatStoreState = state;
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

async function openPopoutWindow() {
  const bounds = (await getSavedChatWindowBounds()) ?? {
    left: 80,
    top: 80,
    ...getCurrentPopupSize()
  };

  const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  url.searchParams.set('mode', 'window');
  const activeChatId = getActiveChatId();
  if (activeChatId) url.searchParams.set('chatId', activeChatId);

  await chrome.windows.create({
    url: url.toString(),
    type: 'popup',
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });
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

async function openCompactWindow() {
  const size = (await getSavedPopupSize()) ?? POPUP_SIZE_DEFAULT;
  const bounds = (await getSavedChatWindowBounds()) ?? { left: 120, top: 120, ...size };

  const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
  url.searchParams.set('mode', 'popup');
  const activeChatId = getActiveChatId();
  if (activeChatId) url.searchParams.set('chatId', activeChatId);

  await chrome.windows.create({
    url: url.toString(),
    type: 'popup',
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(size.width),
    height: Math.round(size.height)
  });
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

  if (!overlay || !openBtn || !closeBtn || !cancelBtn || !saveBtn || !resetBtn) return;
  if (!baseUrlEl || !modelSelectEl || !modelCustomEl || !themeEl || !fontEl || !sizeEl || !statusEl) return;

  let lastLoaded: Settings | null = null;

  const setStatus = (text: string) => {
    statusEl.textContent = text;
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
    saveBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        const baseUrl = baseUrlEl.value.trim();
        const model = getSelectedModelFromUi();
        const theme = themeEl.value as Settings['theme'];
        const fontFamily = fontEl.value as Settings['fontFamily'];
        const fontSize = Number.parseInt(sizeEl.value, 10);

        if (!baseUrl || !isValidHttpUrl(baseUrl)) throw new Error('Base URL must be http(s)://…');
        if (!model) throw new Error('Default model cannot be empty');
        if (!Number.isFinite(fontSize) || fontSize < 11 || fontSize > 20) throw new Error('Font size must be 11–20');

        await setSettings({ baseUrl, model, theme, fontFamily, fontSize });
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
        setStatus(String((e as any)?.message ?? e));
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  resetBtn.addEventListener('click', () => {
    setStatus('');
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
        setStatus('Reset.');
      })
      .catch((e) => setStatus(String((e as any)?.message ?? e)))
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

async function getTabContext(maxChars = 8000): Promise<TabContext> {
  const resp = await sendMessage({ type: 'TAB_CONTEXT_GET', maxChars });
  if (!resp.ok) throw new Error(formatError(resp));
  if (resp.type !== 'TAB_CONTEXT_GET_RESULT') throw new Error('Unexpected response while reading tab context');
  return resp.context;
}

function buildContextBlock(ctx: TabContext): string {
  const selection = ctx.selection?.trim();
  const excerpt = ctx.textExcerpt?.trim();
  const body = selection || excerpt || '';
  const clipped = body.length > 2000 ? body.slice(0, 2000) + '…' : body;

  return [
    'Context (current tab):',
    `Title: ${ctx.title}`,
    `URL: ${ctx.url}`,
    '',
    '```',
    clipped,
    '```',
    ''
  ].join('\n');
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

  const useContext = (document.getElementById('useContextToggle') as HTMLInputElement | null)?.checked ?? false;

  const trimmed = prompt.trim();
  if (!trimmed) return;

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
    if (useContext) {
      try {
        const ctx = await getTabContext(8000);
        finalPrompt = buildContextBlock(ctx) + trimmed;
        setContextBadge('Context attached', true);
        // After a moment, revert badge text but keep visible while enabled.
        setTimeout(() => {
          const stillEnabled =
            (document.getElementById('useContextToggle') as HTMLInputElement | null)?.checked ?? false;
          setContextBadge(stillEnabled ? 'Context on' : 'Context off', stillEnabled);
        }, 1500);
      } catch (e) {
        // Context is optional; show a system message and continue without it.
        const text = `Context not attached: ${String((e as any)?.message ?? e)}`;
        const id = uid();
        chatStoreState = await appendMessage(activeChatId, { role: 'system', text, ts: Date.now(), id });
        addMessageWithId('system', text, id);
      }
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
    const text = String((e as any)?.message ?? e);
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
  document.documentElement.dataset.mode = mode;

  if (mode !== 'window') {
    applyPopupSize((await getSavedPopupSize()) ?? POPUP_SIZE_DEFAULT);
    setupPopupResize();
  } else {
    startWindowBoundsPersistence(mode);
  }

  // Apply theme + typography ASAP.
  applyUiSettings(await getSettings());

  const btn = $('generateBtn') as HTMLButtonElement;
  const promptEl = $('prompt') as HTMLTextAreaElement;
  const modelSelect = $('modelSelect') as HTMLSelectElement;
  const useContextToggle = document.getElementById('useContextToggle') as HTMLInputElement | null;
  const popoutBtn = document.getElementById('popoutBtn') as HTMLButtonElement | null;
  const popinBtn = document.getElementById('popinBtn') as HTMLButtonElement | null;

  btn.addEventListener('click', () => void onGenerate());

  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => {
      void (async () => {
        await openPopoutWindow();
        // Close the action popup so the user only manages one window.
        window.close();
      })();
    });
  }

  if (popinBtn) {
    popinBtn.addEventListener('click', () => {
      void (async () => {
        await openCompactWindow();
        window.close();
      })();
    });
  }

  setupSettingsModal(() => {
    // Reload models if base URL / default model changed.
    void loadModels();
  });

  modelSelect.addEventListener('change', () => {
    const model = modelSelect.value;
    void setSettings({ model });
    settingsModelUiSync?.syncModel(model);
  });

  promptEl.addEventListener('input', () => autoGrowTextarea(promptEl));
  promptEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void onGenerate();
    }
  });

  autoGrowTextarea(promptEl);
  setGenerating(false);

  applySidebarPrefs(await getSavedSidebarPrefs());

  await ensureAtLeastOneChat();
  setActiveChatTitleUi();
  renderFolderSelect();
  setMessagesFromActiveChat();
  renderSidebar();

  if (useContextToggle) {
    useContextToggle.addEventListener('change', () => {
      const enabled = useContextToggle.checked;
      setContextBadge(enabled ? 'Context on' : 'Context off', enabled);
    });
    // Default off
    setContextBadge('Context off', false);
  }

  try {
    await loadModels();
  } catch (e) {
    addMessage('error', `Failed to load models. Is Ollama running?\n${String((e as any)?.message ?? e)}`);
  }

  // URL param support (used by context-menu open and window-mode deep links)
  const qs = getQueryStateFromUrl();
  if (qs.chatId && qs.chatId !== getActiveChatId()) {
    await selectChat(qs.chatId);
  }
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
    const onPointerDown = (ev: PointerEvent) => {
      // If collapsed, expand first.
      if (document.documentElement.dataset.sidebarCollapsed === '1') {
        // Apply immediately for this gesture; persist async.
        delete document.documentElement.dataset.sidebarCollapsed;
        void saveSidebarCollapsed(false);
      }

      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();

      const startX = ev.clientX;
      const startWidth = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
      document.body.classList.add('resizingSidebar');

      try {
        splitter.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      const onMove = (clientX: number) => {
        const dx = clientX - startX;
        const next = clamp(Math.round(startWidth + dx), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
        document.documentElement.style.setProperty('--sidebar-width-expanded', `${next}px`);
      };

      const onPointerMove = (e: PointerEvent) => onMove(e.clientX);
      const onPointerUp = () => {
        splitter.removeEventListener('pointermove', onPointerMove);
        splitter.removeEventListener('pointerup', onPointerUp);
        splitter.removeEventListener('pointercancel', onPointerUp);
        document.body.classList.remove('resizingSidebar');

        const width = getCssVarPx('--sidebar-width-expanded') ?? SIDEBAR_WIDTH_DEFAULT;
        void saveSidebarWidth(width);
      };

      splitter.addEventListener('pointermove', onPointerMove);
      splitter.addEventListener('pointerup', onPointerUp);
      splitter.addEventListener('pointercancel', onPointerUp);
    };

    splitter.addEventListener('pointerdown', onPointerDown);
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
            const ok = confirm(`Delete folder "${f?.name ?? 'Folder'}"? Chats will be moved to Unfiled.`);
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
  addMessage('error', String((e as any)?.message ?? e));
});
