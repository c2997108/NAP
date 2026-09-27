import { gzipTransform } from './gzip-stream.mjs';
export const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
export const sampleName = name => name.replace(/\.(fastq|fq)(\.gz)?$/i, '').replace(/\s/g, '_');
export const safeName = name => { const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_'); return safe === '.' || safe === '..' ? `s_${safe}` : safe; };
export const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function fasta(records, width = 0) {
  return records.map(r => `>${r.id}\n${width ? r.seq.match(new RegExp(`.{1,${width}}`, 'g')).join('\n') : r.seq}\n`).join('');
}
export function fastq(records) { return records.map(r => `@${r.header || r.id}\n${r.seq}\n+\n${r.qual}\n`).join(''); }
export function parseFasta(text) {
  const records = [];
  for (const line of decode(text).split(/\r?\n/)) {
    if (line.startsWith('>')) records.push({id:line.slice(1),seq:''});
    else if (line.trim()) {
      if (!records.length) throw new Error('FASTA ヘッダーがありません。');
      records.at(-1).seq += line.trim();
    }
  }
  return records;
}
export function qscore(header) {
  const m = header.match(/(?:^|\s)qs:f:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?=\s|$)/);
  return m ? Number(m[1]) : null;
}
export async function* streamFastq(file, {signal,onProgress = () => {}} = {}) {
  let consumed = 0;
  let stream = file.stream().pipeThrough(new TransformStream({ transform(chunk, controller) { consumed += chunk.byteLength; controller.enqueue(chunk); } }));
  const signature = new Uint8Array(await file.slice(0,2).arrayBuffer());
  if (signature[0] === 31 && signature[1] === 139) stream = stream.pipeThrough(gzipTransform(file));
  else if (/\.gz$/i.test(file.name)) throw new Error(`${file.name}: gzip ファイルの形式が不正です。`);
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8',{fatal:true})).getReader();
  const ids = new Set(); let buffer = '', lines = [], size = 0, count = 0;
  function line(text) {
    if (!lines.length && !text) return;
    lines.push(text.replace(/\r$/, ''));
    if (lines.length < 4) return;
    const [head,seq,plus,qual] = lines; lines = [];
    if (!head.startsWith('@') || !plus.startsWith('+') || !seq || seq.length !== qual.length || !/^[ACGTURYSWKMBDHVNacgturyswkmbdhvn]+$/.test(seq) || !/^[!-~]+$/.test(qual)) {
      throw new Error(`${file.name}: FASTQ レコード ${count + 1} が不正です（配列・品質長と4行形式を確認してください）。`);
    }
    const header = head.slice(1), id = header.split(/\s/)[0];
    if (!id || ids.has(id)) throw new Error(`${file.name}: リード ID が空または重複しています: ${id}`);
    ids.add(id); count++; return {id,header,seq:seq.toUpperCase(),qual,q:qscore(header)};
  }
  try {
    for (;;) {
      signal?.throwIfAborted();
      const {value,done} = await reader.read(); if (done) break;
      buffer += value; size += value.length;
      let start = 0, at;
      while ((at = buffer.indexOf('\n',start)) >= 0) { signal?.throwIfAborted(); const record = line(buffer.slice(start,at)); start = at + 1; if (record) yield record; }
      buffer = buffer.slice(start); onProgress({reads:count,bytes:size,consumedBytes:consumed,fraction:Math.min(.99, consumed / Math.max(1,file.size))});
    }
    if (buffer) { const record = line(buffer); if (record) yield record; }
    if (lines.length) throw new Error(`${file.name}: FASTQ の末尾が不完全です。`);
    if (!count) throw new Error(`${file.name}: リードがありません。`);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readFastq(file, options) {
  const records = [];
  for await (const record of streamFastq(file, options)) records.push(record);
  return records;
}
function roundEven(x) { const f = Math.floor(x), d = x-f; return d === .5 ? f + f%2 : Math.round(x); }
// extract_consensus.py: gaps compete with the most frequent base; qualities
// encode column agreement (100% => Z), and are NOT ordinary Phred scores.
export function consensus(alignment, id = 'consensus') {
  const seqs = parseFasta(alignment).map(r => r.seq.toUpperCase());
  if (!seqs.length || seqs.some(s => s.length !== seqs[0].length)) throw new Error('アラインメントの長さが一致しません。');
  let seq = '', qual = '', ties = 0;
  for (let i=0;i<seqs[0].length;i++) {
    const counts = new Map(); let gaps = 0;
    for (const s of seqs) { const b = s[i]; if (b === '-') gaps++; else counts.set(b,(counts.get(b)||0)+1); }
    if (!counts.size) continue;
    const top = Math.max(...counts.values()); if (gaps > top) continue;
    const bases = [...counts].filter(([,n])=>n===top).map(([b])=>b);
    if (bases.length > 1) ties++;
    // Upstream uses unseeded random.choice. A stable lexical tie-break makes
    // repeated browser analyses reproducible, and is recorded in run.json.
    seq += bases.sort(compare)[0];
    qual += String.fromCharCode(Math.max(33,Math.min(90,roundEven(top/(seqs.length-gaps)*100)-10)));
  }
  if (!seq) throw new Error('コンセンサス配列が空になりました。');
  return {id,seq,qual,ties};
}
export function parseUc(text) {
  const groups = new Map();
  for (const line of decode(text).trim().split('\n')) {
    const f = line.split('\t'); if (!['S','H'].includes(f[0])) continue;
    if (!groups.has(f[1])) groups.set(f[1],{id:Number(f[1]),members:[]});
    groups.get(f[1]).members.push(f[8]);
  }
  return [...groups.values()].sort((a,b)=>a.id-b.id);
}
