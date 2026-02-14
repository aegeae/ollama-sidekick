import { getSettings, setSettings, type Settings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';
import { getState } from '../lib/chatStore';
import { getHistoryDirectoryHandle, clearHistoryDirectoryHandle, setHistoryDirectoryHandle } from '../lib/persistedHandles';
import {
  exportHistoryAsDownload,
  exportHistoryToDirectory,
  pickDirectory,
  supportsFileSystemAccessApi
} from '../lib/historyExportFs';

const FOLDER_UNAVAILABLE_HINT =
  'Folder picker is not available in this browser. Use Export now (download), and enable “Ask where to save each file” in browser download settings if you want to pick a folder.';

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

  ($('historyStorageMode') as HTMLSelectElement).value = fresh.historyStorageMode;
  ($('historyExportFormat') as HTMLSelectElement).value = fresh.historyExportFormat;

  const storageModeEl = $('historyStorageMode') as HTMLSelectElement;
  const folderOpt = Array.from(storageModeEl.options).find((o) => o.value === 'folder');
  const folderSupported = supportsFileSystemAccessApi();
  if (folderOpt) folderOpt.disabled = !folderSupported;

  if (!folderSupported) {
    // If user had folder mode stored from a different browser, auto-heal back to local.
    if (fresh.historyStorageMode === 'folder') {
      await setSettings({ historyStorageMode: 'local' });
      const healed = await getSettings();
      storageModeEl.value = healed.historyStorageMode;
    }

    // Hide folder controls when unsupported.
    const folderRow = $('historyFolderRow') as HTMLDivElement;
    folderRow.style.display = 'none';
  }

  await refreshHistoryFolderStatus();
  updateHistoryUi();

  applyUiSettings(fresh);
}

function updateHistoryUi() {
  const mode = ($('historyStorageMode') as HTMLSelectElement).value as Settings['historyStorageMode'];
  const folderRow = $('historyFolderRow') as HTMLDivElement;
  folderRow.style.display = mode === 'folder' && supportsFileSystemAccessApi() ? 'flex' : 'none';
}

async function refreshHistoryFolderStatus() {
  const status = $('historyFolderStatus') as HTMLSpanElement;
  const handle = await getHistoryDirectoryHandle();
  status.textContent = handle ? 'Folder selected.' : 'No folder selected.';
}

async function chooseHistoryFolder() {
  if (!supportsFileSystemAccessApi()) {
    throw new Error(FOLDER_UNAVAILABLE_HINT);
  }
  const dir = await pickDirectory();
  await setHistoryDirectoryHandle(dir);
  await refreshHistoryFolderStatus();
}

async function clearHistoryFolder() {
  await clearHistoryDirectoryHandle();
  await refreshHistoryFolderStatus();
}

async function exportHistoryNow(): Promise<string> {
  const mode = ($('historyStorageMode') as HTMLSelectElement).value as Settings['historyStorageMode'];
  const format = ($('historyExportFormat') as HTMLSelectElement).value as Settings['historyExportFormat'];
  const state = await getState();

  if (mode === 'folder' && supportsFileSystemAccessApi()) {
    const existing = await getHistoryDirectoryHandle();
    const dir = existing ?? (await pickDirectory());
    if (!existing) {
      await setHistoryDirectoryHandle(dir);
      await refreshHistoryFolderStatus();
    }

    const res = await exportHistoryToDirectory(dir, state, format);
    return `Exported ${res.filesWritten} file(s).`;
  }

  const dl = exportHistoryAsDownload(state, format);
  return mode === 'folder' && !supportsFileSystemAccessApi()
    ? `Downloaded ${dl.fileName}. (${FOLDER_UNAVAILABLE_HINT})`
    : `Downloaded ${dl.fileName}.`;
}

async function save() {
  const baseUrl = ($('baseUrl') as HTMLInputElement).value.trim();
  const model = ($('model') as HTMLInputElement).value.trim();
  const theme = ($('theme') as HTMLSelectElement).value as Settings['theme'];
  const fontFamily = ($('fontFamily') as HTMLSelectElement).value as Settings['fontFamily'];
  const fontSize = Number.parseInt(($('fontSize') as HTMLInputElement).value, 10);

  const historyStorageMode = ($('historyStorageMode') as HTMLSelectElement).value as Settings['historyStorageMode'];
  const historyExportFormat = ($('historyExportFormat') as HTMLSelectElement).value as Settings['historyExportFormat'];

  await setSettings({
    baseUrl,
    model,
    theme,
    fontFamily,
    fontSize,
    historyStorageMode,
    historyExportFormat
  });
  applyUiSettings(await getSettings());
}

async function main() {
  const status = $('status') as HTMLSpanElement;
  const btn = $('saveBtn') as HTMLButtonElement;

  const historyStorageModeEl = $('historyStorageMode') as HTMLSelectElement;
  const chooseFolderBtn = $('chooseHistoryFolderBtn') as HTMLButtonElement;
  const clearFolderBtn = $('clearHistoryFolderBtn') as HTMLButtonElement;
  const exportBtn = $('exportHistoryBtn') as HTMLButtonElement;
  const exportStatus = $('historyExportStatus') as HTMLSpanElement;

  await load();

  historyStorageModeEl.addEventListener('change', () => {
    updateHistoryUi();
  });

  chooseFolderBtn.addEventListener('click', () => {
    exportStatus.textContent = '';
    chooseFolderBtn.disabled = true;
    Promise.resolve()
      .then(chooseHistoryFolder)
      .then(() => {
        exportStatus.textContent = 'Folder selected.';
      })
      .catch((e) => {
        exportStatus.textContent = String((e as any)?.message ?? e);
      })
      .finally(() => {
        chooseFolderBtn.disabled = false;
      });
  });

  clearFolderBtn.addEventListener('click', () => {
    exportStatus.textContent = '';
    clearFolderBtn.disabled = true;
    Promise.resolve()
      .then(clearHistoryFolder)
      .then(() => {
        exportStatus.textContent = 'Folder cleared.';
      })
      .catch((e) => {
        exportStatus.textContent = String((e as any)?.message ?? e);
      })
      .finally(() => {
        clearFolderBtn.disabled = false;
      });
  });

  exportBtn.addEventListener('click', () => {
    exportStatus.textContent = '';
    exportBtn.disabled = true;
    Promise.resolve()
      .then(exportHistoryNow)
      .then((msg) => {
        exportStatus.textContent = msg;
      })
      .catch((e) => {
        exportStatus.textContent = String((e as any)?.message ?? e);
      })
      .finally(() => {
        exportBtn.disabled = false;
      });
  });

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
