import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPreviewCacheKey } from '../src/lib/contextPreviewCacheKey.js';

test('buildContextPreviewCacheKey is stable for same inputs', () => {
  const a = buildContextPreviewCacheKey({ tabId: 123, includeSelection: true, includeExcerpt: false, maxChars: 2000 });
  const b = buildContextPreviewCacheKey({ tabId: 123, includeSelection: true, includeExcerpt: false, maxChars: 2000 });
  assert.equal(a, b);
});

test('buildContextPreviewCacheKey changes with tabId/prefs/budget', () => {
  const base = buildContextPreviewCacheKey({ tabId: 123, includeSelection: true, includeExcerpt: false, maxChars: 2000 });

  assert.notEqual(
    base,
    buildContextPreviewCacheKey({ tabId: 124, includeSelection: true, includeExcerpt: false, maxChars: 2000 })
  );
  assert.notEqual(
    base,
    buildContextPreviewCacheKey({ tabId: 123, includeSelection: false, includeExcerpt: false, maxChars: 2000 })
  );
  assert.notEqual(
    base,
    buildContextPreviewCacheKey({ tabId: 123, includeSelection: true, includeExcerpt: true, maxChars: 2000 })
  );
  assert.notEqual(
    base,
    buildContextPreviewCacheKey({ tabId: 123, includeSelection: true, includeExcerpt: false, maxChars: 2500 })
  );

  assert.notEqual(
    base,
    buildContextPreviewCacheKey({
      tabId: 123,
      includeSelection: true,
      includeExcerpt: false,
      maxChars: 2000,
      contextCleared: true
    })
  );

  assert.notEqual(
    base,
    buildContextPreviewCacheKey({
      tabId: 123,
      includeSelection: true,
      includeExcerpt: false,
      maxChars: 2000,
      netContextVersion: 1
    })
  );
});

test('buildContextPreviewCacheKey treats invalid tabId as active', () => {
  const a = buildContextPreviewCacheKey({ tabId: null, includeSelection: true, includeExcerpt: true, maxChars: 2000 });
  const b = buildContextPreviewCacheKey({ tabId: 0, includeSelection: true, includeExcerpt: true, maxChars: 2000 });
  assert.equal(a, b);
  assert.match(a, /^tab:active\|/);
});
