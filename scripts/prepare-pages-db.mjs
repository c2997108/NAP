import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { validateManifest } from '../public/annotation/app/reference.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'data/annotation');
const staged = path.join(root, 'build/annotation-pages-db');
const pages = path.join(root, 'docs');
const destination = path.join(pages, 'annotation/database');
const sourceBytes = await readFile(path.join(source, 'manifest.json'));
const manifest = validateManifest(JSON.parse(sourceBytes));
const specs = [manifest.taxonomy, ...manifest.shards.flatMap(shard => shard.files)];
assert.equal(new Set(specs.map(spec => spec.url)).size, specs.length, 'Duplicate reference file URLs');
await mkdir(staged, { recursive: true });
let next = 0, completed = 0;
// Keep the original local DB intact; only the public copy is recompressed.
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < specs.length) {
    const spec = specs[next++], sourceDigest = createHash('sha256'), rawDigest = createHash('sha256'), packedDigest = createHash('sha256');
    const expectedDigest = spec.sha256;
    let rawBytes = 0, packedBytes = 0;
    const input = createReadStream(path.join(source, spec.url));
    const inspectInput = new Transform({ transform(chunk, encoding, callback) { sourceDigest.update(chunk); callback(null, chunk); } });
    const inspectRaw = new Transform({ transform(chunk, encoding, callback) { rawBytes += chunk.length; rawDigest.update(chunk); callback(null, chunk); } });
    const inspectPacked = new Transform({ transform(chunk, encoding, callback) { packedBytes += chunk.length; packedDigest.update(chunk); callback(null, chunk); } });
    const streams = [input, inspectInput];
    if (spec.compression === 'gzip') streams.push(createGunzip());
    await pipeline(...streams, inspectRaw, createGzip({ level: 9 }), inspectPacked, createWriteStream(path.join(staged, spec.url)));
    assert.equal(sourceDigest.digest('hex'), expectedDigest, `Source SHA-256: ${spec.url}`);
    assert.equal(rawBytes, spec.bytes, `Original DB size: ${spec.url}`);
    assert.ok(packedBytes < 100 * 1024 * 1024, `GitHub file size: ${spec.url}`);
    Object.assign(spec, { compression: 'gzip', sha256: packedDigest.digest('hex'), packedBytes, rawSha256: rawDigest.digest('hex') });
    if (++completed % 10 === 0 || completed === specs.length) console.log(`NAP: 参照DBを再圧縮 ${completed}/${specs.length}`);
  }
}));
manifest.distribution = {
  gzipLevel: 9,
  packedBytes: specs.reduce((total, spec) => total + spec.packedBytes, 0),
  originalManifestSha256: createHash('sha256').update(sourceBytes).digest('hex'),
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(path.join(staged, 'manifest.json'), manifestText);
async function siteBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (file === destination) continue;
    assert.ok(!entry.isSymbolicLink(), `Unexpected symbolic link: ${file}`);
    total += entry.isDirectory() ? await siteBytes(file) : (await stat(file)).size;
  }
  return total;
}
const total = await siteBytes(pages) + manifest.distribution.packedBytes + Buffer.byteLength(manifestText);
assert.ok(total <= 1_000_000_000, `Published site exceeds the GitHub Pages 1 GB limit: ${total} bytes`);
await mkdir(destination, { recursive: true });
for (const name of ['manifest.json', ...specs.map(spec => spec.url)]) await cp(path.join(staged, name), path.join(destination, name));
console.log(`NAP: 公開用DBを docs/annotation/database/ に保存しました。サイト全体 ${(total / 1_000_000).toFixed(1)} MB / 1,000 MB。`);
