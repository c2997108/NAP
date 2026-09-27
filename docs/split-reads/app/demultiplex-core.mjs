// Browser port of nanopore~split-barcode's primer/tag and adjacent-hit rules.
// Coordinates in BLAST and assignments are 1-based, inclusive.
import { gzipTransform } from './gzip-stream.mjs';
export const DEFAULT_OPTIONS = Object.freeze({ expand: true, primerCoverage: 0.6, primerIdentity: 80, suppressChimeras: false, barcodeCoverage: 0.9, barcodeIdentity: 90, batchSize: 300, task: 'megablast', concurrency: 8 });
const ambiguity = { A:'A', C:'C', G:'G', T:'T', R:'AG', M:'AC', W:'AT', S:'CG', Y:'CT', K:'GT', H:'ATC', B:'GTC', D:'GAT', V:'ACG', N:'ACGT' };
const complement = { A:'T', C:'G', G:'C', T:'A', B:'V', V:'B', D:'H', H:'D', K:'M', M:'K', R:'Y', Y:'R', S:'S', W:'W', N:'N' };
export const isDefinitionName = name => /^[A-Za-z0-9_.-]+$/.test(name);
export function validateDefinitionName(name, label) {
  if (!isDefinitionName(name)) throw new Error(`${label}: 名前には半角英数字と - . _ だけを使ってください。`);
}
export function reverseComplement(sequence) { return [...sequence.toUpperCase()].reverse().map(base => complement[base] || 'N').join(''); }
export function validateOptions(values = {}) {
  const options = { ...DEFAULT_OPTIONS, ...values };
  if (!['megablast', 'blastn'].includes(options.task)) throw new Error('検索モードは megablast または blastn にしてください。');
  for (const key of ['primerCoverage', 'barcodeCoverage']) if (!Number.isFinite(options[key]) || options[key] <= 0 || options[key] > 1) throw new Error(`${key}: 0 より大きく 1 以下にしてください。`);
  for (const key of ['primerIdentity', 'barcodeIdentity']) if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > 100) throw new Error(`${key}: 0〜100 にしてください。`);
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10000) throw new Error('バッチサイズは 1〜10000 の整数にしてください。');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('同時処理ファイル数は 1〜16 の整数にしてください。');
  for (const key of ['expand', 'suppressChimeras']) if (typeof options[key] !== 'boolean') throw new Error(`${key}: boolean が必要です。`);
  return options;
}
export function parsePrimers(text) {
  const records = []; let current;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      current = { name: line.slice(1).trim().split(/\s+/)[0], sequence: '' }; records.push(current);
    } else {
      if (!current) throw new Error('primer FASTA の先頭には >名前 が必要です。');
      current.sequence += line.toUpperCase().replace(/[^ACGTBVDHKMRYSWN]/g, '');
    }
  }
  if (!records.length) throw new Error('プライマー配列がありません。');
  const names = new Set();
  for (const record of records) {
    validateDefinitionName(record.name, 'プライマー');
    if (!record.name || record.sequence.length < 4) throw new Error(`プライマー ${record.name || '(名前なし)'} は4塩基以上必要です。`);
    if (names.has(record.name)) throw new Error(`プライマー名が重複しています: ${record.name}`);
    names.add(record.name);
  }
  return records;
}
export function parseSamples(text, { emptyNames = 'generate' } = {}) {
  const samples = [], names = new Set(), pairs = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const columns = raw.includes('\t') ? raw.split('\t').map(value => value.trim()) : raw.trim().split(/\s+/);
    let [name, forward, reverse, minText = '', maxText = ''] = columns;
    const min = Number(minText || 0), max = Number(maxText || 0);
    if (!forward || !reverse || columns.length < 3 || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0 || (max !== 0 && max < min)) throw new Error(`sample 表 ${index + 1} 行目: 名前、F、R、最小長、最大長の5列を確認してください。長さの空欄は制限なしです。`);
    validateDefinitionName(forward, 'Forwardプライマー'); validateDefinitionName(reverse, 'Reverseプライマー');
    if (!name && emptyNames === 'omit') continue;
    name ||= `s_${forward}_${reverse}`;
    validateDefinitionName(name, 'サンプル');
    const pair = `${forward}\t${reverse}`;
    if (names.has(name) || pairs.has(pair)) throw new Error(`sample 表に重複した名前またはプライマー対があります: ${name}`);
    names.add(name); pairs.add(pair); samples.push({ name, forward, reverse, min, max: max || Infinity });
  }
  if (!samples.length) throw new Error('sample 表に有効な行がありません。');
  return samples;
}
function groupBy(records, key) {
  const groups = new Map();
  for (const record of records) { const id = key(record); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(record); }
  return groups;
}
function trimShared(records) {
  const output = [];
  for (const group of groupBy(records, record => record.sequence.slice(0, 8)).values()) {
    let common = group[0].sequence;
    for (const { sequence } of group) {
      let index = 0; while (index < common.length && common[index] === sequence[index]) index++;
      common = common.slice(0, index);
    }
    const fallback = group.some(record => record.sequence.length - common.length < 8);
    for (const record of group) output.push({ ...record, sequence: reverseComplement(fallback ? record.sequence : record.sequence.slice(common.length)) });
  }
  return output;
}
export function deriveTags(records) { return trimShared(trimShared(records)); }
function expandSequence(sequence) {
  let variants = [''];
  for (const base of sequence) {
    if (variants.length * ambiguity[base].length > 4096) throw new Error('1プライマーの縮重展開が4096配列を超えます。「縮重塩基を展開」を解除するか配列を絞ってください。');
    variants = variants.flatMap(prefix => [...ambiguity[base]].map(value => prefix + value));
  }
  return variants;
}
export function prepareInputs(primerText, sampleText, values = {}) {
  const options = validateOptions(values), primers = parsePrimers(primerText), samples = parseSamples(sampleText);
  const requested = new Set(samples.flatMap(sample => [sample.forward, sample.reverse]));
  let normalized = 0;
  const subjects = new Map(); const fasta = [];
  for (const [index, primer] of primers.entries()) {
    let family = primer.name;
    while (!requested.has(family) && /#_#\d+$/.test(family)) family = family.replace(/#_#\d+$/, '');
    primer.family = family; primer.id = `primer_${index + 1}`;
    if (family !== primer.name) normalized++;
    const sequences = options.expand ? expandSequence(primer.sequence) : [primer.sequence];
    for (const [variant, sequence] of sequences.entries()) {
      const id = `${primer.id}_variant_${variant + 1}`;
      subjects.set(id, primer); fasta.push(`>${id}\n${sequence}\n`);
      if (subjects.size > 100000) throw new Error('縮重展開の総数が100000配列を超えます。入力を絞ってください。');
    }
  }
  const available = new Set(primers.map(primer => primer.family));
  const missing = [...requested].filter(name => !available.has(name));
  if (missing.length) throw new Error(`sample 表のプライマーが FASTA にありません: ${missing.slice(0, 8).join(', ')}`);
  const tags = deriveTags(primers), tagSubjects = new Map(tags.map(tag => [tag.id, tag]));
  return { options, primers, samples, subjects, tagSubjects, normalized,
    primerFasta: fasta.join(''), tagFasta: tags.map(tag => `>${tag.id}\n${tag.sequence}\n`).join(''),
    cleanFasta: primers.map(primer => `>${primer.name}\n${primer.sequence}\n`).join(''),
    tagsFasta: tags.map(tag => `>${tag.name}\n${tag.sequence}\n`).join('') };
}
export function parseHits(text, subjects) {
  const hits = [];
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t'); const primer = subjects.get(fields[1]);
    if (fields.length !== 12 || !primer) throw new Error('BLAST 出力の列またはプライマー ID が不正です。');
    hits.push({ query: fields[0], primer, identity: +fields[2], alignmentLength: +fields[3], qstart: +fields[6], qend: +fields[7], sstart: +fields[8], send: +fields[9], score: +fields[11], fields });
  }
  return hits;
}
function retainNoncontained(hits) {
  const kept = [];
  for (const hit of [...hits].sort((a, b) => b.score - a.score || (b.qend - b.qstart) - (a.qend - a.qstart))) {
    if (!kept.some(old => hit.qstart >= old.qstart && hit.qend <= old.qend)) kept.push(hit);
  }
  return kept;
}
export function deduplicateHits(hits) {
  const output = [];
  for (const queryHits of groupBy(hits, hit => hit.query).values()) {
    // After the first read, the source gawk loop inherits @val_num_asc:
    // subjects are ordered by their raw HSP count, then by subject name.
    // Use that order for every read; the source leaves the first unspecified.
    // This determines which primer variant survives equal score/span hits.
    const groups = [...groupBy(queryHits, hit => hit.primer.name).values()];
    groups.sort((a, b) => a.length - b.length || (a[0].primer.name < b[0].primer.name ? -1 : a[0].primer.name > b[0].primer.name ? 1 : 0));
    const byPrimer = groups.flatMap(retainNoncontained);
    output.push(...retainNoncontained(byPrimer).sort((a, b) => a.qstart - b.qstart));
  }
  return output;
}
export function assignHits(primerHits, tagHits, prepared) {
  const { options, samples } = prepared;
  const tags = groupBy(tagHits.filter(hit => hit.identity >= options.barcodeIdentity && hit.qend - hit.qstart + 1 >= hit.primer.sequence.length * options.barcodeCoverage), hit => hit.query);
  const pairs = new Map(samples.map(sample => [`${sample.forward}\t${sample.reverse}`, sample]));
  const assignments = [], annotated = [];
  for (const queryHits of groupBy(deduplicateHits(primerHits), hit => hit.query).values()) {
    let previous; let number = 0;
    for (const hit of queryHits) {
      // Expanded variants in the same family share a barcode; use the winning
      // full-primer hit's original ID for the tag correspondence.
      const barcode = (tags.get(hit.query) || []).some(tag => tag.primer.name === hit.primer.name && hit.qstart <= tag.qstart && hit.qend >= tag.qend && (hit.send - hit.sstart) * (tag.send - tag.sstart) > 0);
      annotated.push({ ...hit, barcode });
      if (!barcode) continue;
      const passes = hit.identity >= options.primerIdentity && hit.qend - hit.qstart + 1 >= hit.primer.sequence.length * options.primerCoverage;
      if (previous?.passes && passes && previous.sstart < previous.send && hit.send < hit.sstart) {
        let sample = pairs.get(`${previous.primer.family}\t${hit.primer.family}`), strand = 1;
        if (!sample) { sample = pairs.get(`${hit.primer.family}\t${previous.primer.family}`); strand = -1; }
        const ampliconLength = hit.qend - previous.qstart + 1;
        const start = previous.qend + 1, end = hit.qstart - 1;
        if (sample && ampliconLength >= sample.min && ampliconLength <= sample.max && end >= start) assignments.push({ query: hit.query, number: ++number, sample: sample.name, leftPrimer: previous.primer.family, rightPrimer: hit.primer.family, start, end, strand, ampliconLength });
      }
      if (options.suppressChimeras || passes) previous = { ...hit, passes };
    }
  }
  return { assignments, annotated };
}
export function renderFastq(record, assignment) {
  let sequence = record.sequence.slice(assignment.start - 1, assignment.end), quality = record.quality.slice(assignment.start - 1, assignment.end);
  if (assignment.strand === -1) { sequence = reverseComplement(sequence); quality = [...quality].reverse().join(''); }
  const metadata = record.header.slice(record.id.length).replace(/\t/g, ' ');
  const name = `${record.id}:${assignment.number}:${assignment.leftPrimer}:${assignment.rightPrimer}:${assignment.start}:${assignment.end}:${assignment.strand}${metadata}`;
  return { text: `@${name}\n${sequence}\n+\n${quality}\n`, length: sequence.length };
}
// Incremental four-line FASTQ reader, including gzip and concatenated gzip members.
export async function* readFastq(file, onBytes = () => {}) {
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream().pipeThrough(new TransformStream({ transform(chunk, controller) { onBytes(chunk.byteLength); controller.enqueue(chunk); } }));
  if (prefix[0] === 31 && prefix[1] === 139) stream = stream.pipeThrough(gzipTransform(file));
  else if (/\.gz$/i.test(file.name || '')) throw new Error(`${file.name}: gzip ヘッダーが不正です。`);
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8', { fatal: true })).getReader();
  let remainder = '', lines = [], lineNumber = 0;
  function accept(line) {
    lineNumber++;
    if (!lines.length && !line) return;
    lines.push(line);
    if (lines.length !== 4) return;
    const [header, sequence, separator, quality] = lines; lines = [];
    if (!header.startsWith('@') || !separator.startsWith('+') || !sequence || sequence.length !== quality.length || !/^[A-Za-z.=-]+$/.test(sequence) || !/^[!-~]+$/.test(quality)) throw new Error(`${file.name || 'FASTQ'} ${lineNumber - 3} 行目: FASTQ の4行と配列・品質長を確認してください。`);
    const name = header.slice(1).replace(/\t/g, ' '); const id = name.split(/\s+/)[0];
    if (!id) throw new Error('FASTQ のリード ID が空です。');
    return { id, header: name, sequence, quality };
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      remainder += value;
      let start = 0, end;
      while ((end = remainder.indexOf('\n', start)) !== -1) {
        const record = accept(remainder.slice(start, end).replace(/\r$/, '')); start = end + 1;
        if (record) yield record;
      }
      remainder = remainder.slice(start);
    }
    if (remainder) { const record = accept(remainder.replace(/\r$/, '')); if (record) yield record; }
    if (lines.length) throw new Error(`${file.name || 'FASTQ'}: 末尾の FASTQ レコードが不完全です。`);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
