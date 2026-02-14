import type { BackgroundRequest, BackgroundResponse } from '../types/messages';
import { getSettings } from '../lib/settings';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return await chrome.runtime.sendMessage(message);
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

const state: { messages: ChatMessage[]; generating: boolean } = {
  messages: [],
  generating: false
};

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function setGenerating(isGenerating: boolean) {
  state.generating = isGenerating;
  const btn = $('generateBtn') as HTMLButtonElement;
  const prompt = $('prompt') as HTMLTextAreaElement;
  btn.disabled = isGenerating;
  prompt.disabled = isGenerating;
  btn.classList.toggle('isLoading', isGenerating);
}

function autoGrowTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const max = 160; // px
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

async function loadModels() {
  const modelSelect = $('modelSelect') as HTMLSelectElement;
  modelSelect.innerHTML = '';

  const settings = await getSettings();

  try {
    const resp = await sendMessage({ type: 'OLLAMA_LIST_MODELS' });
    if (!resp.ok) throw new Error(formatError(resp));

    if (resp.type !== 'OLLAMA_LIST_MODELS_RESULT') {
      throw new Error('Unexpected response while listing models');
    }

    const models = resp.models;
    if (models.length === 0) {
      // Ollama reachable but no models returned; still allow generation if user knows the model name.
      const opt = document.createElement('option');
      opt.value = settings.model;
      opt.textContent = settings.model;
      modelSelect.appendChild(opt);
      return;
    }

    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      modelSelect.appendChild(opt);
    }

    // Auto-select saved default model if it exists in the list.
    const defaultIndex = models.findIndex((m) => m === settings.model);
    if (defaultIndex >= 0) modelSelect.selectedIndex = defaultIndex;
  } catch {
    // If listing fails (e.g. Ollama down), still provide a reasonable default.
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model;
    modelSelect.appendChild(opt);
  }
}

async function onGenerate() {
  if (state.generating) return;

  const promptEl = $('prompt') as HTMLTextAreaElement;
  const prompt = promptEl.value;
  const model = ($('modelSelect') as HTMLSelectElement).value;

  const trimmed = prompt.trim();
  if (!trimmed) return;

  promptEl.value = '';
  autoGrowTextarea(promptEl);

  addMessage('user', trimmed);
  const thinkingId = addMessage('assistant', 'Thinking…', true);
  setGenerating(true);

  try {
    const resp = await sendMessage({ type: 'OLLAMA_GENERATE', prompt: trimmed, model });
    if (!resp.ok) {
      updateMessage(thinkingId, { role: 'error', text: formatError(resp), pending: false });
      return;
    }

    if (resp.type !== 'OLLAMA_GENERATE_RESULT') {
      updateMessage(thinkingId, { role: 'error', text: 'Unexpected response while generating', pending: false });
      return;
    }

    updateMessage(thinkingId, { text: resp.text || '(empty response)', pending: false });
  } catch (e) {
    updateMessage(thinkingId, {
      role: 'error',
      text: String((e as any)?.message ?? e),
      pending: false
    });
  } finally {
    setGenerating(false);
    promptEl.focus();
  }
}

async function main() {
  const btn = $('generateBtn') as HTMLButtonElement;
  const promptEl = $('prompt') as HTMLTextAreaElement;

  btn.addEventListener('click', () => void onGenerate());

  promptEl.addEventListener('input', () => autoGrowTextarea(promptEl));
  promptEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void onGenerate();
    }
  });

  autoGrowTextarea(promptEl);
  setGenerating(false);

  addMessage('system', 'Ready.');

  try {
    await loadModels();
  } catch (e) {
    addMessage('error', `Failed to load models. Is Ollama running?\n${String((e as any)?.message ?? e)}`);
  }
}

main().catch((e) => {
  addMessage('error', String((e as any)?.message ?? e));
});
