import { coerceSettingsFromStorage, validateSettingsPatch } from './settingsSchema';
import type { Settings } from './settingsSchema';

export { DEFAULT_SETTINGS, type Settings } from './settingsSchema';

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get([
    'baseUrl',
    'model',
    'theme',
    'fontFamily',
    'fontSize',
    'historyStorageMode',
    'historyExportFormat',
    'historyAutoExportOnSend',
    'alwaysOpenPopout'
  ]);

  return coerceSettingsFromStorage(data);
}

export async function setSettings(partial: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(validateSettingsPatch(partial));
}
