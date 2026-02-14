import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearChatIdForTabInMap,
  getChatIdForTabFromMap,
  normalizeTabChatMap,
  setChatIdForTabInMap
} from '../src/lib/sessionTabChatMap.js';

test('normalizeTabChatMap returns empty for non-objects', () => {
  assert.deepEqual(normalizeTabChatMap(null), {});
  assert.deepEqual(normalizeTabChatMap(undefined), {});
  assert.deepEqual(normalizeTabChatMap([]), {});
  assert.deepEqual(normalizeTabChatMap('x'), {});
});

test('normalizeTabChatMap keeps only string->string entries', () => {
  const raw = {
    '123': 'chat-a',
    '456': ' chat-b ',
    '': 'nope',
    abc: 'chat-c',
    ok: 42,
    nope: null
  };
  assert.deepEqual(normalizeTabChatMap(raw), { '123': 'chat-a', '456': ' chat-b ' });
});

test('getChatIdForTabFromMap reads by numeric tab id', () => {
  const map = normalizeTabChatMap({ '12': 'chat-x' });
  assert.equal(getChatIdForTabFromMap(map, 12), 'chat-x');
  assert.equal(getChatIdForTabFromMap(map, 13), null);
});

test('setChatIdForTabInMap sets mapping immutably', () => {
  const map = normalizeTabChatMap({ '12': 'chat-x' });
  const next = setChatIdForTabInMap(map, 12, 'chat-y');
  assert.deepEqual(map, { '12': 'chat-x' });
  assert.deepEqual(next, { '12': 'chat-y' });
});

test('clearChatIdForTabInMap deletes mapping immutably', () => {
  const map = normalizeTabChatMap({ '12': 'chat-x', '13': 'chat-y' });
  const next = clearChatIdForTabInMap(map, 12);
  assert.deepEqual(map, { '12': 'chat-x', '13': 'chat-y' });
  assert.deepEqual(next, { '13': 'chat-y' });
});
