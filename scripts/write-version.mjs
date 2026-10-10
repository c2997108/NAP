import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const versionBlock = /<!-- app-version:start -->[\s\S]*?<!-- app-version:end -->/g;
const placeholder = '<!-- app-version:start --><!-- app-version:end -->';
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

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

export async function writeVersion(projectRoot = root) {
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
  const label = `<!-- app-version:start --><span id="app-version" class="app-version" data-version="${escapeHtml(version)}" data-build="${build}" title="表示中のNAPのバージョンと配布ファイルのビルドID">v${escapeHtml(version)}<span class="build-id">ビルド ${build}</span></span><!-- app-version:end -->`;
  const updated = html.replace(versionBlock, () => label);
  if (updated !== html) await writeFile(indexPath, updated);
  return { version, build };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, build } = await writeVersion();
  console.log(`NAP v${version} · ビルド ${build}`);
}
