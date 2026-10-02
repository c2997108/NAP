import { gzipTransform } from '../../get-consensus/app/gzip-stream.mjs';
export async function* lines(file, signal) {
  let stream = file.stream(), pending = '';
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (magic[0] === 31 && magic[1] === 139) stream = stream.pipeThrough(gzipTransform(file));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let start = 0, end;
      while ((end = pending.indexOf('\n', start)) >= 0) { yield pending.slice(start, end).replace(/\r$/, ''); start = end + 1; }
      pending = pending.slice(start);
    }
    if (pending) yield pending.replace(/\r$/, '');
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function* fastaRecords(file, signal) {
  let id, fragments = [];
  for await (const line of lines(file, signal)) {
    if (!line.trim()) continue;
    if (line.startsWith('>')) {
      if (id) yield record(id, fragments);
      id = line.slice(1).trim().split(/\s/)[0]; fragments = [];
      if (!id) throw Error('参照FASTAの配列名が空欄です。');
    } else {
      if (!id) throw Error('参照FASTAの先頭には >配列名 が必要です。');
      fragments.push(line.replace(/\s/g, ''));
    }
  }
  if (id) yield record(id, fragments);
}
function record(id, fragments) {
  const seq = fragments.join('').toUpperCase();
  if (!seq || !/^[ACGTRYSWKMBDHVNUX]+$/.test(seq)) throw Error(`${id}: 参照FASTAの塩基配列が不正です。`);
  return { id, seq };
}
export async function inspectFasta(file, signal, maxBases) {
  let totalBases = 0, sequences = 0, volumes = 0, bases = 0;
  for await (const record of fastaRecords(file, signal)) {
    if (bases && bases + record.seq.length > maxBases) { volumes++; bases = 0; }
    totalBases += record.seq.length; sequences++; bases += record.seq.length;
  }
  if (!sequences) throw Error('参照FASTAに配列がありません。');
  return { totalBases, sequences, volumes: volumes + (bases ? 1 : 0) };
}
export async function* fastaShards(file, maxBases, signal) {
  let parts = [], subjects = new Map(), bases = 0, index = 0;
  for await (const record of fastaRecords(file, signal)) {
    if (bases && bases + record.seq.length > maxBases) { yield { fasta: parts.join(''), subjects }; parts = []; subjects = new Map(); bases = 0; }
    const id = `r${index++}`;
    parts.push(`>${id}\n${record.seq}\n`); subjects.set(id, record.id); bases += record.seq.length;
  }
  if (bases) yield { fasta: parts.join(''), subjects };
}
export async function readTaxonomy(file, needed, signal) {
  const map = new Map();
  for await (const line of lines(file, signal)) {
    const separator = line.indexOf('\t');
    if (separator < 0) { if (line.trim()) throw Error('分類対応表は参照ID・分類パスのタブ区切り2列です。'); continue; }
    const id = line.slice(0, separator);
    if (needed.has(id)) map.set(id, line.slice(separator + 1).split('\t')[0]);
  }
  return map;
}
export function validateManifest(manifest) {
  if (manifest.format !== 'nap-blast-v4-shards-1' || !manifest.shards?.length || !Number.isSafeInteger(manifest.totalBases) || manifest.totalBases < 1) throw Error('NAP用のBLAST DB v4分割マニフェストが不正です。');
  const specs = [manifest.taxonomy, ...manifest.shards.flatMap(shard => shard.files || [])];
  for (const spec of specs) {
    if (!spec || !/^[\w.-]+$/.test(spec.name) || !/^[\w.-]+$/.test(spec.url) || spec.name.includes('..') || spec.url.includes('..') || !['gzip', undefined].includes(spec.compression) || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw Error('参照DBのファイル定義が不正です。');
  }
  for (const shard of manifest.shards) if (!/^[\w.-]+$/.test(shard.name) || shard.name.includes('..') || !['.nhr', '.nin', '.nsq'].every(suffix => shard.files.some(file => file.name === shard.name + suffix))) throw Error('参照DBの分割ファイルが不足しています。');
  return manifest;
}
export async function referenceFile(spec, source, signal) {
  let file;
  if (source.files) file = source.files.find(file => file.name === spec.url);
  else {
    const response = await fetch(new URL(spec.url, source.baseUrl), { signal });
    if (!response.ok) throw Error(`参照DBを読み込めません: ${spec.url} (HTTP ${response.status})`);
    file = new File([await response.blob()], spec.url);
  }
  if (!file) throw Error(`参照DBのファイルが見つかりません: ${spec.url}`);
  const bytes = await file.arrayBuffer(), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== spec.sha256) throw Error(`参照DBのSHA-256が一致しません: ${spec.url}`);
  return file;
}
export async function referenceBytes(spec, source, signal) {
  const file = await referenceFile(spec, source, signal);
  const bytes = spec.compression === 'gzip' ? new Uint8Array(await new Response(file.stream().pipeThrough(gzipTransform(file))).arrayBuffer()) : new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== spec.bytes) throw Error(`参照DBのサイズが一致しません: ${spec.url}`);
  return bytes;
}
