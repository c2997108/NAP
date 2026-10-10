import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const versionBlock = /<!-- app-version:start -->[\s\S]*?<!-- app-version:end -->/g;
const placeholder = '<!-- app-version:start --><!-- app-version:end -->';
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validTimestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const japanTime = value => new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' JST';

async function publicFiles(directory, prefix = '') {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await publicFiles(path.join(directory, entry.name), name + '/'));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

export async function writeVersion(projectRoot = root, { now = new Date() } = {}) {
  const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const directory = path.join(projectRoot, 'public');
  const indexPath = path.join(directory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  if ([...html.matchAll(versionBlock)].length !== 1) throw Error('Expected one app-version block in public/index.html');

  // Hash the served files, excluding the generated version label itself.
  // This also distinguishes uncommitted builds and works without Git installed.
  const hash = createHash('sha256').update(version + '\0');
  for (const name of await publicFiles(directory)) {
    const bytes = name === 'index.html' ? Buffer.from(html.replace(versionBlock, placeholder)) : await readFile(path.join(directory, name));
    hash.update(name + '\0' + bytes.length + '\0').update(bytes);
  }
  const build = hash.digest('hex').slice(0, 12);
  // Keep the last update for identical contents, including when the server restarts.
  const previous = html.match(versionBlock)[0];
  const previousTime = /data-updated-at="([^"]+)"/.exec(previous)?.[1];
  const updatedAt = previous.includes(`data-build="${build}"`) && validTimestamp(previousTime) ? previousTime : now.toISOString();
  const label = `<!-- app-version:start --><span id="app-version" class="app-version" data-version="${escapeHtml(version)}" data-build="${build}" data-updated-at="${updatedAt}" title="表示中のNAPのバージョン・配布ファイルのビルドID・最終更新日時（日本標準時）">v${escapeHtml(version)}<span class="build-id">ビルド ${build}</span><time class="updated-at" datetime="${updatedAt}">最終更新 ${japanTime(updatedAt)}</time></span><!-- app-version:end -->`;
  const updated = html.replace(versionBlock, () => label);
  if (updated !== html) await writeFile(indexPath, updated);
  return { version, build, updatedAt };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, build, updatedAt } = await writeVersion();
  console.log(`NAP v${version} · ビルド ${build} · 最終更新 ${japanTime(updatedAt)}`);
}
