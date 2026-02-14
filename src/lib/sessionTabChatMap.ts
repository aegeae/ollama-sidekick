export type TabChatMap = Record<string, string>;

const STORAGE_KEY = 'tabChatMap';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTabChatMap(raw: unknown): TabChatMap {
  if (!isPlainObject(raw)) return {};
  const out: TabChatMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string') continue;
    const key = k.trim();
    if (!key) continue;
    // Keys must match tab ids (digits only) to avoid accumulating unrelated data.
    if (!/^\d+$/.test(key)) continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    out[key] = v;
  }
  return out;
}

export function getChatIdForTabFromMap(map: TabChatMap, tabId: number): string | null {
  if (!Number.isFinite(tabId) || tabId <= 0) return null;
  const key = tabKey(tabId);
  return map[key] ?? null;
}

export function setChatIdForTabInMap(map: TabChatMap, tabId: number, chatId: string): TabChatMap {
  if (!Number.isFinite(tabId) || tabId <= 0) return { ...map };
  const id = String(chatId ?? '').trim();
  if (!id) return { ...map };
  return { ...map, [tabKey(tabId)]: id };
}

export function clearChatIdForTabInMap(map: TabChatMap, tabId: number): TabChatMap {
  if (!Number.isFinite(tabId) || tabId <= 0) return { ...map };
  const next = { ...map };
  delete next[tabKey(tabId)];
  return next;
}

function tabKey(tabId: number): string {
  return String(Math.floor(tabId));
}

async function readMap(): Promise<TabChatMap> {
  const session = (globalThis as any)?.chrome?.storage?.session;
  if (!session) return {};
  const data = await session.get([STORAGE_KEY]);
  return normalizeTabChatMap((data as any)?.[STORAGE_KEY]);
}

async function writeMap(map: TabChatMap): Promise<void> {
  const session = (globalThis as any)?.chrome?.storage?.session;
  if (!session) return;
  await session.set({ [STORAGE_KEY]: map });
}

export async function getChatIdForTab(tabId: number): Promise<string | null> {
  if (!Number.isFinite(tabId) || tabId <= 0) return null;
  try {
    const map = await readMap();
    return getChatIdForTabFromMap(map, tabId);
  } catch {
    return null;
  }
}

export async function setChatIdForTab(tabId: number, chatId: string): Promise<void> {
  if (!Number.isFinite(tabId) || tabId <= 0) return;
  const id = String(chatId ?? '').trim();
  if (!id) return;

  try {
    const map = await readMap();
    await writeMap(setChatIdForTabInMap(map, tabId, id));
  } catch {
    // ignore
  }
}

export async function clearChatIdForTab(tabId: number): Promise<void> {
  if (!Number.isFinite(tabId) || tabId <= 0) return;
  try {
    const map = await readMap();
    await writeMap(clearChatIdForTabInMap(map, tabId));
  } catch {
    // ignore
  }
}
