import test from 'node:test';
import assert from 'node:assert/strict';

import { coerceSettingsFromStorage, validateSettingsPatch } from '../src/lib/settingsSchema.js';

test('coerceSettingsFromStorage defaults alwaysOpenPopout to false', () => {
  const s = coerceSettingsFromStorage({});
  assert.equal(s.alwaysOpenPopout, false);
});

test('coerceSettingsFromStorage preserves alwaysOpenPopout when boolean', () => {
  const s1 = coerceSettingsFromStorage({ alwaysOpenPopout: true });
  assert.equal(s1.alwaysOpenPopout, true);

  const s2 = coerceSettingsFromStorage({ alwaysOpenPopout: false });
  assert.equal(s2.alwaysOpenPopout, false);
});

test('validateSettingsPatch validates alwaysOpenPopout type', () => {
  const ok = validateSettingsPatch({ alwaysOpenPopout: true });
  assert.equal(ok.alwaysOpenPopout, true);

  assert.throws(() => validateSettingsPatch({ alwaysOpenPopout: 'yes' as any }), /always-open-popout/i);
});
