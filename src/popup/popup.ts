import type { BackgroundRequest, BackgroundResponse } from '../types/messages';
import { DEFAULT_SETTINGS, getSettings, setSettings, type Settings } from '../lib/settings';
import { applyUiSettings } from '../lib/uiSettings';

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

async function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return await chrome.runtime.sendMessage(message);
}

type PopupSize = { width: number; height: number };
type WindowBounds = { left: number; top: number; width: number; height: number };

const POPUP_SIZE_DEFAULT: PopupSize = { width: 380, height: 600 };
const POPUP_SIZE_MIN: PopupSize = { width: 360, height: 420 };
const POPUP_SIZE_MAX: PopupSize = { width: 640, height: 900 };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function getSavedChatWindowBounds(): Promise<WindowBounds | null> {
  const data = await chrome.storage.local.get(['chatWinLeft', 'chatWinTop', 'chatWinWidth', 'chatWinHeight']);
  const left = typeof data.chatWinLeft === 'number' ? data.chatWinLeft : null;
  const top = typeof data.chatWinTop === 'number' ? data.chatWinTop : null;
  const width = typeof data.chatWinWidth === 'number' ? data.chatWinWidth : null;
  const height = typeof data.chatWinHeight === 'number' ? data.chatWinHeight : null;
  if (left == null || top == null || width == null || height == null) return null;
  return { left, top, width, height };
}

async function getSavedPopupSize(): Promise<PopupSize | null> {
  const data = await chrome.storage.local.get(['popupWidth', 'popupHeight']);
  const width = typeof data.popupWidth === 'number' ? data.popupWidth : null;
  const height = typeof data.popupHeight === 'number' ? data.popupHeight : null;
  if (width == null || height == null) return null;
  return { width, height };
}

async function savePopupSize(size: PopupSize): Promise<void> {
  await chrome.storage.local.set({ popupWidth: size.width, popupHeight: size.height });
}

function applyPopupSize(size: PopupSize) {
  const width = clamp(Math.round(size.width), POPUP_SIZE_MIN.width, POPUP_SIZE_MAX.width);
  const height = clamp(Math.round(size.height), POPUP_SIZE_MIN.height, POPUP_SIZE_MAX.height);

  document.documentElement.style.setProperty('--popup-width', `${width}px`);
  document.documentElement.style.setProperty('--popup-height', `${height}px`);

  // Extra forcing for extension popup sizing behavior.
  document.documentElement.style.width = `${width}px`;
  document.documentElement.style.height = `${height}px`;
  document.body.style.width = `${width}px`;
  document.body.style.height = `${height}px`;

  const app = document.querySelector('.app') as HTMLElement | null;
  if (app) {
    app.style.width = `${width}px`;
    app.style.height = `${height}px`;
  }
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

type TabContext = {
  title: string;
  url: string;
  selection: string;
  textExcerpt: string;
};

const CUSTOM_MODEL_VALUE = '__custom__';

type SettingsModelUiSync = {
  isOpen: () => boolean;
  syncModel: (model: string) => void;
  refreshModels: () => Promise<void>;
};

let settingsModelUiSync: SettingsModelUiSync | null = null;

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

function getMaxHeightPx(el: HTMLElement): number | null {
  const maxHeight = getComputedStyle(el).maxHeight;
  if (!maxHeight || maxHeight === 'none') return null;
  const px = Number.parseFloat(maxHeight);
  return Number.isFinite(px) ? px : null;
}

function getCssVarPx(name: string): number | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return null;
  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function getCurrentPopupSize(): PopupSize {
  const app = document.querySelector('.app') as HTMLElement | null;
  const rect = app?.getBoundingClientRect();
  const rectWidth = rect && rect.width > 0 ? rect.width : null;
  const rectHeight = rect && rect.height > 0 ? rect.height : null;
  return {
    width: getCssVarPx('--popup-width') ?? rectWidth ?? document.body.getBoundingClientRect().width ?? POPUP_SIZE_DEFAULT.width,
    height: getCssVarPx('--popup-height') ?? rectHeight ?? document.body.getBoundingClientRect().height ?? POPUP_SIZE_DEFAULT.height
  };
}

function setupPopupResize() {
  const bar = document.getElementById('resizeBar') as HTMLDivElement | null;
  if (!bar) return;
  const grip = document.getElementById('resizeGrip') as HTMLDivElement | null;

  type Mode = 'height' | 'width' | 'both';

  const finish = () => {
    document.body.classList.remove('resizing', 'both');
    const size = getCurrentPopupSize();
    void savePopupSize({
      width: clamp(Math.round(size.width), POPUP_SIZE_MIN.width, POPUP_SIZE_MAX.width),
      height: clamp(Math.round(size.height), POPUP_SIZE_MIN.height, POPUP_SIZE_MAX.height)
    });
  };

  const startDrag = (mode: Mode, startX: number, startY: number) => {
    const start = getCurrentPopupSize();
    document.body.classList.add('resizing');
    if (mode === 'both') document.body.classList.add('both');

    const onMove = (clientX: number, clientY: number) => {
      const dx = clientX - startX;
      const dy = clientY - startY;
      applyPopupSize({
        width: mode === 'width' || mode === 'both' ? start.width + dx : start.width,
        height: mode === 'height' || mode === 'both' ? start.height + dy : start.height
      });
    };

    // Mouse fallback (most reliable in extension popups)
    const onMouseMove = (ev: MouseEvent) => onMove(ev.clientX, ev.clientY);
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      finish();
    };

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
  };

  const onBarMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();

    const edge = 28;
    const inRightEdge = ev.offsetX >= bar.clientWidth - edge;
    const mode: Mode = ev.shiftKey ? 'both' : inRightEdge ? 'width' : 'height';
    startDrag(mode, ev.clientX, ev.clientY);
  };

  const onGripMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    startDrag('both', ev.clientX, ev.clientY);
  };

  // Pointer events for touch / trackpads.
  const onPointerDown = (mode: Mode) => (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();

    const startX = ev.clientX;
    const startY = ev.clientY;
    const start = getCurrentPopupSize();
    document.body.classList.add('resizing');
    if (mode === 'both') document.body.classList.add('both');

    const target = ev.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    const onMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      applyPopupSize({
        width: mode === 'width' || mode === 'both' ? start.width + dx : start.width,
        height: mode === 'height' || mode === 'both' ? start.height + dy : start.height
      });
    };

    const onUp = (upEv: PointerEvent) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      try {
        target.releasePointerCapture(upEv.pointerId);
      } catch {
        // ignore
      }
      finish();
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  bar.addEventListener('mousedown', onBarMouseDown);
  bar.addEventListener('pointerdown', (ev) => {
    const edge = 28;
    const mode: Mode = ev.shiftKey ? 'both' : ev.offsetX >= bar.clientWidth - edge ? 'width' : 'height';
    onPointerDown(mode)(ev);
  });
  if (grip) {
    grip.addEventListener('mousedown', onGripMouseDown);
    grip.addEventListener('pointerdown', onPointerDown('both'));
  }
}

async function openPopoutWindow() {
  const bounds = (await getSavedChatWindowBounds()) ?? {
    left: 80,
    top: 80,
    ...getCurrentPopupSize()
  };

  const url = new URL(chrome.runtime.getURL('src/chat/chat.html'));
  url.searchParams.set('popout', '1');

  await chrome.windows.create({
    url: url.toString(),
    type: 'popup',
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });
}

function setupSettingsModal(onSaved: () => void) {
  const overlay = document.getElementById('settingsOverlay') as HTMLDivElement | null;
  const openBtn = document.getElementById('settingsBtn') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('settingsCloseBtn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('settingsCancelBtn') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('settingsSaveBtn') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('settingsResetBtn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('settingsStatus') as HTMLSpanElement | null;

  const baseUrlEl = document.getElementById('settingsBaseUrl') as HTMLInputElement | null;
  const modelSelectEl = document.getElementById('settingsModelSelect') as HTMLSelectElement | null;
  const modelCustomEl = document.getElementById('settingsModelCustom') as HTMLInputElement | null;
  const themeEl = document.getElementById('settingsTheme') as HTMLSelectElement | null;
  const fontEl = document.getElementById('settingsFontFamily') as HTMLSelectElement | null;
  const sizeEl = document.getElementById('settingsFontSize') as HTMLInputElement | null;

  if (!overlay || !openBtn || !closeBtn || !cancelBtn || !saveBtn || !resetBtn) return;
  if (!baseUrlEl || !modelSelectEl || !modelCustomEl || !themeEl || !fontEl || !sizeEl || !statusEl) return;

  let lastLoaded: Settings | null = null;

  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  const setModelUiMode = (mode: 'select' | 'custom') => {
    const showCustom = mode === 'custom';
    modelCustomEl.hidden = !showCustom;
    modelSelectEl.hidden = showCustom;
  };

  const populateModelUi = async (savedModel: string) => {
    const models = await fetchModels();

    modelSelectEl.innerHTML = '';

    if (models.length === 0) {
      // Ollama unreachable or returned no models; still allow a custom model name.
      setModelUiMode('custom');
      modelCustomEl.value = savedModel;
      return;
    }

    // Model list available.
    setModelUiMode('select');

    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      modelSelectEl.appendChild(opt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM_MODEL_VALUE;
    customOpt.textContent = 'Custom…';
    modelSelectEl.appendChild(customOpt);

    if (models.includes(savedModel)) {
      modelSelectEl.value = savedModel;
      modelCustomEl.value = savedModel;
      modelCustomEl.hidden = true;
    } else {
      modelSelectEl.value = CUSTOM_MODEL_VALUE;
      modelCustomEl.value = savedModel;
      modelCustomEl.hidden = false;
    }
  };

  const getSelectedModelFromUi = (): string => {
    if (!modelSelectEl.hidden) {
      if (modelSelectEl.value === CUSTOM_MODEL_VALUE) return modelCustomEl.value.trim();
      return modelSelectEl.value.trim();
    }
    return modelCustomEl.value.trim();
  };

  const populate = async () => {
    const s = await getSettings();
    lastLoaded = s;
    baseUrlEl.value = s.baseUrl;
    await populateModelUi(s.model);
    themeEl.value = s.theme;
    fontEl.value = s.fontFamily;
    sizeEl.value = String(s.fontSize);
  };

  const open = async () => {
    setStatus('');
    await populate();
    overlay.hidden = false;
    overlay.style.display = 'grid';
    baseUrlEl.focus();
    baseUrlEl.select();
  };

  const close = () => {
    overlay.hidden = true;
    overlay.style.display = 'none';
    setStatus('');
    openBtn.focus();
  };

  const syncModelToUi = (model: string) => {
    // If modal isn't open, don't do any work.
    if (overlay.hidden) return;

    if (modelSelectEl.hidden) {
      modelCustomEl.value = model;
      return;
    }

    // When select is visible, try to set it to the model if present, otherwise fall back to Custom.
    const hasModelOption = Array.from(modelSelectEl.options).some((o) => o.value === model);
    if (hasModelOption) {
      modelSelectEl.value = model;
      modelCustomEl.value = model;
      modelCustomEl.hidden = true;
    } else {
      modelSelectEl.value = CUSTOM_MODEL_VALUE;
      modelCustomEl.value = model;
      modelCustomEl.hidden = false;
    }
  };

  settingsModelUiSync = {
    isOpen: () => !overlay.hidden,
    syncModel: syncModelToUi,
    refreshModels: async () => {
      const s = await getSettings();
      await populateModelUi(s.model);
    }
  };

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });

  document.addEventListener('keydown', (ev) => {
    if (overlay.hidden) return;
    if (ev.key === 'Escape') close();
  });

  modelSelectEl.addEventListener('change', () => {
    if (modelSelectEl.value === CUSTOM_MODEL_VALUE) {
      modelCustomEl.hidden = false;
      modelCustomEl.focus();
      modelCustomEl.select();
    } else {
      modelCustomEl.hidden = true;
      modelCustomEl.value = modelSelectEl.value;
    }
  });

  // Ensure hidden overlays are not accidentally left visible due to CSS.
  overlay.style.display = overlay.hidden ? 'none' : 'grid';

  openBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void open();
  });
  closeBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    close();
  });
  cancelBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    close();
  });

  saveBtn.addEventListener('click', () => {
    setStatus('');
    saveBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        const baseUrl = baseUrlEl.value.trim();
        const model = getSelectedModelFromUi();
        const theme = themeEl.value as Settings['theme'];
        const fontFamily = fontEl.value as Settings['fontFamily'];
        const fontSize = Number.parseInt(sizeEl.value, 10);

        if (!baseUrl || !isValidHttpUrl(baseUrl)) throw new Error('Base URL must be http(s)://…');
        if (!model) throw new Error('Default model cannot be empty');
        if (!Number.isFinite(fontSize) || fontSize < 11 || fontSize > 20) throw new Error('Font size must be 11–20');

        await setSettings({ baseUrl, model, theme, fontFamily, fontSize });
        const s = await getSettings();
        lastLoaded = s;
        applyUiSettings(s);
        onSaved();
        // Ensure the UI reflects the stored default model.
        syncModelToUi(s.model);
        // Close immediately after saving to keep the popup uncluttered.
        close();
      })
      .catch((e) => {
        setStatus(String((e as any)?.message ?? e));
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  resetBtn.addEventListener('click', () => {
    setStatus('');
    resetBtn.disabled = true;

    Promise.resolve()
      .then(async () => {
        await setSettings(DEFAULT_SETTINGS);
        const s = await getSettings();
        lastLoaded = s;
        applyUiSettings(s);
        onSaved();

        baseUrlEl.value = s.baseUrl;
        await populateModelUi(s.model);
        themeEl.value = s.theme;
        fontEl.value = s.fontFamily;
        sizeEl.value = String(s.fontSize);
        setStatus('Reset.');
      })
      .catch((e) => setStatus(String((e as any)?.message ?? e)))
      .finally(() => {
        resetBtn.disabled = false;
      });
  });
}

function autoGrowTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const max = getMaxHeightPx(el);
  const height = max == null ? el.scrollHeight : Math.min(el.scrollHeight, max);
  el.style.height = `${height}px`;
}

function setContextBadge(text: string, visible: boolean) {
  const badge = document.getElementById('contextBadge') as HTMLSpanElement | null;
  if (!badge) return;
  badge.hidden = !visible;
  badge.textContent = text;
}

async function getTabContext(maxChars = 8000): Promise<TabContext> {
  const resp = await sendMessage({ type: 'TAB_CONTEXT_GET', maxChars });
  if (!resp.ok) throw new Error(formatError(resp));
  if (resp.type !== 'TAB_CONTEXT_GET_RESULT') throw new Error('Unexpected response while reading tab context');
  return resp.context;
}

function buildContextBlock(ctx: TabContext): string {
  const selection = ctx.selection?.trim();
  const excerpt = ctx.textExcerpt?.trim();
  const body = selection || excerpt || '';
  const clipped = body.length > 2000 ? body.slice(0, 2000) + '…' : body;

  return [
    'Context (current tab):',
    `Title: ${ctx.title}`,
    `URL: ${ctx.url}`,
    '',
    '```',
    clipped,
    '```',
    ''
  ].join('\n');
}

async function loadModels() {
  const modelSelect = $('modelSelect') as HTMLSelectElement;
  modelSelect.innerHTML = '';

  const settings = await getSettings();

  const models = await fetchModels();
  if (models.length === 0) {
    // If listing fails (e.g. Ollama down), still provide a reasonable default.
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model;
    modelSelect.appendChild(opt);
    modelSelect.value = settings.model;
    return;
  }

  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    modelSelect.appendChild(opt);
  }

  // Keep the stored model selectable even if Ollama didn't report it.
  const hasStoredModel = models.includes(settings.model);
  if (!hasStoredModel) {
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model;
    modelSelect.appendChild(opt);
  }

  modelSelect.value = settings.model;
}

async function fetchModels(): Promise<string[]> {
  try {
    const resp = await sendMessage({ type: 'OLLAMA_LIST_MODELS' });
    if (!resp.ok) return [];
    if (resp.type !== 'OLLAMA_LIST_MODELS_RESULT') return [];
    return Array.isArray(resp.models) ? resp.models : [];
  } catch {
    return [];
  }
}

async function onGenerate() {
  if (state.generating) return;

  const promptEl = $('prompt') as HTMLTextAreaElement;
  const prompt = promptEl.value;
  const model = ($('modelSelect') as HTMLSelectElement).value;

  const useContext = (document.getElementById('useContextToggle') as HTMLInputElement | null)?.checked ?? false;

  const trimmed = prompt.trim();
  if (!trimmed) return;

  promptEl.value = '';
  autoGrowTextarea(promptEl);

  addMessage('user', trimmed);
  const thinkingId = addMessage('assistant', 'Thinking…', true);
  setGenerating(true);

  try {
    let finalPrompt = trimmed;
    if (useContext) {
      try {
        const ctx = await getTabContext(8000);
        finalPrompt = buildContextBlock(ctx) + trimmed;
        setContextBadge('Context attached', true);
        // After a moment, revert badge text but keep visible while enabled.
        setTimeout(() => {
          const stillEnabled =
            (document.getElementById('useContextToggle') as HTMLInputElement | null)?.checked ?? false;
          setContextBadge(stillEnabled ? 'Context on' : 'Context off', stillEnabled);
        }, 1500);
      } catch (e) {
        // Context is optional; show a system message and continue without it.
        addMessage('system', `Context not attached: ${String((e as any)?.message ?? e)}`);
      }
    }

    const resp = await sendMessage({ type: 'OLLAMA_GENERATE', prompt: finalPrompt, model });
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
  applyPopupSize((await getSavedPopupSize()) ?? POPUP_SIZE_DEFAULT);
  setupPopupResize();

  // Apply theme + typography ASAP.
  applyUiSettings(await getSettings());

  const btn = $('generateBtn') as HTMLButtonElement;
  const promptEl = $('prompt') as HTMLTextAreaElement;
  const modelSelect = $('modelSelect') as HTMLSelectElement;
  const useContextToggle = document.getElementById('useContextToggle') as HTMLInputElement | null;
  const popoutBtn = document.getElementById('popoutBtn') as HTMLButtonElement | null;

  btn.addEventListener('click', () => void onGenerate());

  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => void openPopoutWindow());
  }

  setupSettingsModal(() => {
    // Reload models if base URL / default model changed.
    void loadModels();
  });

  modelSelect.addEventListener('change', () => {
    const model = modelSelect.value;
    void setSettings({ model });
    settingsModelUiSync?.syncModel(model);
  });

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

  if (useContextToggle) {
    useContextToggle.addEventListener('change', () => {
      const enabled = useContextToggle.checked;
      setContextBadge(enabled ? 'Context on' : 'Context off', enabled);
    });
    // Default off
    setContextBadge('Context off', false);
  }

  try {
    await loadModels();
  } catch (e) {
    addMessage('error', `Failed to load models. Is Ollama running?\n${String((e as any)?.message ?? e)}`);
  }
}

main().catch((e) => {
  addMessage('error', String((e as any)?.message ?? e));
});
