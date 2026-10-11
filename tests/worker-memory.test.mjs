import test from 'node:test';
import assert from 'node:assert/strict';
import { createWasmMemoryTracker } from '../public/shared/worker-memory.mjs';

test('WASM capacity follows real memory growth, deduplicates buffers and releases active commands', () => {
  class Memory extends WebAssembly.Memory {}
  const samples = [], track = createWasmMemoryTracker({ WebAssembly: { Memory } }, value => samples.push(value));
  const memory = new Memory({ initial: 2, maximum: 4 }), release = track(memory.buffer), releaseAgain = track(memory.buffer);
  assert.deepEqual(samples.at(-1), { bytes: 2 * 65536, instances: 1 });
  assert.equal(memory.grow(1), 2);
  assert.deepEqual(samples.at(-1), { bytes: 3 * 65536, instances: 1 });
  const other = new Memory({ initial: 1, maximum: 2, shared: true }), releaseOther = track(other.buffer);
  other.grow(1);
  assert.deepEqual(samples.at(-1), { bytes: 5 * 65536, instances: 2 });
  assert.throws(() => memory.grow(2), RangeError);
  assert.deepEqual(samples.at(-1), { bytes: 5 * 65536, instances: 2 }, 'Failed allocations do not change the reported capacity');
  release(); release(); releaseAgain();
  assert.deepEqual(samples.at(-1), { bytes: 2 * 65536, instances: 1 });
  memory.grow(1);
  assert.deepEqual(samples.at(-1), { bytes: 2 * 65536, instances: 1 }, 'Released memory is not kept active by the growth hook');
  releaseOther();
  assert.deepEqual(samples.at(-1), { bytes: 0, instances: 0 });
});

test('monitoring failures never interrupt WASM allocation or cleanup', () => {
  class Memory extends WebAssembly.Memory {}
  const track = createWasmMemoryTracker({ WebAssembly: { Memory } }, () => { throw Error('Closed worker'); });
  const memory = new Memory({ initial: 1, maximum: 2 }), release = track(memory.buffer);
  assert.equal(memory.grow(1), 1);
  assert.doesNotThrow(release);
});
