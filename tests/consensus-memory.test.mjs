import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { ByteOutput } from '../public/get-consensus/app/byte-output.mjs';
import { readFastq, streamFastq } from '../public/get-consensus/app/sequence.mjs';
import { mapParallel } from '../public/get-consensus/app/parallel.mjs';
import { isMemoryAllocationError } from '../public/get-consensus/app/memory.mjs';
import { toolScope } from '../public/get-consensus/app/tool-scope.mjs';
import { ConsensusPipeline, validateOptions } from '../public/get-consensus/app/pipeline.mjs';
import { phasePositions, haplotypes } from '../public/get-consensus/app/haplotype.mjs';
import { ConsensusTools } from '../public/get-consensus/tool-client.mjs';
import { ConsensusSamples } from '../public/get-consensus/app/sample-client.mjs';

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

test('native MAFFT allocation diagnostics enter memory recovery without retrying unrelated errors', () => {
  for (const message of ['Cannot allocate 2000 x 2000 character matrix.', 'Allocation error( 300 doublehalfmtx )', 'Failed to allocate 65536 bytes']) {
    assert.equal(isMemoryAllocationError(Error(message)), true);
  }
  for (const message of ['memory access out of bounds', 'Cannot open OOM.fa', 'Invalid FASTQ']) {
    assert.equal(isMemoryAllocationError(Error(message)), false);
  }
});

test('a failed input transfer terminates both tool and sample workers before memory recovery', async () => {
  const original=globalThis.Worker;let created=0,terminated=0;
  globalThis.Worker=class {
    constructor(){created++;}
    postMessage(){throw new RangeError('Array buffer allocation failed');}
    terminate(){terminated++;}
  };
  try {
    await assert.rejects(new ConsensusTools().run('vsearch',[],{files:{}}), /Array buffer allocation failed/);
    await assert.rejects(new ConsensusSamples().run('analysis',{job:{}}), /Array buffer allocation failed/);
    assert.equal(created,2);assert.equal(terminated,created);
  } finally {
    if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;
  }
});

test('MAFFT keeps the fast path until allocation fails, then retains disposable stages in that scope', async () => {
  const modes = [], commands = [], tools = { align: async (text, options) => {
    modes.push(options.isolatedStages); commands.push(options.args);
    if (modes.length === 2) throw Error('Allocation error ( 200 double halfmtx )');
    return { stdout: text, stderr: '', exitCode: 0 };
  } };
  const scope = toolScope(tools, { options: { adjustDirection: true } });
  for (let i=0;i<3;i++) assert.equal(await scope.align([{id:'r',seq:'ACGT'}]), '>r\nACGT\n');
  assert.deepEqual(modes, [false, false, true, true]);
  assert.ok(commands.every(args => JSON.stringify(args) === JSON.stringify(['--adjustdirection','--auto'])));
  assert.equal(scope.warnings.length, 1);
  const invalid = toolScope({ align: async () => { throw Error('Invalid FASTA'); } }, { options: {} });
  await assert.rejects(invalid.align([{id:'r',seq:'ACGT'}]), /Invalid FASTA/);
  assert.equal(invalid.warnings.length, 0);
});

test('BLAST allocation failures split only failed batches, preserve counts/order and bound single-read retries', async () => {
  const file = input(Array.from({length:10}, (_,i)=>`@r${i}\nACGT\n+\nIIII\n`).join(''));
  const successful=[], attempted=[], tools = { run: async (tool,args,{files}) => {
    assert.equal(tool,'blastn');
    const ids = [...files['query.fa'].matchAll(/^>(.*)$/gm)].map(m=>m[1]); attempted.push(ids);
    // Test full stderr classification even if the diagnostic is outside the UI excerpt.
    if(ids.length>2) return { exitCode:1, stderr:'Cannot allocate memory\n'+'x'.repeat(5000), stdout:'', files:{} };
    successful.push(...ids);
    return { exitCode:0, stderr:'', files:{}, stdout:ids.map(id=>`${id}\tref\t4\t4\t100\t4\t0\t0\t1\t4\t1\t4\t0\t250\t0\tref\n`).join('') };
  } };
  const sample={reads:10,assigned:0}, pipeline=new ConsensusPipeline({tools});
  const result=await pipeline.searchSample({file,name:'S',sample,dbFiles:{}},validateOptions({batchSize:6}));
  assert.deepEqual(successful, Array.from({length:10},(_,i)=>`r${i}`));
  assert.equal(result.sample.assigned,10);assert.equal(result.counts.get('ref'),10);
  assert.equal(attempted[0].length,6);assert.deepEqual(attempted.slice(7).map(ids=>ids.length),[2,2]);
  assert.equal(result.local.warnings.length,3);
  assert.equal([...result.local.files.keys()].filter(name=>name.endsWith('.blastn')).length,6);
  let calls=0;
  const impossible=new ConsensusPipeline({tools:{run:async()=>{calls++;throw Error('out of memory');}}});
  await assert.rejects(impossible.searchSample({file:input(fq.split('@B')[0]),name:'S',sample:{reads:1,assigned:0},dbFiles:{}},validateOptions()), /out of memory/);
  assert.equal(calls,1);
});

test('phasing position list deduplicates 1-based sites and ignores uncalled pileup positions', () => {
  const variants=[{chrom:'ref',pos:2,ref:'A',alt:'C'},{chrom:'ref',pos:4,ref:'A',alt:'G'}];
  assert.equal(phasePositions([...variants,variants[0]]),'ref\t2\nref\t4\n');
  const sam=['one\t0\tref\t1\t60\t4M\t*\t0\t0\tACAG\tIIII','two\t0\tref\t1\t60\t4M\t*\t0\t0\tAAAA\tIIII'].join('\n');
  const sites='ref\t2\tA\t2\tC.\tII\tone,two\nref\t4\tA\t2\tG.\tII\tone,two\n';
  const references=[{id:'ref',seq:'AAAA'}], options={minDepth:2};
  assert.deepEqual(haplotypes(sam,variants,references,{...options,phasePileup:sites}),
    haplotypes(sam,variants,references,{...options,phasePileup:'ref\t1\tA\t1\t.\tI\tother\n'+sites}));
  assert.equal(haplotypes(sam,variants,references,{...options,phasePileup:sites}).haplotypes.length,2);
});
