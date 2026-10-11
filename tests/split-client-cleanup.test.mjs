import test from 'node:test';
import assert from 'node:assert/strict';
import { BlastClient } from '../public/split-reads/app/blast-client.mjs';
import { FileProcessingSlot } from '../public/split-reads/app/demultiplex-file-client.mjs';

function workers(t) {
  const instances = [], original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { this.terminations = 0; instances.push(this); }
    terminate() { this.terminations++; }
    postMessage(message) {
      if (this.throwOnPost) throw Error('Clone failure');
      if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }));
    }
  };
  t.after(() => { globalThis.Worker = original; });
  return instances;
}

test('BLAST disposal drops handlers and the worker reference, rejects pending jobs and remains reusable after reset', async t => {
  const instances = workers(t), client = new BlastClient();
  const pending = client.run('blastn', []);
  client.dispose(); await assert.rejects(pending, /終了/);
  assert.equal(client.worker, null); assert.equal(client.pending.size, 0);
  assert.equal(instances[0].onmessage, null); assert.equal(instances[0].onerror, null);
  client.dispose(); assert.equal(instances[0].terminations, 1);
  await assert.rejects(client.run('blastn', []), /終了/);
  client.reset(); assert.equal(instances.length, 2);
  instances[1].throwOnPost = true;
  await assert.rejects(client.run('blastn', []), /Clone failure/);
  assert.equal(client.pending.size, 0, 'A failed clone does not retain the request callbacks');
  client.dispose();
});

test('split file cleanup releases its input configuration and worker after the child shutdown acknowledgement', async t => {
  const instances = workers(t), slot = new FileProcessingSlot({ data: new Uint8Array(1024) });
  const pending = slot.run({ name: 'reads.fq' }, () => {});
  const closing = slot.dispose(); await assert.rejects(pending, /中止/); await closing;
  assert.equal(slot.worker, null); assert.equal(slot.configuration, null); assert.equal(slot.onProgress, null);
  assert.equal(instances[0].onmessage, null); assert.equal(instances[0].onerror, null);
  assert.equal(instances[0].terminations, 0, 'The file worker acknowledges graceful self.close');
  assert.equal(slot.dispose(), closing);
  await assert.rejects(slot.run({ name: 'reads.fq' }), /中止/);
});
