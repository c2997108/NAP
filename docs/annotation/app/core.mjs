export const defaults = {
  topScore: 1, minBitscore: 100, minIdentity: 90, minLength: 100, minCoverage: 0,
  batchSize: 100, shardBases: 16000000,
  internalControl: 'TCACCAACTGGGATGACATGGAGAAGATCTGGCACCACACCTTCTACAATGAGCTGCATGTGGCTCCCAAGGAGCACCGTATGCTGCTGACTGAGGTCCCCCTGAATCCAAGGCCAACCACAAGAAGATGA',
};
export const UPSTREAM_COMMIT = '5c98917ecd94f807670e0537c8a63c5a0a048924';
export const MAX_TARGETS = 500;
export function validateOptions(options = {}) {
  const o = { ...defaults, ...options };
  for (const key of ['topScore', 'minBitscore', 'minIdentity', 'minLength', 'minCoverage', 'batchSize', 'shardBases']) {
    if (!Number.isFinite(o[key])) throw Error(`${key}: 数値を入力してください。`);
  }
  if (o.topScore < 0 || o.topScore > 1) throw Error('LCAスコア比は0〜1です。');
  for (const key of ['minIdentity', 'minCoverage']) if (o[key] < 0 || o[key] > 100) throw Error(`${key}: 0〜100です。`);
  if (o.minBitscore < 0 || o.minLength < 0) throw Error('スコア・長さの閾値は0以上です。');
  for (const key of ['minLength', 'batchSize', 'shardBases']) if (!Number.isInteger(o[key]) || o[key] < (key === 'minLength' ? 0 : 1)) throw Error(`${key}: 整数を入力してください。`);
  o.internalControl = o.internalControl.replace(/\s/g, '').toUpperCase();
  if (o.internalControl && !/^[ACGTRYSWKMBDHVNU]+$/.test(o.internalControl)) throw Error('内部コントロール配列が不正です。');
  return o;
}
export function parseTable(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), header = lines.shift().split('\t');
  if (header.length < 4 || header.slice(0, 3).join('\t') !== 'id\tseq\tqual') throw Error('入力は id・seq・qual・サンプル別カウントのタブ区切り表です。');
  const names = header.slice(3), seen = new Set();
  if (names.some(name => !name) || new Set(names).size !== names.length) throw Error('サンプル列名が空欄または重複しています。');
  const rows = [];
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    const fields = line.split('\t'), [id, seq, qual] = fields;
    if (fields.length !== header.length) throw Error(`${index + 2}行目: 列数が一致しません。`);
    if (!id || /\s/.test(id) || seen.has(id)) throw Error(`${index + 2}行目: 配列IDが空欄・重複、または空白を含んでいます。`);
    if (!/^[ACGTRYSWKMBDHVNU]+$/i.test(seq)) throw Error(`${id}: 塩基配列が不正です。`);
    if (qual.length !== seq.length || /[^!-~]/.test(qual)) throw Error(`${id}: 配列と品質の長さ・形式が一致しません。`);
    const counts = fields.slice(3).map(value => value.trim() ? Number(value) : NaN);
    if (counts.some(value => !Number.isFinite(value) || value < 0)) throw Error(`${id}: カウントは0以上の数値にしてください。`);
    seen.add(id); rows.push({ id, seq, qual, counts, total: counts.reduce((sum, value) => sum + value, 0) });
  }
  if (!rows.length) throw Error('入力表に解析する配列がありません。');
  return { names, rows };
}
export function parseBlast(text, shard = 0, subjects = null) {
  const hits = [];
  for (const line of text.trim().split('\n')) {
    if (!line) continue;
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length !== 12 || fields.slice(2).some(value => !Number.isFinite(Number(value)))) throw Error('BLASTの12列出力が不正です。');
    const subject = subjects ? subjects.get(fields[1]) : fields[1];
    if (!subject) throw Error(`参照IDを解決できません: ${fields[1]}`);
    fields[1] = subject;
    hits.push({ query: fields[0], subject, identity: Number(fields[2]), length: Number(fields[3]), span: Number(fields[7]) - Number(fields[6]) + 1,
      bit: Number(fields[11]), evalue: Number(fields[10]), fields, shard, order: hits.length });
  }
  return hits;
}
// Apply BLAST's subject limit before the downstream filters, across all volumes.
// Preserve HSP order inside a subject, including multiple alignments per hit.
export class HitPool {
  constructor() { this.queries = new Map(); }
  add(hits) {
    for (const hit of hits) {
      if (!this.queries.has(hit.query)) this.queries.set(hit.query, new Map());
      const query = this.queries.get(hit.query), key = `${hit.shard}\t${hit.subject}`;
      if (!query.has(key)) query.set(key, { first: hit, hits: [] });
      query.get(key).hits.push(hit);
    }
    for (const subjects of this.queries.values()) {
      const sorted = [...subjects].sort(([, a], [, b]) => a.first.evalue - b.first.evalue || b.first.bit - a.first.bit || b.first.shard - a.first.shard || a.first.order - b.first.order);
      for (const [key] of sorted.slice(MAX_TARGETS)) subjects.delete(key);
    }
  }
  hits() {
    return [...this.queries.values()].flatMap(subjects => [...subjects.values()].sort((a, b) => a.first.evalue - b.first.evalue || b.first.bit - a.first.bit || b.first.shard - a.first.shard || a.first.order - b.first.order).flatMap(subject => subject.hits));
  }
}
export function filterHits(hits, rows, options) {
  const lengths = new Map(rows.map((row, index) => [`q${index}`, row.seq.length])), top = new Map();
  return hits.filter(hit => {
    if (hit.bit < options.minBitscore || hit.identity < options.minIdentity || hit.span < options.minLength || hit.span < lengths.get(hit.query) * options.minCoverage / 100) return false;
    if (!top.has(hit.query)) { top.set(hit.query, hit.bit); return true; }
    return hit.bit >= top.get(hit.query) * options.topScore;
  });
}
export function lowestCommonAncestor(paths) {
  const unique = [...new Set(paths)], root = commonPrefix(unique);
  if (root) return root;
  const chloroplast = unique.filter(path => path.startsWith('Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;'));
  return commonPrefix(chloroplast) || 'unknown';
}
function commonPrefix(paths) {
  if (!paths.length) return '';
  const prefix = paths[0].split(';');
  for (const path of paths.slice(1)) {
    const terms = path.split(';');
    let index = 0; while (index < prefix.length && prefix[index] && prefix[index] === terms[index]) index++;
    prefix.length = index;
  }
  const empty = prefix.findIndex(term => !term);
  return prefix.slice(0, empty < 0 ? prefix.length : empty).join(';');
}
export function annotate(table, hits, taxonomy, controls) {
  const grouped = new Map();
  for (const hit of hits) {
    if (!grouped.has(hit.query)) grouped.set(hit.query, []);
    grouped.get(hit.query).push(hit);
  }
  const annotations = new Map();
  for (const [query, group] of grouped) {
    const top = group[0];
    annotations.set(query, { lca: lowestCommonAncestor(group.map(hit => taxonomy.get(hit.subject) || '')), topTaxpath: taxonomy.get(top.subject) || '', length: top.length, identity: top.identity, identityText: top.fields[2], top });
  }
  // The script appends control alignments last, so their last qualifying HSP wins.
  for (const hit of controls) if (hit.identity >= 80 && hit.length >= 60) annotations.set(hit.query, { lca: 'internal_control', topTaxpath: 'internal_control', length: hit.length, identity: hit.identity, identityText: hit.fields[2], top: hit });
  const rows = table.rows.map((row, index) => ({ ...row, annotation: annotations.get(`q${index}`) || { lca: '', topTaxpath: '', length: '', identity: '' } }));
  const species = new Map();
  for (const row of rows) {
    const key = `${row.annotation.lca}:${row.annotation.topTaxpath}`;
    if (!species.has(key)) species.set(key, { ...row, counts: row.counts.map(() => 0), total: 0 });
    const group = species.get(key);
    row.counts.forEach((count, index) => { group.counts[index] += count; group.total += count; });
  }
  return { ...table, rows, species: [...species].sort(([a, x], [b, y]) => y.total - x.total || (a < b ? 1 : a > b ? -1 : 0)).map(([, row]) => row) };
}
export function taxTable(table, rows = table.rows) {
  return ['id\tseq\tqual\tlca\ttop.taxpath\talign.len\tidentity\t' + table.names.join('\t'), ...rows.map(row => [row.id, row.seq, row.qual, row.annotation.lca, row.annotation.topTaxpath, row.annotation.length, row.annotation.identityText ?? row.annotation.identity, ...row.counts].join('\t'))].join('\n') + '\n';
}
