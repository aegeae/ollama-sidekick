import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextBlock, buildPromptWithOptionalContext } from '../src/lib/promptWithContext.js';

test('buildPromptWithOptionalContext returns raw prompt when no ctx', () => {
  assert.equal(buildPromptWithOptionalContext('hello', null), 'hello');
  assert.equal(buildPromptWithOptionalContext('hello', undefined), 'hello');
});

test('buildContextBlock prefers selection over excerpt', () => {
  const block = buildContextBlock({
    title: 'T',
    url: 'U',
    selection: 'SEL',
    textExcerpt: 'EX'
  });
  assert.match(block, /SEL/);
  assert.doesNotMatch(block, /\nEX\n/);
});

test('buildPromptWithOptionalContext prefixes context block', () => {
  const out = buildPromptWithOptionalContext('Ask?', { title: 'T', url: 'U', selection: 'S' });
  assert.ok(out.startsWith('Context (active tab):'));
  assert.ok(out.endsWith('Ask?'));
});
