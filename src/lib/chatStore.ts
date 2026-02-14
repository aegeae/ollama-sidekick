export type ChatRole = 'user' | 'assistant' | 'system' | 'error';

export type StoredMessage = {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  model?: string;
};

export type Folder = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  collapsed?: boolean;
};

export type Chat = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
};

export type ChatStoreStateV1 = {
  version: 1;
  folders: Folder[];
  chats: Chat[];
  activeChatId: string | null;
};

export type ChatStoreState = ChatStoreStateV1;

const STORAGE_KEY = 'chatStore';

const MAX_CHATS = 50;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_MESSAGE_CHARS = 20_000;

const CHAT_ROLES = ['user', 'assistant', 'system', 'error'] as const;
function isChatRole(value: unknown): value is ChatRole {
  return typeof value === 'string' && (CHAT_ROLES as readonly string[]).includes(value);
}

function now() {
  return Date.now();
}

function uid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampText(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}

function clampRawText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

function createEmptyState(): ChatStoreStateV1 {
  return { version: 1, folders: [], chats: [], activeChatId: null };
}

async function storageGet<T = any>(keys: string | string[]): Promise<T> {
  return (await chrome.storage.local.get(keys)) as T;
}

async function storageSet(items: Record<string, any>): Promise<void> {
  await chrome.storage.local.set(items);
}

async function readRawState(): Promise<unknown> {
  const data = await storageGet<Record<string, unknown>>(STORAGE_KEY);
  return data[STORAGE_KEY];
}

function coerceState(raw: unknown): ChatStoreStateV1 {
  if (!raw || typeof raw !== 'object') return createEmptyState();
  const r = raw as any;
  if (r.version !== 1) return createEmptyState();

  const folders: Folder[] = Array.isArray(r.folders)
    ? r.folders
        .filter((f: any) => f && typeof f.id === 'string' && typeof f.name === 'string')
        .map((f: any) => ({
          id: String(f.id),
          name: String(f.name),
          createdAt: typeof f.createdAt === 'number' ? f.createdAt : now(),
          updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : now(),
          collapsed: typeof f.collapsed === 'boolean' ? f.collapsed : false
        }))
    : [];

  const chats: Chat[] = Array.isArray(r.chats)
    ? r.chats
        .filter((c: any) => c && typeof c.id === 'string')
        .map((c: any) => ({
          id: String(c.id),
          title: typeof c.title === 'string' && c.title.trim() ? String(c.title) : 'New chat',
          folderId: typeof c.folderId === 'string' ? String(c.folderId) : null,
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : now(),
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now(),
          messages: Array.isArray(c.messages)
            ? c.messages
                .filter((m: any) => m && typeof m.id === 'string' && typeof m.role === 'string' && typeof m.text === 'string')
                .map((m: any) => ({
                  id: String(m.id),
                  role: isChatRole(m.role) ? m.role : 'user',
                  text: clampRawText(String(m.text), MAX_MESSAGE_CHARS),
                  ts: typeof m.ts === 'number' ? m.ts : now(),
                  model: typeof m.model === 'string' ? m.model : undefined
                }))
            : []
        }))
    : [];

  const activeChatId = typeof r.activeChatId === 'string' ? String(r.activeChatId) : null;

  // Sanity: drop folderIds that no longer exist.
  const folderIds = new Set(folders.map((f) => f.id));
  for (const c of chats) {
    if (c.folderId && !folderIds.has(c.folderId)) c.folderId = null;
  }

  return {
    version: 1,
    folders,
    chats,
    activeChatId: chats.some((c) => c.id === activeChatId) ? activeChatId : null
  };
}

async function writeState(state: ChatStoreStateV1): Promise<void> {
  await storageSet({ [STORAGE_KEY]: state });
}

function sortChatsDesc(a: Chat, b: Chat): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
}

function enforceLimits(state: ChatStoreStateV1): ChatStoreStateV1 {
  // Trim messages per chat.
  for (const chat of state.chats) {
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    }
  }

  // Trim number of chats by least-recently updated, but never drop the active chat.
  if (state.chats.length > MAX_CHATS) {
    const activeId = state.activeChatId;
    const sorted = [...state.chats].sort(sortChatsDesc);
    const keep: Chat[] = [];

    for (const c of sorted) {
      if (keep.length >= MAX_CHATS) break;
      keep.push(c);
    }

    // Ensure active chat is kept.
    if (activeId && !keep.some((c) => c.id === activeId)) {
      const active = state.chats.find((c) => c.id === activeId);
      if (active) {
        keep.pop();
        keep.push(active);
      }
    }

    const keepIds = new Set(keep.map((c) => c.id));
    state.chats = state.chats.filter((c) => keepIds.has(c.id));

    if (activeId && !keepIds.has(activeId)) {
      state.activeChatId = null;
    }
  }

  return state;
}

export async function getState(): Promise<ChatStoreStateV1> {
  const raw = await readRawState();
  const state = coerceState(raw);
  return enforceLimits(state);
}

export async function ensureInitialized(): Promise<ChatStoreStateV1> {
  const state = await getState();
  // Persist normalized state if it was missing.
  if (!rawExists(state)) {
    await writeState(state);
  }
  return state;
}

function rawExists(state: ChatStoreStateV1): boolean {
  // If there is no storage value, getState() returns a new object.
  // We can't tell directly. We treat "no chats, no folders, no active" as "maybe empty".
  // It is OK to write it; storage writes are cheap.
  return state.chats.length > 0 || state.folders.length > 0 || state.activeChatId != null;
}

export async function createChat(folderId: string | null = null): Promise<{ state: ChatStoreStateV1; chatId: string }> {
  const state = await getState();

  const id = uid();
  const t = now();
  state.chats.push({
    id,
    title: 'New chat',
    folderId,
    createdAt: t,
    updatedAt: t,
    messages: []
  });
  state.activeChatId = id;

  enforceLimits(state);
  await writeState(state);
  return { state, chatId: id };
}

export async function setActiveChat(chatId: string): Promise<ChatStoreStateV1> {
  const state = await getState();
  if (state.chats.some((c) => c.id === chatId)) {
    state.activeChatId = chatId;
    await writeState(state);
  }
  return state;
}

export async function renameChat(chatId: string, title: string): Promise<ChatStoreStateV1> {
  const state = await getState();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return state;
  chat.title = clampText(title, 60) || 'New chat';
  chat.updatedAt = now();
  await writeState(state);
  return state;
}

export async function deleteChat(chatId: string): Promise<ChatStoreStateV1> {
  const state = await getState();
  state.chats = state.chats.filter((c) => c.id !== chatId);

  if (state.activeChatId === chatId) {
    const next = [...state.chats].sort(sortChatsDesc)[0];
    state.activeChatId = next ? next.id : null;
  }

  await writeState(state);
  return state;
}

export async function moveChatToFolder(chatId: string, folderId: string | null): Promise<ChatStoreStateV1> {
  const state = await getState();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return state;

  if (folderId != null && !state.folders.some((f) => f.id === folderId)) {
    folderId = null;
  }

  chat.folderId = folderId;
  chat.updatedAt = now();
  await writeState(state);
  return state;
}

export async function appendMessage(
  chatId: string,
  message: Omit<StoredMessage, 'id'> & { id?: string }
): Promise<ChatStoreStateV1> {
  const state = await getState();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return state;

  const msg: StoredMessage = {
    id: message.id ?? uid(),
    role: message.role,
    text: clampRawText(message.text, MAX_MESSAGE_CHARS),
    ts: message.ts,
    model: message.model
  };

  chat.messages.push(msg);
  chat.updatedAt = now();

  // Auto-title on first user message if still default.
  if (chat.title === 'New chat' && msg.role === 'user') {
    chat.title = clampText(msg.text.replace(/\s+/g, ' '), 40) || 'New chat';
  }

  enforceLimits(state);
  await writeState(state);
  return state;
}

export async function createFolder(name: string): Promise<{ state: ChatStoreStateV1; folderId: string }> {
  const state = await getState();
  const id = uid();
  const t = now();
  state.folders.push({ id, name: clampText(name, 40) || 'Folder', createdAt: t, updatedAt: t, collapsed: false });
  await writeState(state);
  return { state, folderId: id };
}

export async function renameFolder(folderId: string, name: string): Promise<ChatStoreStateV1> {
  const state = await getState();
  const f = state.folders.find((x) => x.id === folderId);
  if (!f) return state;
  f.name = clampText(name, 40) || f.name;
  f.updatedAt = now();
  await writeState(state);
  return state;
}

export async function deleteFolder(folderId: string): Promise<ChatStoreStateV1> {
  const state = await getState();

  // Move chats to Unfiled (null folder) instead of deleting.
  for (const c of state.chats) {
    if (c.folderId === folderId) c.folderId = null;
  }

  state.folders = state.folders.filter((f) => f.id !== folderId);
  await writeState(state);
  return state;
}

export async function toggleFolderCollapsed(folderId: string): Promise<ChatStoreStateV1> {
  const state = await getState();
  const f = state.folders.find((x) => x.id === folderId);
  if (!f) return state;
  f.collapsed = !f.collapsed;
  await writeState(state);
  return state;
}

export type ChatSummary = {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: number;
  createdAt: number;
  lastSnippet: string;
};

export function getChatSummaries(state: ChatStoreStateV1): ChatSummary[] {
  return [...state.chats]
    .sort(sortChatsDesc)
    .map((c) => ({
      id: c.id,
      title: c.title,
      folderId: c.folderId,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      lastSnippet: clampText((c.messages[c.messages.length - 1]?.text ?? '').replace(/\s+/g, ' '), 80)
    }));
}

export function searchChats(state: ChatStoreStateV1, query: string): ChatSummary[] {
  const q = normalizeQuery(query);
  if (!q) return getChatSummaries(state);

  const matches = (text: string) => text.toLowerCase().includes(q);

  const result: ChatSummary[] = [];
  for (const c of state.chats) {
    if (matches(c.title)) {
      result.push({
        id: c.id,
        title: c.title,
        folderId: c.folderId,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        lastSnippet: clampText((c.messages[c.messages.length - 1]?.text ?? '').replace(/\s+/g, ' '), 80)
      });
      continue;
    }

    if (c.messages.some((m) => matches(m.text))) {
      result.push({
        id: c.id,
        title: c.title,
        folderId: c.folderId,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        lastSnippet: clampText((c.messages[c.messages.length - 1]?.text ?? '').replace(/\s+/g, ' '), 80)
      });
    }
  }

  return result.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function getActiveChat(state: ChatStoreStateV1): Chat | null {
  if (!state.activeChatId) return null;
  return state.chats.find((c) => c.id === state.activeChatId) ?? null;
}

export function getFolders(state: ChatStoreStateV1): Folder[] {
  return [...state.folders].sort((a, b) => a.name.localeCompare(b.name));
}
