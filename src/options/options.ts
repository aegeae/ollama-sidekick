import { getSettings, setSettings, type Settings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function fetchModels(): Promise<string[]> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'OLLAMA_LIST_MODELS' });
    if (!resp?.ok) return [];
    if (resp.type !== 'OLLAMA_LIST_MODELS_RESULT') return [];
    return Array.isArray(resp.models) ? resp.models : [];
  } catch {
    return [];
  }
}

async function load() {
  const settings = await getSettings();

  // Auto-heal model if it isn't installed (prevents 404 model-not-found).
  const models = await fetchModels();
  const saved = settings.model.trim();
  if (models.length > 0) {
    const effectiveModel = saved && models.includes(saved) ? saved : models[0];
    if (effectiveModel !== saved) {
      await setSettings({ model: effectiveModel });
    }
  }

  const fresh = await getSettings();
  ($('baseUrl') as HTMLInputElement).value = fresh.baseUrl;
  ($('model') as HTMLInputElement).value = fresh.model;
  ($('theme') as HTMLSelectElement).value = fresh.theme;
  ($('fontFamily') as HTMLSelectElement).value = fresh.fontFamily;
  ($('fontSize') as HTMLInputElement).value = String(fresh.fontSize);

  applyUiSettings(fresh);
}

async function save() {
  const baseUrl = ($('baseUrl') as HTMLInputElement).value.trim();
  const model = ($('model') as HTMLInputElement).value.trim();
  const theme = ($('theme') as HTMLSelectElement).value as Settings['theme'];
  const fontFamily = ($('fontFamily') as HTMLSelectElement).value as Settings['fontFamily'];
  const fontSize = Number.parseInt(($('fontSize') as HTMLInputElement).value, 10);

  await setSettings({ baseUrl, model, theme, fontFamily, fontSize });
  applyUiSettings(await getSettings());
}

async function main() {
  const status = $('status') as HTMLSpanElement;
  const btn = $('saveBtn') as HTMLButtonElement;

  await load();

  btn.addEventListener('click', () => {
    status.textContent = '';
    btn.disabled = true;
    Promise.resolve()
      .then(save)
      .then(() => {
        status.textContent = 'Saved.';
      })
      .catch((e) => {
        status.textContent = String((e as any)?.message ?? e);
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
}

main().catch((e) => {
  const status = document.getElementById('status');
  if (status) status.textContent = String((e as any)?.message ?? e);
});
