import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from './serve.mjs';

const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const expected = JSON.parse(await readFile(new URL('../public/examples/expected.json', import.meta.url), 'utf8'));
// Instrument only test HTTP responses, including nested workers whose entry
// requests are not exposed by Playwright's routing API. Nothing shipped changes.
const audit = `const NativeWorker=globalThis.Worker,children=new Set();
self.addEventListener('message',({data})=>{if(data.__napTestAudit)globalThis.__napTestAudit=new Int32Array(data.__napTestAudit);});
globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);children.add(this);Atomics.add(globalThis.__napTestAudit,0,1);}postMessage(data,...args){return super.postMessage({...data,__napTestAudit:globalThis.__napTestAudit.buffer},...args);}terminate(){if(children.delete(this))Atomics.add(globalThis.__napTestAudit,1,1);return super.terminate();}};
const reportMessage=self.postMessage.bind(self);
self.postMessage=(data,...args)=>{if(data.result||data.error){Atomics.add(globalThis.__napTestAudit,import.meta.url.endsWith('tool-worker.mjs')?2:import.meta.url.endsWith('sample-worker.mjs')?3:4,1);Atomics.add(globalThis.__napTestAudit,5,children.size);}return reportMessage(data,...args);};\n`;
const workerSources = new Map(await Promise.all(['app/pipeline-worker.mjs', 'app/sample-worker.mjs', 'tool-worker.mjs'].map(async name => {
  const pathname = '/get-consensus/' + name;
  return [pathname, audit + await readFile(new URL('../public' + pathname, import.meta.url), 'utf8')];
})));
const server = createServer(), staticHandler = server.listeners('request')[0];
server.removeListener('request', staticHandler);
server.on('request', (req, res) => {
  const body = workerSources.get(new URL(req.url, 'http://localhost').pathname);
  if (!body) return staticHandler(req, res);
  res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const channel = process.env.BROWSER_CHANNEL || 'chrome';
let browser;
try {
  browser = await chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless: true });
  const page = await browser.newPage(), cdp = await browser.newBrowserCDPSession(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker, active = new Set();
    window.__napTestWorkers = active;
    window.__napTestAudit = new Int32Array(new SharedArrayBuffer(24));
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); active.add(this); Atomics.add(window.__napTestAudit, 0, 1); }
      postMessage(data, ...args) { return super.postMessage({ ...data, __napTestAudit: window.__napTestAudit.buffer }, ...args); }
      terminate() { if (active.delete(this)) Atomics.add(window.__napTestAudit, 1, 1); return super.terminate(); }
    };
  });
  await page.goto(base + '/get-consensus/'); await page.waitForFunction(() => window.napConsensus);
  const run = async (count, limit, quality = false) => {
    console.log(`START ${count} samples, concurrency ${limit}${quality ? ', quality bins' : ''}`);
    const before = await cdp.send('SystemInfo.getProcessInfo');
    const report = await page.evaluate(async ({ count, limit, sequences, quality }) => {
      const { ConsensusPipeline } = await import('./app/pipeline.mjs');
      const files = Array.from({ length: count }, (_, index) => {
        const seq = sequences[index % sequences.length];
        const text = Array.from({ length: 3 }, (_, read) => `@read${read}${quality ? ` qs:f:${14 + read}` : ''}\n${seq}\n+\n${'I'.repeat(seq.length)}\n`).join('');
        return new File([text], `sample${String(index).padStart(3, '0')}.fq`);
      });
      const states = [], start = performance.now();
      let result;
      if (count === 300) {
        window.napConsensus.setFiles(files);
        for (const [key, value] of Object.entries({ parallelSamples: limit, maxReads: 3, minReads: 3 })) document.querySelector(`[name=${key}]`).value = value;
        document.querySelector('[name=haplotypes]').checked = false;
        document.getElementById('start').click();
        result = await new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            if (window.getConsensus.busy) return;
            clearInterval(timer);
            if (window.getConsensus.result) resolve(window.getConsensus.result);
            else reject(Error(document.getElementById('status').textContent));
          }, 100);
        });
        if (document.getElementById('consensus-progress').value !== 1 || document.querySelectorAll('#consensus-file-progress li').length !== count) throw Error('300-sample UI progress did not finish');
      } else result = await new ConsensusPipeline({ onProgress: p => {
        if (p.parallel) states.push({ active: p.parallel.activeSamples.length, limit: p.parallel.limit, memoryRetries: p.parallel.memoryRetries || 0 });
      } }).run(files, { parallelSamples: limit, maxReads: 3, minReads: 3, haplotypes: false });
      const science = JSON.stringify({ rows: result.rows, samples: result.samples, entries: result.entries.map(({ id, seq, qual, count }) => ({ id, seq, qual, count })) });
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(science)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return { elapsedMs: performance.now() - start, hash, states, manifest: result.manifest, sequences: result.rows.map(row => row.seq).sort() };
    }, { count, limit, sequences: expected.samples.map(sample => sample.sequence), quality });
    const after = await cdp.send('SystemInfo.getProcessInfo');
    report.cpuSeconds = after.processInfo.reduce((sum, process) => sum + process.cpuTime - (before.processInfo.find(old => old.id === process.id)?.cpuTime || 0), 0);
    return report;
  };
  const serial = await run(8, 1), parallel = await run(8, 8);
  assert.equal(parallel.hash, serial.hash);
  assert.equal(parallel.manifest.concurrency.samplePeak, 8);
  assert.equal(parallel.manifest.concurrency.blastPeak, 8);
  assert.ok(parallel.manifest.samples.every(sample => sample.assigned === 3 && !('input' in sample)));
  console.log(`PASS 8 real WASM sample workers match serial output (${Math.round(serial.elapsedMs)} ms vs ${Math.round(parallel.elapsedMs)} ms)`);

  // Simulate the allocation exception at the VSEARCH factory entry. Preserve
  // pthread startup: that worker imports the same module as the main instance.
  // Only test HTTP responses change; shipped binaries and source stay untouched.
  let injected = 0;
  const runtime = await readFile(new URL('../public/get-consensus/wasm/vsearch.mjs', import.meta.url), 'utf8');
  await page.route('**/wasm/vsearch.mjs', async route => {
    const body = injected++ < 2 ? runtime.replace('async function(moduleArg = {}) {', 'async function(moduleArg = {}) { if (globalThis.self?.name !== "em-pthread") throw new RangeError("WebAssembly.Memory(): could not allocate memory");') : runtime;
    await route.fulfill({ contentType: 'text/javascript', body });
  });
  const recovered = await run(8, 8);
  assert.equal(recovered.hash, serial.hash);
  assert.ok(recovered.manifest.concurrency.memoryRetries >= 1);
  assert.ok(recovered.manifest.concurrency.effectiveLimit < 8);
  assert.ok(recovered.manifest.warnings.some(warning => warning.includes('メモリー不足')));
  assert.ok(recovered.states.some(state => state.limit < 8 && state.memoryRetries > 0));
  await page.unroute('**/wasm/vsearch.mjs');
  console.log('PASS VSEARCH allocation failure reduces concurrency, retries failed samples and preserves sequences/counts');

  const qualitySerial = await run(4, 1, true), qualityParallel = await run(4, 4, true);
  assert.equal(qualityParallel.hash, qualitySerial.hash);
  assert.ok(qualityParallel.manifest.samples.every(sample => sample.clusterMode === 'quality'));
  console.log('PASS quality-bin clustering and consensus/counts match between serial and parallel workers');

  const stress = await run(300, 16);
  assert.equal(stress.manifest.samples.length, 300);
  assert.equal(stress.manifest.concurrency.samplePeak, 16);
  assert.ok(stress.manifest.concurrency.blastPeak >= 1 && stress.manifest.concurrency.blastPeak <= 16);
  assert.deepEqual(stress.sequences, expected.samples.map(sample => sample.sequence).sort());
  assert.ok(stress.manifest.samples.every(sample => sample.reads === 3 && sample.assigned === 3 && !('input' in sample)));
  assert.equal(stress.manifest.representatives, 2);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__napTestWorkers.size), 0, 'All top-level workers terminated');
  const [created, terminated, tools, samples, pipelines, unfinishedChildren] = await page.evaluate(() => [...window.__napTestAudit]);
  const workerAudit = { created, terminated, tools, samples, pipelines, unfinishedChildren };
  console.log('Worker ownership:', JSON.stringify(workerAudit));
  assert.equal(created, terminated, 'All constructed sample/tool/pthread workers terminated');
  assert.ok(samples >= 600); assert.ok(tools >= stress.manifest.commands); assert.equal(pipelines, 1);
  assert.equal(unfinishedChildren, 0, 'Finished/error jobs terminate owned child workers');
  console.log(`PASS 300 FASTQ files at 16 concurrent samples: 900 reads, two representatives, worker cleanup (${Math.round(stress.elapsedMs / 1000)} s)`);
  await writeFile(new URL('consensus-memory-report.json', output), JSON.stringify({ testedAt: new Date().toISOString(), browser: browser.version(), syntheticReadsPerFile: 3, serial, parallel, recovered, qualitySerial, qualityParallel, stress, errors, workerAudit }, null, 2) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
