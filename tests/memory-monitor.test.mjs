import test from 'node:test';
import assert from 'node:assert/strict';
import { browserMemory, formatMemory } from '../public/shared/memory-monitor.mjs';

const MiB = 1024 ** 2, GiB = 1024 ** 3;

test('browser memory separates heap headroom, physical RAM estimate and analysis budget', () => {
  const snapshot = browserMemory({ performance: { memory: { usedJSHeapSize: 64 * MiB, totalJSHeapSize: 96 * MiB, jsHeapSizeLimit: 256 * MiB }, measureUserAgentSpecificMemory() {} }, navigator: { deviceMemory: 8 }, crossOriginIsolated: true });
  assert.deepEqual(snapshot.heap, { used: 64 * MiB, allocated: 96 * MiB, limit: 256 * MiB, headroom: 192 * MiB });
  assert.equal(snapshot.budget.budgetMB, 2048);
  assert.equal(snapshot.budget.deviceMemoryGB, 8);
  assert.equal(snapshot.canMeasure, true);
  assert.equal(Object.hasOwn(snapshot, 'freeBytes'), false, 'Physical free RAM cannot be inferred from browser heap data');
});

test('missing and invalid browser APIs remain unavailable, with the existing 512 MiB fallback budget', () => {
  const missing = browserMemory({});
  assert.equal(missing.heap, null); assert.equal(missing.canMeasure, false);
  assert.equal(missing.budget.budgetMB, 512);
  assert.equal(browserMemory({ performance: { memory: { usedJSHeapSize: NaN, totalJSHeapSize: 5, jsHeapSizeLimit: 10 } } }).heap, null);
  assert.equal(browserMemory({ performance: { measureUserAgentSpecificMemory() {} }, crossOriginIsolated: false }).canMeasure, false);
  assert.equal(formatMemory(null), '取得できません'); assert.equal(formatMemory(undefined), '取得できません');
  assert.equal(formatMemory(0), '0 MiB'); assert.equal(formatMemory(512 * MiB), '512.0 MiB');
  assert.equal(formatMemory(2 * GiB), '2.00 GiB');
});
