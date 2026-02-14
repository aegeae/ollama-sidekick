import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSidebarWidthExpanded } from '../src/lib/sidebarResizeMath.js';

test('computeSidebarWidthExpanded clamps to min/max', () => {
  assert.equal(computeSidebarWidthExpanded(220, 100, -999, 200, 420), 200);
  assert.equal(computeSidebarWidthExpanded(220, 100, 9999, 200, 420), 420);
});

test('computeSidebarWidthExpanded adds dx relative to start', () => {
  assert.equal(computeSidebarWidthExpanded(220, 100, 130, 200, 420), 250);
  assert.equal(computeSidebarWidthExpanded(300, 500, 480, 200, 420), 280);
});
