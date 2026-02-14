import test from 'node:test';
import assert from 'node:assert/strict';

import { getRestrictedPageHint, isRestrictedUrl } from '../src/lib/restrictedUrl.js';

test('isRestrictedUrl detects browser/extension/store pages', () => {
  assert.equal(isRestrictedUrl('chrome://extensions'), true);
  assert.equal(isRestrictedUrl('brave://settings'), true);
  assert.equal(isRestrictedUrl('edge://version'), true);
  assert.equal(isRestrictedUrl('chrome-extension://abc123/index.html'), true);
  assert.equal(isRestrictedUrl('https://chrome.google.com/webstore/detail/xyz'), true);
  assert.equal(isRestrictedUrl('https://chromewebstore.google.com/detail/xyz'), true);
  assert.equal(isRestrictedUrl('file:///Users/me/test.html'), true);
  assert.equal(isRestrictedUrl('  CHROME://flags  '), true);
});

test('isRestrictedUrl allows normal webpages', () => {
  assert.equal(isRestrictedUrl('https://example.com/'), false);
  assert.equal(isRestrictedUrl('http://localhost:8080/'), false);
});

test('getRestrictedPageHint returns friendly message', () => {
  const hint = getRestrictedPageHint('https://chrome.google.com/webstore/detail/xyz');
  assert.ok(hint && hint.toLowerCase().includes('chrome web store'));
});
