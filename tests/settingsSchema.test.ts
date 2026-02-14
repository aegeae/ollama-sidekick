import test from 'node:test';
import assert from 'node:assert/strict';

import { coerceSettingsFromStorage, validateSettingsPatch } from '../src/lib/settingsSchema.js';

test('coerceSettingsFromStorage uses defaults for history settings', () => {
  const s = coerceSettingsFromStorage({});
  assert.equal(s.historyStorageMode, 'local');
  assert.equal(s.historyExportFormat, 'json');
});

test('validateSettingsPatch validates history settings', () => {
  const ok = validateSettingsPatch({ historyStorageMode: 'folder', historyExportFormat: 'md' });
  assert.equal(ok.historyStorageMode, 'folder');
  assert.equal(ok.historyExportFormat, 'md');

  assert.throws(() => validateSettingsPatch({ historyStorageMode: 'disk' as any }), /history storage mode/i);
  assert.throws(() => validateSettingsPatch({ historyExportFormat: 'txt' as any }), /history export format/i);
});
