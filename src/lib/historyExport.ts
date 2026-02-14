import type { Chat, ChatStoreStateV1, Folder, StoredMessage } from './chatStore';

export type HistoryExportFormat = 'json' | 'md' | 'jsonl';

export function sanitizeFileName(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.length > 0 ? trimmed : 'chat';
  // Windows + macOS safe-ish: remove reserved characters and control chars.
  const cleaned = base
    .replace(/[\\/\n\r\t\0]/g, ' ')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const limited = cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
  return limited || 'chat';
}

function formatIso(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function roleLabel(role: StoredMessage['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    default:
      return String(role);
  }
}

export function serializeHistoryToJson(state: ChatStoreStateV1): string {
  const payload = {
    exportedAt: Date.now(),
    exportedAtIso: new Date().toISOString(),
    state
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

export function serializeHistoryToJsonl(state: ChatStoreStateV1): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'meta', exportedAt: Date.now(), version: state.version }));

  for (const folder of state.folders) {
    lines.push(JSON.stringify({ type: 'folder', ...folder }));
  }

  for (const chat of state.chats) {
    lines.push(
      JSON.stringify({
        type: 'chat',
        id: chat.id,
        title: chat.title,
        folderId: chat.folderId,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      })
    );

    for (const msg of chat.messages) {
      lines.push(
        JSON.stringify({
          type: 'message',
          chatId: chat.id,
          id: msg.id,
          role: msg.role,
          text: msg.text,
          ts: msg.ts,
          model: msg.model
        })
      );
    }
  }

  return lines.join('\n') + '\n';
}

export function serializeChatToMarkdown(chat: Chat): string {
  const parts: string[] = [];
  parts.push(`# ${chat.title || 'Chat'}`);
  parts.push('');
  parts.push(`- Chat ID: ${chat.id}`);
  parts.push(`- Created: ${formatIso(chat.createdAt)}`);
  parts.push(`- Updated: ${formatIso(chat.updatedAt)}`);
  if (chat.folderId) parts.push(`- Folder ID: ${chat.folderId}`);
  parts.push('');

  for (const m of chat.messages) {
    parts.push(`## ${roleLabel(m.role)}`);
    parts.push('');
    parts.push(`_Time_: ${formatIso(m.ts)}${m.model ? `  \\n_Model_: ${m.model}` : ''}`);
    parts.push('');
    parts.push(m.text);
    parts.push('');
  }

  return parts.join('\n').trimEnd() + '\n';
}

export function serializeHistoryToMarkdown(state: ChatStoreStateV1): string {
  const parts: string[] = [];
  parts.push(`# Ollama Sidekick — Conversation History`);
  parts.push('');
  parts.push(`Exported: ${new Date().toISOString()}`);
  parts.push('');

  // Group chats by folder for readability.
  const foldersById = new Map<string, Folder>();
  for (const f of state.folders) foldersById.set(f.id, f);

  const chatsByFolder = new Map<string, Chat[]>();
  const rootChats: Chat[] = [];
  for (const c of state.chats) {
    if (c.folderId && foldersById.has(c.folderId)) {
      const arr = chatsByFolder.get(c.folderId) ?? [];
      arr.push(c);
      chatsByFolder.set(c.folderId, arr);
    } else {
      rootChats.push(c);
    }
  }

  const writeChat = (c: Chat) => {
    parts.push(`---`);
    parts.push('');
    parts.push(serializeChatToMarkdown(c));
  };

  if (rootChats.length > 0) {
    parts.push(`## Inbox`);
    parts.push('');
    for (const c of rootChats) writeChat(c);
  }

  for (const f of state.folders) {
    const chats = chatsByFolder.get(f.id) ?? [];
    if (chats.length === 0) continue;
    parts.push(`## Folder: ${f.name}`);
    parts.push('');
    for (const c of chats) writeChat(c);
  }

  return parts.join('\n').trimEnd() + '\n';
}

export function makeHistoryIndexJson(state: ChatStoreStateV1): string {
  const payload = {
    exportedAt: Date.now(),
    exportedAtIso: new Date().toISOString(),
    version: state.version,
    activeChatId: state.activeChatId,
    folders: state.folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt, updatedAt: f.updatedAt })),
    chats: state.chats.map((c) => ({
      id: c.id,
      title: c.title,
      folderId: c.folderId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length
    }))
  };
  return JSON.stringify(payload, null, 2) + '\n';
}
