export type Settings = {
  baseUrl: string;
  model: string;
  theme: 'system' | 'dark' | 'light';
  fontFamily: 'system' | 'sans' | 'serif' | 'mono' | 'jetbrainsMono';
  fontSize: number;
  historyStorageMode: 'local' | 'folder';
  historyExportFormat: 'json' | 'md' | 'jsonl';
  historyAutoExportOnSend: boolean;
  alwaysOpenPopout: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://localhost:11434',
  model: '',
  theme: 'system',
  fontFamily: 'jetbrainsMono',
  fontSize: 13,
  historyStorageMode: 'local',
  historyExportFormat: 'json',
  historyAutoExportOnSend: false,
  alwaysOpenPopout: false
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function normalizeAndValidateBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('Base URL is empty');

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Base URL must be a valid URL (example: http://localhost:11434)');
  }

  if (u.protocol !== 'http:') {
    throw new Error('Base URL must use http:// (Ollama runs over HTTP by default)');
  }

  const hostname = u.hostname;
  const port = u.port || (u.protocol === 'http:' ? '80' : '');

  // Store-friendly + privacy-friendly default: only allow local Ollama.
  const allowedHost = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!allowedHost) {
    throw new Error('Base URL must be local (http://localhost:11434 or http://127.0.0.1:11434)');
  }

  if (port !== '11434') {
    throw new Error('Base URL must use port 11434 (update manifest host permissions if you changed it)');
  }

  // Normalize to origin only; paths are not supported as a base URL.
  return `${u.protocol}//${u.host}`;
}

export function coerceSettingsFromStorage(data: Record<string, unknown>): Settings {
  const theme = data.theme === 'dark' || data.theme === 'light' || data.theme === 'system' ? data.theme : null;
  const fontFamily =
    data.fontFamily === 'system' ||
    data.fontFamily === 'sans' ||
    data.fontFamily === 'serif' ||
    data.fontFamily === 'mono' ||
    data.fontFamily === 'jetbrainsMono'
      ? data.fontFamily
      : null;

  const fontSizeRaw = typeof data.fontSize === 'number' ? data.fontSize : null;
  const fontSize = fontSizeRaw == null ? null : clamp(Math.round(fontSizeRaw), 11, 20);

  const historyStorageMode = data.historyStorageMode === 'local' || data.historyStorageMode === 'folder' ? data.historyStorageMode : null;
  const historyExportFormat =
    data.historyExportFormat === 'json' || data.historyExportFormat === 'md' || data.historyExportFormat === 'jsonl'
      ? data.historyExportFormat
      : null;

  const historyAutoExportOnSend = typeof data.historyAutoExportOnSend === 'boolean' ? data.historyAutoExportOnSend : null;
  const alwaysOpenPopout = typeof data.alwaysOpenPopout === 'boolean' ? data.alwaysOpenPopout : null;

  let baseUrl = DEFAULT_SETTINGS.baseUrl;
  if (typeof data.baseUrl === 'string' && data.baseUrl.length > 0) {
    try {
      baseUrl = normalizeAndValidateBaseUrl(data.baseUrl);
    } catch {
      baseUrl = DEFAULT_SETTINGS.baseUrl;
    }
  }

  return {
    baseUrl,
    model: typeof data.model === 'string' && data.model.trim().length > 0 ? data.model.trim() : DEFAULT_SETTINGS.model,
    theme: theme ?? DEFAULT_SETTINGS.theme,
    fontFamily: fontFamily ?? DEFAULT_SETTINGS.fontFamily,
    fontSize: fontSize ?? DEFAULT_SETTINGS.fontSize,
    historyStorageMode: historyStorageMode ?? DEFAULT_SETTINGS.historyStorageMode,
    historyExportFormat: historyExportFormat ?? DEFAULT_SETTINGS.historyExportFormat,
    historyAutoExportOnSend: historyAutoExportOnSend ?? DEFAULT_SETTINGS.historyAutoExportOnSend,
    alwaysOpenPopout: alwaysOpenPopout ?? DEFAULT_SETTINGS.alwaysOpenPopout
  };
}

export function validateSettingsPatch(partial: Partial<Settings>): Partial<Settings> {
  const patch: Partial<Settings> = { ...partial };

  if (typeof patch.baseUrl === 'string') {
    patch.baseUrl = normalizeAndValidateBaseUrl(patch.baseUrl);
  }

  if (patch.historyStorageMode != null) {
    if (patch.historyStorageMode !== 'local' && patch.historyStorageMode !== 'folder') {
      throw new Error('Invalid history storage mode');
    }
  }

  if (patch.historyExportFormat != null) {
    if (patch.historyExportFormat !== 'json' && patch.historyExportFormat !== 'md' && patch.historyExportFormat !== 'jsonl') {
      throw new Error('Invalid history export format');
    }
  }

  if (patch.historyAutoExportOnSend != null) {
    if (typeof patch.historyAutoExportOnSend !== 'boolean') {
      throw new Error('Invalid history auto-export setting');
    }
  }

  if (patch.alwaysOpenPopout != null) {
    if (typeof patch.alwaysOpenPopout !== 'boolean') {
      throw new Error('Invalid always-open-popout setting');
    }
  }

  return patch;
}
