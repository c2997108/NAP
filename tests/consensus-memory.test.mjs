import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { ByteOutput } from '../public/get-consensus/app/byte-output.mjs';
import { readFastq, streamFastq } from '../public/get-consensus/app/sequence.mjs';
import { mapParallel } from '../public/get-consensus/app/parallel.mjs';

test('stdout byte chunks preserve UTF-8 boundaries and large output without number arrays', () => {
  const text = 'A日本語🙂\n'.repeat(100000), bytes = new TextEncoder().encode(text), output = new ByteOutput(31);
  for (const byte of bytes.subarray(0, 50)) output.push(byte);
  output.write(bytes.subarray(50));
  assert.equal(output.text(), text);
  assert.ok(output.chunks.every(chunk => chunk instanceof Uint8Array && chunk.length === 31));
});

const fq = '@A qs:f:15\nacgt\n+\nIIII\n@B\nTGCA\n+\nHHHH\n';
const input = (content, name = 'reads.fq') => Object.assign(new Blob([content]), { name });
test('streamed BLAST FASTQ batches preserve records, qualities and concatenated gzip validation', async () => {
  const expected = await readFastq(input(fq));
  const compressed = input(Buffer.concat([gzipSync(fq.slice(0, fq.indexOf('@B'))), gzipSync(fq.slice(fq.indexOf('@B')))]), 'reads.fq.gz');
  const records = [];
  for await (const record of streamFastq(compressed)) records.push(record);
  assert.deepEqual(records, expected);
  assert.deepEqual(expected.map(r => [r.id, r.seq, r.qual, r.q]), [['A', 'ACGT', 'IIII', 15], ['B', 'TGCA', 'HHHH', null]]);
  await assert.rejects(readFastq(input(fq + fq)), /重複/);
  await assert.rejects(readFastq(input(fq.slice(0, -3))), /不正|不完全/);
  const controller = new AbortController(), iterator = streamFastq(input(fq), { signal: controller.signal });
  await iterator.next(); controller.abort();
  // Cancellation may occur while multiple records are in one decoded chunk.
  await assert.rejects(async () => { for await (const record of iterator) void record; }, /abort/i);
});

test('memory failure lowers concurrency, drains peers, retries one job, and preserves ordered results', async () => {
  const budget = { limit: 4 }, pending = [], starts = [], calls = new Map(), pressure = [];
  const items = [1, 4, 2, 3, 5];
  const running = mapParallel(items, 4, (item, index) => {
    starts.push(index); calls.set(index, (calls.get(index) || 0) + 1);
    return new Promise((resolve, reject) => pending.push({ index, resolve, reject }));
  }, { budget, priority: item => item, retryDelay: 0, onMemoryPressure: state => pressure.push(state) });
  while (pending.length < 4) await setImmediate();
  assert.deepEqual(starts, [4, 1, 3, 2]);
  pending[0].reject(Error('RangeError: WebAssembly.Memory(): could not allocate memory'));
  await setImmediate(); assert.equal(budget.limit, 2); assert.equal(starts.length, 4);
  pending[1].resolve('sample1'); await setImmediate(); assert.equal(starts.length, 4);
  pending[2].resolve('sample3');
  while (pending.length < 5) await setImmediate();
  assert.equal(pending[4].index, 4);
  pending[3].resolve('sample2');
  while (pending.length < 6) await setImmediate();
  assert.equal(pending[5].index, 0);
  pending[4].resolve('sample4'); pending[5].resolve('sample0');
  assert.deepEqual(await running, ['sample0', 'sample1', 'sample2', 'sample3', 'sample4']);
  assert.equal(pressure.length, 1); assert.equal(budget.memoryRetries, 1);
  assert.deepEqual([...calls].filter(([, count]) => count > 1), [[4, 2]]);
  const second = [];
  await mapParallel(items, 4, async (_, index) => index, { budget, onState: state => second.push(state) });
  assert.ok(second.every(state => state.active.length <= 2), 'BLAST retains the reduced analysis limit');
});

test('a persistent single-job allocation failure stops with actionable guidance and bounded retries', async () => {
  let calls = 0;
  await assert.rejects(mapParallel([1], 16, async () => { calls++; throw Error('WebAssembly.Memory(): could not allocate memory'); }, { budget: { limit: 16 }, retryDelay: 0 }), /入力を分けて|2 GiB/);
  assert.equal(calls, 2);
});

test('non-memory failures cancel peer workers and external cancellation stops queued jobs', async () => {
  let peerCancelled = false;
  await assert.rejects(mapParallel([0, 1, 2], 2, async (item, _, signal) => {
    if (!item) { await setImmediate(); throw Error('invalid FASTQ'); }
    return new Promise((_, reject) => signal.addEventListener('abort', () => { peerCancelled = true; reject(signal.reason); }, { once: true }));
  }, { budget: { limit: 2 } }), /invalid FASTQ/);
  assert.equal(peerCancelled, true);
  const controller = new AbortController(), started = [];
  await assert.rejects(mapParallel([0, 1, 2], 1, async (item, _, signal) => {
    started.push(item); controller.abort(); signal.throwIfAborted();
  }, { signal: controller.signal }), /abort/i);
  assert.deepEqual(started, [0]);
});
