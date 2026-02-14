export type Settings = {
  baseUrl: string;
  model: string;
  theme: 'system' | 'dark' | 'light';
  fontFamily: 'system' | 'sans' | 'serif' | 'mono';
  fontSize: number;
};

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://localhost:11434',
  model: 'llama3.1',
  theme: 'system',
  fontFamily: 'system',
  fontSize: 13
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(['baseUrl', 'model', 'theme', 'fontFamily', 'fontSize']);

  const theme = data.theme === 'dark' || data.theme === 'light' || data.theme === 'system' ? data.theme : null;
  const fontFamily =
    data.fontFamily === 'system' || data.fontFamily === 'sans' || data.fontFamily === 'serif' || data.fontFamily === 'mono'
      ? data.fontFamily
      : null;

  const fontSizeRaw = typeof data.fontSize === 'number' ? data.fontSize : null;
  const fontSize = fontSizeRaw == null ? null : clamp(Math.round(fontSizeRaw), 11, 20);

  return {
    baseUrl: typeof data.baseUrl === 'string' && data.baseUrl.length > 0 ? data.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: typeof data.model === 'string' && data.model.length > 0 ? data.model : DEFAULT_SETTINGS.model,
    theme: theme ?? DEFAULT_SETTINGS.theme,
    fontFamily: fontFamily ?? DEFAULT_SETTINGS.fontFamily,
    fontSize: fontSize ?? DEFAULT_SETTINGS.fontSize
  };
}

export async function setSettings(partial: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(partial);
}
