import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTokenBudget } from '../src/lib/ollamaModelInfo.js';

test('extractTokenBudget reads direct numeric fields', () => {
  assert.equal(extractTokenBudget({ context_length: 8192 }), 8192);
  assert.equal(extractTokenBudget({ num_ctx: 4096 }), 4096);
});

test('extractTokenBudget reads model_info known keys', () => {
  assert.equal(extractTokenBudget({ model_info: { 'llama.context_length': 16384 } }), 16384);
  assert.equal(extractTokenBudget({ model_info: { context_len: 2048 } }), 2048);
});

test('extractTokenBudget ignores non-numbers and absurd values', () => {
  assert.equal(extractTokenBudget({ context_length: '8192' as any }), null);
  assert.equal(extractTokenBudget({ context_length: -1 }), null);
  assert.equal(extractTokenBudget({ context_length: 9_999_999 }), null);
});
