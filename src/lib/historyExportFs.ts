import type { ChatStoreStateV1 } from './chatStore';
import {
  makeHistoryIndexJson,
  sanitizeFileName,
  serializeChatToMarkdown,
  serializeHistoryToJson,
  serializeHistoryToJsonl,
  serializeHistoryToMarkdown,
  type HistoryExportFormat
} from './historyExport';

export function supportsFileSystemAccessApi(): boolean {
  // File System Access API is not available in all Chromium browsers (and may be unavailable on extension pages).
  return typeof (globalThis as any).showDirectoryPicker === 'function' && (globalThis as any).isSecureContext === true;
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (globalThis as any).showDirectoryPicker as (() => Promise<FileSystemDirectoryHandle>) | undefined;
  if (!picker) throw new Error('Folder picker is not available in this browser');
  return await picker();
}

async function ensureWritePermission(dir: FileSystemDirectoryHandle): Promise<void> {
  // Best-effort: not all browsers implement these methods.
  const anyDir = dir as any;
  if (typeof anyDir.queryPermission === 'function') {
    const current = await anyDir.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') return;
  }
  if (typeof anyDir.requestPermission === 'function') {
    const next = await anyDir.requestPermission({ mode: 'readwrite' });
    if (next === 'granted') return;
  }
  // If the browser doesn't support permission queries, we try to write and let it throw.
}

async function writeTextFile(dir: FileSystemDirectoryHandle, fileName: string, text: string): Promise<void> {
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

export type DirectoryExportResult = {
  filesWritten: number;
  rootFile?: string;
};

export async function exportHistoryToDirectory(
  dir: FileSystemDirectoryHandle,
  state: ChatStoreStateV1,
  format: HistoryExportFormat
): Promise<DirectoryExportResult> {
  await ensureWritePermission(dir);

  if (format === 'json') {
    const fileName = 'ollama-sidekick-history.json';
    await writeTextFile(dir, fileName, serializeHistoryToJson(state));
    return { filesWritten: 1, rootFile: fileName };
  }

  if (format === 'jsonl') {
    const fileName = 'ollama-sidekick-history.jsonl';
    await writeTextFile(dir, fileName, serializeHistoryToJsonl(state));
    return { filesWritten: 1, rootFile: fileName };
  }

  // Markdown per chat.
  const indexName = 'index.json';
  await writeTextFile(dir, indexName, makeHistoryIndexJson(state));

  let filesWritten = 1;
  for (const chat of state.chats) {
    const safeTitle = sanitizeFileName(chat.title);
    const fileName = `${safeTitle} - ${chat.id}.md`;
    await writeTextFile(dir, fileName, serializeChatToMarkdown(chat));
    filesWritten++;
  }

  return { filesWritten, rootFile: indexName };
}

export function downloadTextFile(fileName: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.click();

  // Cleanup.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportHistoryAsDownload(state: ChatStoreStateV1, format: HistoryExportFormat): { fileName: string } {
  if (format === 'md') {
    const fileName = 'ollama-sidekick-history.md';
    downloadTextFile(fileName, serializeHistoryToMarkdown(state), 'text/markdown');
    return { fileName };
  }

  if (format === 'jsonl') {
    const fileName = 'ollama-sidekick-history.jsonl';
    downloadTextFile(fileName, serializeHistoryToJsonl(state), 'application/json');
    return { fileName };
  }

  const fileName = 'ollama-sidekick-history.json';
  downloadTextFile(fileName, serializeHistoryToJson(state), 'application/json');
  return { fileName };
}
