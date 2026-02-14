export type Settings = {
  baseUrl: string;
  model: string;
};

const DEFAULTS: Settings = {
  baseUrl: 'http://localhost:11434',
  model: 'llama3.1'
};

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(['baseUrl', 'model']);
  return {
    baseUrl: typeof data.baseUrl === 'string' && data.baseUrl.length > 0 ? data.baseUrl : DEFAULTS.baseUrl,
    model: typeof data.model === 'string' && data.model.length > 0 ? data.model : DEFAULTS.model
  };
}

export async function setSettings(partial: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(partial);
}
