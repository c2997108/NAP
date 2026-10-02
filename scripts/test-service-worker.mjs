import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteFolder = process.argv.includes('--docs') ? 'docs' : 'public';
const root = fileURLToPath(new URL('../', import.meta.url)), publicRoot = path.join(root, siteFolder);
const output = path.join(root, 'test-results'), prefix = '/nap-pages-test/';
await mkdir(output, { recursive: true });
const expected = JSON.parse(await readFile(path.join(publicRoot, 'examples/expected.json'), 'utf8'));
const workerSource = await readFile(path.join(publicRoot, 'coi-serviceworker.js'), 'utf8');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
let workerRevision = 0, workerMode = 'normal', releaseWorker;
const workerGate = new Promise(resolve => { releaseWorker = resolve; });
// Deliberately no COOP, COEP or CORP: mimic a Pages project site under /repo/.
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'GET');
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    let name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!name || name.endsWith('/')) name += 'index.html';
    const target = path.resolve(publicRoot, name);
    if (!target.startsWith(publicRoot + path.sep) || !(await stat(target)).isFile()) { res.writeHead(404).end(); return; }
    let content;
    if (name === 'coi-serviceworker.js') {
      await workerGate;
      content = workerMode === 'ineffective'
        ? 'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));'
        : workerSource + `\n// Test worker update ${workerRevision}\n`;
    } else content = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, base = origin + prefix;
const channel = process.env.BROWSER_CHANNEL || 'chrome';
let browser;
try {
  browser = await chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [], requests = [], httpErrors = [], navigations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push(response.url()); });
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url()); });
  const initial = await page.goto(base + '#get-consensus', { waitUntil: 'commit' });
  assert.equal(initial.headers()['cross-origin-opener-policy'], undefined);
  assert.equal(initial.headers()['cross-origin-embedder-policy'], undefined);
  await page.waitForFunction(() => document.documentElement.dataset.napIsolation === 'preparing');
  assert.equal(await page.evaluate(() => document.querySelector('main').inert), true);
  assert.deepEqual(await page.locator('iframe').evaluateAll(frames => frames.map(frame => frame.getAttribute('src'))), [null, null, null]);
  assert.equal(await page.evaluate(() => !!window.nap), false);
  releaseWorker();
  await page.waitForFunction(() => window.nap?.state.split && window.nap.state.consensus && window.nap.state.annotation);
  assert.equal(navigations.length, 2, 'Only one automatic reload on first startup');
  assert.equal(new URL(page.url()).hash, '#get-consensus');
  assert.equal(await page.evaluate(() => document.querySelector('main').inert), false);
  assert.equal(await page.evaluate(() => history.state?.napIsolationReload), undefined);
  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { scope: reg.scope, scriptURL: reg.active.scriptURL };
  });
  assert.equal(registration.scope, base); assert.equal(registration.scriptURL, base + 'coi-serviceworker.js');
  const split = page.frames().find(frame => frame.url() === base + 'split-reads/');
  const consensus = page.frames().find(frame => frame.url() === base + 'get-consensus/');
  const annotation = page.frames().find(frame => frame.url() === base + 'annotation/');
  assert.ok(split && consensus && annotation);
  for (const frame of [page.mainFrame(), split, consensus, annotation]) {
    assert.equal(await frame.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function'), true);
  }
  const served = await page.evaluate(async () => {
    const response = await fetch('./get-consensus/wasm/vsearch.wasm');
    return { coop: response.headers.get('Cross-Origin-Opener-Policy'), coep: response.headers.get('Cross-Origin-Embedder-Policy') };
  });
  assert.deepEqual(served, { coop: 'same-origin', coep: 'require-corp' });
  console.log(`PASS ${siteFolder}/ headerless /repo/ hosting: one startup reload, deferred inputs/iframes, parent and all three frames isolated`);

  await page.getByRole('tab', { name: /split-reads/ }).click();
  await split.locator('#load-test').click();
  await split.waitForFunction(() => !document.getElementById('split').disabled);
  await split.locator('#split').click();
  await split.waitForFunction(() => !window.napSplit.state.busy);
  assert.equal(await split.evaluate(() => window.napSplit.state.files.length), 2, await split.locator('#status').textContent());
  const run = await split.evaluate(async () => JSON.parse(await (await window.demultiplexer.readFile('run.json')).text()));
  assert.equal(run.summary.totalReads, 12); assert.equal(run.summary.assignedReads, 12); assert.equal(run.summary.segments, 12);
  assert.deepEqual(run.summary.samples.map(sample => sample.segments), [6, 6]);
  console.log('PASS split 12 synthetic reads on headerless hosting');
  await page.locator('#open-consensus').click(); await page.locator('#transfer-selected').click();
  await consensus.waitForFunction(() => window.napConsensus.inputs.length === 2);
  assert.equal(await consensus.locator('#start').isEnabled(), true);
  await consensus.locator('#start').click();
  await consensus.waitForFunction(() => !window.getConsensus.busy);
  assert.equal(await consensus.evaluate(() => !!window.getConsensus.result), true, await consensus.locator('#log').textContent());
  const result = await consensus.evaluate(() => ({ manifest: window.getConsensus.result.manifest, sequences: window.getConsensus.result.rows.map(row => row.seq) }));
  assert.equal(result.manifest.representatives, 2);
  assert.deepEqual(result.manifest.samples.map(sample => sample.assigned), [6, 6]);
  assert.deepEqual(result.sequences.sort(), expected.samples.map(sample => sample.sequence).sort());
  console.log('PASS actual BLAST split 12 reads -> VSEARCH/MAFFT/consensus -> two representatives without server isolation headers');
  await page.locator('#open-annotation').click();
  assert.match(await annotation.locator('#input-summary').textContent(),/get-consensusから受け取り/);
  await annotation.locator('#demo').click();await annotation.locator('#start').click();
  await annotation.waitForFunction(()=>!window.napAnnotation.state.busy && window.napAnnotation.result);
  assert.equal(await annotation.evaluate(()=>window.napAnnotation.result.manifest.summary.annotated),2);
  console.log('PASS annotation handoff and actual BLAST demo with project-subpath references on headerless hosting');

  await page.getByRole('tab', { name: /split-reads/ }).click(); await split.locator('#batch-size').fill('17');
  await page.evaluate(() => { window.napUpdateSentinel = 'keep'; });
  workerRevision++;
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const changed = new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); };
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', done); reject(Error('Worker did not update')); }, 15000);
      navigator.serviceWorker.addEventListener('controllerchange', done);
    });
    await reg.update(); await changed;
  });
  assert.equal(navigations.length, 2, 'Worker update must not reload an open app');
  assert.equal(await page.evaluate(() => window.napUpdateSentinel), 'keep');
  assert.equal(await split.locator('#batch-size').inputValue(), '17');
  assert.equal(await split.evaluate(() => window.napSplit.state.files.length), 2);
  assert.equal(await consensus.evaluate(() => window.getConsensus.result.manifest.representatives), 2);
  assert.equal(await annotation.evaluate(() => window.napAnnotation.result.manifest.summary.annotated),2);
  assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []);
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(base) || request.url.startsWith('blob:'))), 'No uploads or external requests');
  await context.close();
  console.log('PASS worker update preserves draft inputs and split/consensus results, with no automatic reload');

  // Each direct entry point must bootstrap from a fresh browser with no worker.
  for (const [route, ready] of [['get-consensus/', 'window.napConsensus'], ['get-consensus/tools.html', 'window.consensusTools'], ['split-reads/', 'window.napSplit'], ['annotation/','window.napAnnotation']]) {
    const directContext = await browser.newContext(), direct = await directContext.newPage(), directErrors = [];
    direct.setDefaultTimeout(30000); let count = 0;
    direct.on('pageerror', error => directErrors.push(error.message));
    direct.on('request', request => { if (request.isNavigationRequest() && request.frame() === direct.mainFrame()) count++; });
    await direct.goto(base + route); await direct.waitForFunction(ready);
    assert.equal(await direct.evaluate(() => crossOriginIsolated), true); assert.equal(count, 2);
    assert.equal(await direct.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope), base);
    if (route.endsWith('tools.html')) {
      await direct.locator('#tool').selectOption('vsearch'); await direct.locator('#run').click();
      await direct.waitForFunction(() => !document.getElementById('run').disabled);
      assert.equal(await direct.locator('#status').textContent(), '完了');
      assert.match(await direct.locator('#output').textContent(), /# centroids.fa/);
    }
    assert.deepEqual(directErrors, []); await directContext.close();
  }
  console.log('PASS standalone split, consensus and VSEARCH tools pages under a repository subpath');

  // An unavailable worker or an ineffective worker should explain the failure,
  // leave input inactive and stop instead of repeatedly reloading.
  for (const failure of ['unavailable', 'ineffective']) {
    const failedContext = await browser.newContext(), failed = await failedContext.newPage(); let count = 0;
    failed.setDefaultTimeout(30000);
    if (failure === 'unavailable') await failed.addInitScript(() => Object.defineProperty(navigator, 'serviceWorker', { value: undefined }));
    else workerMode = 'ineffective';
    failed.on('request', request => { if (request.isNavigationRequest() && request.frame() === failed.mainFrame()) count++; });
    await failed.goto(base);
    await failed.waitForFunction(() => document.documentElement.dataset.napIsolation === 'failed');
    assert.match(await failed.getByRole('alert').textContent(), /Service Worker/);
    assert.equal(await failed.evaluate(() => !!window.nap), false);
    assert.equal(await failed.evaluate(() => document.querySelector('main').inert), true);
    assert.equal(count, failure === 'unavailable' ? 1 : 2);
    await failedContext.close();
  }
  console.log('PASS unavailable/ineffective service workers fail with a message and no reload loop');
  await writeFile(path.join(output, 'service-worker-report.json'), JSON.stringify({ testedAt: new Date().toISOString(), browser: browser.version(), registration, startupNavigations: navigations.length, serverIsolationHeaders: false, split: run.summary, consensus: result.manifest, errors, httpErrors, externalRequests: 0, checks: ['repository subpath', 'single first-load reload', 'deferred inputs and frames', 'parent/iframe isolation', 'actual WASM split and consensus', 'worker update retains inputs/results', 'standalone entry points', 'unavailable worker', 'reload loop guard', 'no upload or external network'] }, null, 2) + '\n');
} finally { releaseWorker(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
