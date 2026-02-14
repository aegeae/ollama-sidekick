import test from 'node:test';
import assert from 'node:assert/strict';

import { compileDiagnosticsFilter } from '../src/lib/diagnosticsFilter.js';

test('compileDiagnosticsFilter: * matches all', () => {
  const f = compileDiagnosticsFilter('*');
  assert.equal(f.kind, 'all');
  assert.equal(f.matcher('anything'), true);
  assert.equal(f.matcher(''), true);
});

test('compileDiagnosticsFilter: empty matches all', () => {
  const f = compileDiagnosticsFilter('   ');
  assert.equal(f.kind, 'all');
  assert.equal(f.raw, '*');
  assert.equal(f.matcher('anything'), true);
});

test('compileDiagnosticsFilter: text matches case-insensitively', () => {
  const f = compileDiagnosticsFilter('hello');
  assert.equal(f.kind, 'text');
  assert.equal(f.matcher('HELLO world'), true);
  assert.equal(f.matcher('nope'), false);
});

test('compileDiagnosticsFilter: regex literal works with flags', () => {
  const f = compileDiagnosticsFilter('/he.+o/i');
  assert.equal(f.kind, 'regex');
  assert.equal(f.matcher('HELLO world'), true);
  assert.equal(f.matcher('hxo'), false);
});

test('compileDiagnosticsFilter: invalid regex returns match-all with error', () => {
  const f = compileDiagnosticsFilter('/(/');
  assert.equal(f.kind, 'regex');
  assert.ok(typeof f.error === 'string' && f.error.toLowerCase().includes('invalid'));
  assert.equal(f.matcher('anything'), true);
});
