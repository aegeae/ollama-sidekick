import test from 'node:test';
import assert from 'node:assert/strict';

import { tabTitleToChatTitle } from '../src/lib/tabTitleToChatTitle.js';

test('tabTitleToChatTitle trims and collapses whitespace', () => {
  assert.equal(tabTitleToChatTitle('  Hello\n\tworld  '), 'Hello world');
});

test('tabTitleToChatTitle returns empty string for empty-ish input', () => {
  assert.equal(tabTitleToChatTitle('   '), '');
  assert.equal(tabTitleToChatTitle(''), '');
});
