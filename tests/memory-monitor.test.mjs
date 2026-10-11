import test from 'node:test';
import assert from 'node:assert/strict';
import { browserMemory, formatMemory, startMemoryMonitor } from '../public/shared/memory-monitor.mjs';
import { setImmediate } from 'node:timers/promises';

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

function fixture(supported = true) {
  const panel = () => {
    const fields = new Map();
    return { isConnected: true, open: false, querySelector(id) {
      if (!fields.has(id)) fields.set(id, { textContent: '' });
      return fields.get(id);
    } };
  };
  const environment = new EventTarget(), document = new EventTarget(), timers = new Map();
  const stages = [{ name: 'split-reads', bytes: 0, busy: false, revision: 0 }];
  const requests = [], workers = { bytes: 0, instances: 0, workers: 0 }, delays = new Map();
  let tick, intervalMs;
  let timer = 0;
  Object.assign(environment, { document, navigator: {}, crossOriginIsolated: true,
    setInterval(callback, delay) { tick = callback; intervalMs = delay; return 0; }, clearInterval() {},
    setTimeout(callback, delay) { const id = ++timer; timers.set(id, callback); delays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); },
    performance: { memory: { usedJSHeapSize: MiB, totalJSHeapSize: MiB, jsHeapSizeLimit: GiB },
      ...(supported ? { measureUserAgentSpecificMemory: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) } : {}) }
  });
  const panels = [panel(), panel()];
  const monitor = startMemoryMonitor({ elements: panels, getResults: () => stages, getWorkers: () => workers, environment });
  return { monitor, panels, stages, requests, timers, workers, environment, tick, intervalMs,
    timerDelay() { return delays.get([...timers.keys()][0]); },
    runTimer() { assert.equal(timers.size, 1); const [[id, callback]] = timers; timers.delete(id); callback(); }
  };
}

test('completion resamples memory, marks old values and discards measurements spanning a new analysis', async t => {
  const { monitor, panels, stages, requests, timers, runTimer } = fixture();
  t.after(() => monitor.stop());
  const text = id => panels[0].querySelector('#' + id).textContent;
  assert.equal(timers.size, 0, 'No detailed measurement before the user starts an analysis');
  const first = panels[0].querySelector('#memory-measure').onclick();
  requests[0].resolve({ bytes: GiB }); await first;
  assert.equal(text('memory-app-used'), '1.00 GiB');
  stages[0].busy = true; stages[0].revision++; monitor.refresh();
  assert.equal(text('memory-app-label'), 'NAPの使用量（前回の測定）');
  assert.equal(timers.size, 0, 'Analysis startup does not schedule a measurement');
  const during = panels[0].querySelector('#memory-measure').onclick();
  stages[0].busy = false; stages[0].bytes = 5 * MiB; monitor.refresh();
  assert.equal(timers.size, 0, 'Detailed requests never overlap');
  requests[1].resolve({ bytes: 2 * GiB }); await during;
  assert.equal(text('memory-app-used'), '1.00 GiB', 'An old request cannot publish an analysis peak as its completed usage');
  assert.equal(timers.size, 1);
  runTimer();
  assert.equal(requests.length, 3);
  stages[0].busy = true; monitor.refresh();
  requests[2].resolve({ bytes: GiB }); await setImmediate();
  assert.equal(timers.size, 0, 'The next analysis starts without waiting for measurement');
  stages[0].busy = false; monitor.refresh(); runTimer();
  requests[3].resolve({ bytes: 20 * MiB }); await setImmediate();
  assert.equal(text('memory-app-label'), 'NAPの使用量（ブラウザー推定）');
  assert.equal(text('memory-app-used'), '20.0 MiB');
  assert.equal(panels[1].querySelector('#memory-app-used').textContent, '20.0 MiB');
  monitor.refresh(); monitor.refresh();
  assert.equal(requests.length, 4, 'Five-second heap refreshes do not continually measure');
  assert.equal(timers.size, 0);
});

test('open panels sample during analysis without overlap and keep two-second live information separate', async t => {
  const { monitor, panels, stages, requests, timers, workers, environment, tick, intervalMs, timerDelay, runTimer } = fixture();
  t.after(() => monitor.stop());
  const text = id => panels[0].querySelector('#' + id).textContent;
  assert.equal(intervalMs, 2000);
  assert.equal(text('memory-app-used'), '未測定', 'Never label heap data as a NAP-wide measurement');
  panels[0].open = true;
  stages[0].busy = true; monitor.refresh();
  assert.equal(timerDelay(), 1000); runTimer();
  workers.bytes = 512 * MiB; workers.instances = 2; workers.workers = 4;
  environment.performance.memory.usedJSHeapSize = 5 * MiB; tick();
  assert.equal(text('memory-heap-used'), '5.0 MiB');
  assert.equal(text('memory-wasm-used'), '512.0 MiB');
  assert.match(text('memory-wasm-detail'), /Worker：4.*WASM：2/);
  assert.equal(text('memory-app-used'), '未測定');
  assert.equal(requests.length, 1); assert.equal(timers.size, 0);
  requests[0].resolve({ bytes: GiB }); await setImmediate();
  assert.equal(text('memory-app-used'), '1.00 GiB');
  assert.equal(timerDelay(), 30000);
  tick(); tick(); assert.equal(timerDelay(), 30000, 'Live refreshes cannot postpone the next detailed sample');
  runTimer();
  await panels[0].querySelector('#memory-measure').onclick();
  assert.equal(requests.length, 2);
  environment.performance.memory.usedJSHeapSize = 10 * MiB; tick();
  assert.equal(text('memory-heap-used'), '10.0 MiB');
  assert.equal(text('memory-app-used'), '1.00 GiB');
  stages[0].busy = false; workers.bytes = workers.instances = workers.workers = 0; monitor.refresh();
  requests[1].resolve({ bytes: 2 * GiB }); await setImmediate();
  assert.equal(text('memory-app-used'), '1.00 GiB', 'A delayed analysis sample cannot masquerade as completed usage');
  assert.equal(text('memory-wasm-used'), '0 MiB');
  assert.equal(timerDelay(), 1000); runTimer();
  requests[2].resolve({ bytes: 12 * MiB }); await setImmediate();
  assert.equal(text('memory-app-used'), '12.0 MiB');
  assert.equal(timers.size, 0, 'Idle pages do not continually request garbage-collection measurements');
});

test('analysis sampling pauses when all panels are collapsed or the page is in the background', async t => {
  const { monitor, panels, stages, requests, timers, environment, tick, runTimer } = fixture();
  t.after(() => monitor.stop());
  stages[0].busy = true; monitor.refresh();
  assert.equal(timers.size, 0);
  panels[0].open = true; panels[0].ontoggle(); runTimer();
  requests[0].resolve({ bytes: MiB }); await setImmediate();
  assert.equal(timers.size, 1);
  panels[0].open = false; panels[0].ontoggle();
  assert.equal(timers.size, 0);
  panels[0].open = true; panels[0].ontoggle();
  assert.equal(timers.size, 1);
  environment.document.visibilityState = 'hidden'; tick();
  assert.equal(timers.size, 0);
  environment.document.visibilityState = 'visible'; tick();
  assert.equal(timers.size, 1);
});

test('completion measurement is debounced, stops on page disposal, and failures do not cause retry loops', async t => {
  const { monitor, stages, requests, timers, runTimer } = fixture();
  t.after(() => monitor.stop());
  stages[0].bytes = 5 * MiB; monitor.refresh();
  stages[0].bytes = 6 * MiB; monitor.refresh();
  assert.equal(timers.size, 1); runTimer();
  requests[0].reject(Error('Unavailable')); await setImmediate();
  assert.equal(timers.size, 0);
  stages[0].revision++; monitor.refresh();
  assert.equal(timers.size, 1); monitor.stop(); assert.equal(timers.size, 0);
  const unavailable = fixture(false); t.after(() => unavailable.monitor.stop());
  unavailable.stages[0].busy = true; unavailable.monitor.refresh();
  unavailable.stages[0].busy = false; unavailable.monitor.refresh();
  assert.equal(unavailable.timers.size, 0); assert.equal(unavailable.requests.length, 0);
});
