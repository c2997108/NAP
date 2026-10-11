import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from './serve.mjs';
import { formatMemory } from '../public/shared/memory-monitor.mjs';

const output = fileURLToPath(new URL('../test-results/', import.meta.url)); await mkdir(output, { recursive: true });
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`, channel = process.env.BROWSER_CHANNEL || 'chrome';
let browser;
try {
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(base);
  await page.waitForFunction(() => window.nap?.state.annotation);
  const split = page.frames().find(frame => frame.url() === base + '/split-reads/');
  const consensus = page.frames().find(frame => frame.url() === base + '/get-consensus/');
  const annotation = page.frames().find(frame => frame.url() === base + '/annotation/');
  assert.equal(await page.locator('#memory-panel').count(), 0, 'No memory panel above the tabs');
  for (const [name, frame, run] of [['split-reads', split, '#split'], ['get-consensus', consensus, '#start'], ['annotation', annotation, '#start']]) {
    await page.locator('#tab-' + name).click();
    assert.equal(await frame.locator('#memory-panel').evaluate(element => element.open), false);
    assert.equal(await frame.evaluate(selector => {
      const panel = document.getElementById('memory-panel'), button = document.querySelector(selector);
      const gap = button.getBoundingClientRect().top - panel.getBoundingClientRect().bottom;
      return panel.nextElementSibling.matches('.split-run-actions,.run-panel') && gap >= 0 && gap <= 24;
    }, run), true, name + ': collapsed panel directly above the execution button');
    assert.equal(await frame.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      return ids.length === new Set(ids).size;
    }), true, name + ': no conflicting analysis control IDs');
  }
  await page.locator('#tab-split-reads').click();
  assert.equal(await split.locator('#memory-panel').evaluate(element => element.open), false);
  assert.equal(await split.locator('#memory-app-used').isVisible(), false);
  assert.equal(await split.locator('#memory-measure').isVisible(), false);
  await split.locator('#memory-panel').screenshot({ path: path.join(output, 'memory-monitor-collapsed.png') });
  await split.locator('#memory-title').click();
  assert.match(await split.locator('.memory-note').first().textContent(), /PCの空きRAM.*取得できません/);
  const canMeasure = await page.evaluate(() => crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === 'function');
  assert.equal(await split.locator('#memory-measure').isDisabled(), !canMeasure);
  if (canMeasure) {
    await split.locator('#memory-measure').click();
    const cdp = await page.context().newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage');
    await split.waitForFunction(() => document.getElementById('memory-app-label').textContent.includes('NAPの使用量'));
    assert.match(await split.locator('#memory-app-used').textContent(), /[MGK]iB/);
    assert.match(await split.locator('#memory-app-detail').textContent(), /測定/);
    await cdp.detach();
  }
  await split.locator('#load-test').click(); await split.waitForFunction(() => !document.getElementById('split').disabled);
  await split.locator('#split').click(); await split.waitForFunction(() => !window.napSplit.state.busy && window.napSplit.state.files.length === 2);
  const retained = await page.evaluate(() => window.nap.state.split.resultBytes);
  assert.ok(retained > 0); assert.equal(await split.locator('#memory-results').textContent(), formatMemory(retained));
  await page.getByRole('tab', { name: /get-consensus/ }).click();
  assert.equal(await consensus.locator('#memory-panel').isVisible(), true); assert.equal(await consensus.locator('#memory-results').textContent(), formatMemory(retained));
  assert.equal(await consensus.locator('#memory-panel').evaluate(element => element.open), false);
  await consensus.locator('#memory-title').click();
  assert.equal(await consensus.locator('#memory-app-label').textContent(), await split.locator('#memory-app-label').textContent());
  await consensus.locator('#memory-title').click();
  assert.equal(await consensus.locator('#memory-app-used').isVisible(), false);
  await consensus.locator('#memory-title').click();
  await consensus.locator('.memory-details summary').click();
  await consensus.locator('#memory-panel').screenshot({ path: path.join(output, 'memory-monitor.png') });
  await page.screenshot({ path: path.join(output, 'memory-monitor-location.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await consensus.locator('#memory-panel').screenshot({ path: path.join(output, 'memory-monitor-mobile.png') });
  assert.equal(await consensus.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await consensus.evaluate(() => document.getElementById('memory-panel').getBoundingClientRect().bottom <= document.getElementById('start').getBoundingClientRect().top), true);
  await page.locator('#tab-split-reads').click();
  assert.equal(await split.locator('#memory-panel').evaluate(element => element.open), true, 'Expanded state survives returning to a tab');
  console.log('PASS placement above all execution buttons, native browser measurement where supported, actual split result sizes, tab retention and mobile layout');

  const fixture = await browser.newPage();
  fixture.on('pageerror', error => errors.push(error.message));
  await fixture.addInitScript(() => {
    const MiB = 1024 ** 2;
    window.memoryTest = { heap: { usedJSHeapSize: 64 * MiB, totalJSHeapSize: 96 * MiB, jsHeapSizeLimit: 256 * MiB }, calls: 0, reject: false };
    Object.defineProperty(performance, 'memory', { configurable: true, get: () => window.memoryTest.heap });
    Object.defineProperty(performance, 'measureUserAgentSpecificMemory', { configurable: true, value: () => {
      window.memoryTest.calls++;
      if (window.memoryTest.reject) return Promise.reject(new Error('Test measurement error'));
      return new Promise(resolve => { window.memoryTest.resolve = resolve; });
    } });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
  });
  await fixture.goto(base + '#get-consensus'); await fixture.waitForFunction(() => window.nap?.state.consensus);
  const fixtureConsensus = fixture.frames().find(frame => frame.url() === base + '/get-consensus/');
  let fixturePanel = fixtureConsensus;
  await fixturePanel.locator('#memory-title').click();
  assert.equal(await fixturePanel.locator('#memory-app-used').textContent(), '64.0 MiB');
  assert.equal(await fixturePanel.locator('#memory-auto-budget').textContent(), '1.00 GiB');
  assert.equal(await fixturePanel.locator('#memory-heap-limit').textContent(), '256.0 MiB');
  assert.equal(await fixturePanel.locator('#memory-headroom').textContent(), '192.0 MiB');
  assert.equal(await fixturePanel.locator('#memory-device').textContent(), '4.00 GiB');
  await fixturePanel.locator('#memory-measure').click(); assert.equal(await fixturePanel.locator('#memory-measure').isDisabled(), true);
  await fixture.getByRole('tab', { name: /split-reads/ }).click();
  fixturePanel = fixture.frames().find(frame => frame.url() === base + '/split-reads/');
  await fixturePanel.locator('#memory-title').click();
  assert.equal(await fixturePanel.locator('#memory-measure').isDisabled(), true, 'Pending state shared across tabs');
  await fixturePanel.evaluate(() => document.getElementById('memory-measure').onclick());
  assert.equal(await fixture.evaluate(() => window.memoryTest.calls), 1, 'No overlapping measurements');
  await fixture.evaluate(() => window.memoryTest.resolve({ bytes: 300 * 1024 ** 2 }));
  await fixturePanel.waitForFunction(() => !document.getElementById('memory-measure').disabled);
  assert.equal(await fixturePanel.locator('#memory-app-used').textContent(), '300.0 MiB');
  assert.equal(await fixtureConsensus.locator('#memory-app-used').textContent(), '300.0 MiB', 'Same NAP measurement in every panel');
  assert.equal(await fixturePanel.evaluate(() => window.memoryTest.calls), 0, 'Measurement uses the parent page and includes all stages');
  await fixture.evaluate(() => { window.memoryTest.heap.usedJSHeapSize = 72 * 1024 ** 2; });
  await fixturePanel.waitForFunction(() => document.getElementById('memory-heap-detail').textContent.includes('184.0 MiB'), { timeout: 10000 });
  assert.equal(await fixturePanel.locator('#memory-app-used').textContent(), '300.0 MiB', 'Measured sample is kept separate from periodic heap updates');
  assert.equal(await fixture.evaluate(() => window.memoryTest.calls), 1, 'Automatic refresh does not trigger detailed measurements');
  await fixture.evaluate(() => { window.memoryTest.reject = true; }); await fixturePanel.locator('#memory-measure').click();
  await fixturePanel.waitForFunction(() => document.getElementById('memory-app-detail').textContent.includes('測定できませんでした'));
  assert.equal(await fixturePanel.locator('#memory-app-used').textContent(), '300.0 MiB');
  await fixture.evaluate(() => { window.memoryTest.heap.usedJSHeapSize = 80 * 1024 ** 2; });
  await fixturePanel.locator('#memory-refresh').click();
  assert.equal(await fixturePanel.locator('#memory-headroom').textContent(), '176.0 MiB');
  console.log('PASS periodic heap updates, manual refresh/measurement, pending/error handling and independent metrics');

  const unsupported = await browser.newPage();
  unsupported.on('pageerror', error => errors.push(error.message));
  await unsupported.addInitScript(() => {
    Object.defineProperty(performance, 'memory', { configurable: true, value: undefined });
    Object.defineProperty(performance, 'measureUserAgentSpecificMemory', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: undefined });
  });
  await unsupported.goto(base); await unsupported.waitForFunction(() => window.nap?.state.consensus);
  const unavailableSplit = unsupported.frames().find(frame => frame.url() === base + '/split-reads/');
  assert.equal(await unavailableSplit.locator('#memory-app-used').textContent(), '取得できません');
  assert.equal(await unavailableSplit.locator('#memory-measure').isDisabled(), true);
  assert.equal(await unavailableSplit.locator('#memory-heap-limit').textContent(), '取得できません');
  assert.equal(await unavailableSplit.locator('#memory-headroom').textContent(), '取得できません');
  assert.equal(await unavailableSplit.locator('#memory-device').textContent(), '取得できません');
  assert.equal(await unavailableSplit.locator('#memory-auto-budget').textContent(), '512.0 MiB');
  await unsupported.getByRole('tab', { name: /get-consensus/ }).click();
  const unavailableConsensus = unsupported.frames().find(frame => frame.url() === base + '/get-consensus/');
  assert.equal(await unavailableConsensus.locator('#memory-panel').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => !url.includes('/api/')), 'Memory panel never requests local-only server information');
  console.log('PASS unsupported browser APIs show unavailable values without preventing normal app operation');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
