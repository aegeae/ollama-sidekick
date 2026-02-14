import { getSettings, setSettings, type Settings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function load() {
  const settings = await getSettings();
  ($('baseUrl') as HTMLInputElement).value = settings.baseUrl;
  ($('model') as HTMLInputElement).value = settings.model;
  ($('theme') as HTMLSelectElement).value = settings.theme;
  ($('fontFamily') as HTMLSelectElement).value = settings.fontFamily;
  ($('fontSize') as HTMLInputElement).value = String(settings.fontSize);

  applyUiSettings(settings);
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
