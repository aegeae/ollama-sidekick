const DB_NAME = 'ollama-sidekick';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(key);
      req.onerror = () => reject(req.error ?? new Error('Failed to read from IndexedDB'));
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(value, key);
      req.onerror = () => reject(req.error ?? new Error('Failed to write to IndexedDB'));
      req.onsuccess = () => resolve();
    });
  } finally {
    db.close();
  }
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.delete(key);
      req.onerror = () => reject(req.error ?? new Error('Failed to delete from IndexedDB'));
      req.onsuccess = () => resolve();
    });
  } finally {
    db.close();
  }
}

const HISTORY_DIR_HANDLE_KEY = 'historyDirHandle';

export async function getHistoryDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await idbGet<FileSystemDirectoryHandle>(HISTORY_DIR_HANDLE_KEY);
  } catch {
    return null;
  }
}

export async function setHistoryDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await idbSet(HISTORY_DIR_HANDLE_KEY, handle);
}

export async function clearHistoryDirectoryHandle(): Promise<void> {
  await idbDel(HISTORY_DIR_HANDLE_KEY);
}
