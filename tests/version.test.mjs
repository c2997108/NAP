import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeVersion } from '../scripts/write-version.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nap-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'public', 'app'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  await writeFile(path.join(directory, 'public', 'index.html'), '<h1>NAP</h1><!-- app-version:start --><!-- app-version:end -->');
  await writeFile(path.join(directory, 'public', 'app', 'main.mjs'), 'export const ready = true;');
  return directory;
}

test('static version labels work without Git and repeated generation preserves the build ID', async t => {
  const directory = await fixture(t);
  const first = await writeVersion(directory);
  const html = await readFile(path.join(directory, 'public', 'index.html'), 'utf8');
  assert.equal(first.version, '1.0.0');
  assert.match(first.build, /^[0-9a-f]{12}$/);
  assert.ok(html.includes(`data-version="1.0.0" data-build="${first.build}"`));
  assert.ok(html.includes(`v1.0.0<span class="build-id">ビルド ${first.build}</span>`));
  assert.deepEqual(await writeVersion(directory), first);
  assert.equal(await readFile(path.join(directory, 'public', 'index.html'), 'utf8'), html);
});

test('application files, binary assets and package version changes update the build ID', async t => {
  const directory = await fixture(t);
  const first = await writeVersion(directory);
  await writeFile(path.join(directory, 'public', 'app', 'main.mjs'), 'export const ready = false;');
  const changed = await writeVersion(directory);
  assert.notEqual(changed.build, first.build);
  await writeFile(path.join(directory, 'public', 'engine.wasm'), new Uint8Array([0, 97, 115, 109]));
  const binary = await writeVersion(directory);
  assert.notEqual(binary.build, changed.build);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  const release = await writeVersion(directory);
  assert.equal(release.version, '1.1.0');
  assert.notEqual(release.build, binary.build);
  assert.ok((await readFile(path.join(directory, 'public', 'index.html'), 'utf8')).includes('>v1.1.0<'));
});

test('missing or duplicate markers fail without rewriting the page', async t => {
  const directory = await fixture(t);
  for (const html of ['<h1>NAP</h1>', '<!-- app-version:start --><!-- app-version:end --><!-- app-version:start --><!-- app-version:end -->']) {
    await writeFile(path.join(directory, 'public', 'index.html'), html);
    await assert.rejects(writeVersion(directory), /Expected one app-version block/);
    assert.equal(await readFile(path.join(directory, 'public', 'index.html'), 'utf8'), html);
  }
});
