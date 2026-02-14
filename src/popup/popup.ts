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
  const prompt = ($('prompt') as HTMLTextAreaElement).value;
  const model = ($('modelSelect') as HTMLSelectElement).value;
  const output = $('output') as HTMLPreElement;
  const btn = $('generateBtn') as HTMLButtonElement;

  output.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const resp = await sendMessage({ type: 'OLLAMA_GENERATE', prompt, model });
    if (!resp.ok) throw new Error(formatError(resp));

    if (resp.type !== 'OLLAMA_GENERATE_RESULT') {
      throw new Error('Unexpected response while generating');
    }

    output.textContent = resp.text || '(empty response)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

async function main() {
  const output = $('output') as HTMLPreElement;
  const btn = $('generateBtn') as HTMLButtonElement;
  btn.addEventListener('click', () => onGenerate().catch((e) => (output.textContent = String(e?.message ?? e))));

  try {
    await loadModels();
  } catch (e) {
    output.textContent = `Failed to load models. Is Ollama running?\n${String((e as any)?.message ?? e)}`;
  }
}

main().catch((e) => {
  const output = document.getElementById('output');
  if (output) output.textContent = String((e as any)?.message ?? e);
});
