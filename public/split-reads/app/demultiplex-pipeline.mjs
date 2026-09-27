import { prepareInputs, parseHits, assignHits, renderFastq, readFastq } from './demultiplex-core.mjs';
import { ASSIGNMENT_HEADER, reportFiles } from './demultiplex-results.mjs';

export { UPSTREAM_COMMIT } from './demultiplex-results.mjs';
// A file-processing slot reuses its BLAST client. Keep a safe batch limit once
// a large HSP collection has exceeded that runtime's memory capacity.
const batchLimits = new WeakMap();
export async function createDatabases(prepared, blast) {
  await blast.writeFile('primers.fa', prepared.primerFasta);
  await blast.writeFile('tags.fa', prepared.tagFasta);
  for (const name of ['primers', 'tags']) {
    const result = await blast.run('makeblastdb', ['-in', `${name}.fa`, '-dbtype', 'nucl', '-out', name]);
    if (result.exitCode !== 0) throw new Error(`makeblastdb: ${result.stderr || result.stdout}`);
  }
}
export async function runPipeline({ fastqFiles, primerText, sampleText, options, diagnostics = false, prepared: inputPrepared, databaseReady = false, includeReports = true, allowEmpty = false }, blast, notify = () => {}) {
  const started = performance.now();
  if (!fastqFiles?.length) throw new Error('FASTQ または FASTQ.gz を選択してください。');
  const prepared = inputPrepared || prepareInputs(primerText, sampleText, options);
  const parts = new Map(), counts = new Map(), histogram = new Map();
  const add = (name, text) => { if (!parts.has(name)) parts.set(name, []); parts.get(name).push(text); };
  let totalReads = 0, assignedReads = 0, segments = 0, totalBases = 0, batches = 0, consumed = 0, memoryRetries = 0;
  let batchLimit = Math.min(prepared.options.batchSize, batchLimits.get(blast) || Infinity);
  const totalBytes = fastqFiles.reduce((sum, file) => sum + file.size, 0);
  let phase = 'counting', inputReads = null, countedReads = 0, scanConsumed = 0;
  const progress = stage => notify({ type: 'progress', stage, phase, inputReads, countedReads, scanConsumed, totalReads, assignedReads, segments, batches, consumed, totalBytes });
  const execute = async (command, args) => {
    const result = await blast.run(command, args);
    if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  };
  if (!databaseReady) {
    progress('プライマー DB を作成');
    if (prepared.normalized) notify({ type: 'log', text: `${prepared.normalized} 配列の #_#番号 をサンプル表のプライマー名に対応させました。` });
    await createDatabases(prepared, blast);
  }
  // Compressed input is read ahead in large chunks. Its byte counter can reach
  // EOF before the first BLAST call, so count records without retaining them
  // and use completed records as the processing progress denominator.
  progress('総リード数を確認');
  let lastCountProgress = performance.now();
  for (const file of fastqFiles) {
    for await (const record of readFastq(file, bytes => { scanConsumed += bytes; })) {
      countedReads++;
      if (performance.now() - lastCountProgress >= 100) {
        progress('総リード数を確認'); lastCountProgress = performance.now();
      }
    }
  }
  inputReads = countedReads; phase = 'processing';
  progress('リード数確認済み・分割を開始');
  if (includeReports) { add('primer-clean.fa', prepared.cleanFasta); add('primer-tags.fa', prepared.tagsFasta); }
  add('assignments.tsv', includeReports ? ASSIGNMENT_HEADER : '');
  if (diagnostics) add('primer-hits.tsv', '');
  async function processBatch(records) {
    if (records.length > batchLimit) {
      for (let offset = 0; offset < records.length;) {
        const chunk = records.slice(offset, offset + batchLimit);
        await processBatch(chunk);
        offset += chunk.length;
      }
      return;
    }
    batches++;
    progress(`プライマー BLAST（バッチ ${batches}）`);
    // Synthetic query IDs prevent duplicate read names across files from being
    // merged by BLAST/AWK-style grouping. Original IDs are kept in all outputs.
    const queryIds = new Map(records.map((record, index) => [`read_${index + 1}`, record]));
    await blast.writeFile('batch.fa', [...queryIds].map(([id, record]) => `>${id}\n${record.sequence}\n`).join(''));
    const search = ['-query', 'batch.fa', '-task', prepared.options.task, '-num_threads', '1', '-word_size', '4', '-outfmt', '6'];
    // Default task, scoring, DUST and e-value settings match the source script.
    try {
      await execute('blastn', ['-db', 'primers', ...search, '-max_target_seqs', '10000', '-out', 'primer-hits.tsv']);
      progress(`バーコード BLAST（バッチ ${batches}）`);
      await execute('blastn', ['-db', 'tags', ...search, '-out', 'tag-hits.tsv']);
    } catch (error) {
      if (!/BLAST ran out of memory/i.test(error.message) || records.length === 1) throw error;
      batches--; memoryRetries++;
      batchLimit = Math.ceil(records.length / 2);
      batchLimits.set(blast, batchLimit);
      for (const name of ['batch.fa', 'primer-hits.tsv', 'tag-hits.tsv']) await blast.removeFile(name);
      notify({ type: 'log', text: `BLAST のメモリ不足により、1バッチを最大 ${batchLimit} リードに小分けして再試行します。検索条件は維持します。` });
      await processBatch(records);
      return;
    }
    progress(`ヒット判定・FASTQ 分割（バッチ ${batches}）`);
    const primerHits = parseHits(await blast.readFile('primer-hits.tsv'), prepared.subjects);
    const tagHits = parseHits(await blast.readFile('tag-hits.tsv'), prepared.tagSubjects);
    const { assignments, annotated } = assignHits(primerHits, tagHits, prepared);
    const assigned = new Set();
    for (const assignment of assignments) {
      const record = queryIds.get(assignment.query), output = renderFastq(record, assignment);
      add(`output/${assignment.sample}.fq`, output.text);
      assigned.add(assignment.query); segments++; totalBases += output.length;
      if (!counts.has(assignment.sample)) counts.set(assignment.sample, { sample: assignment.sample, segments: 0, bases: 0, minLength: Infinity, maxLength: 0 });
      const count = counts.get(assignment.sample); count.segments++; count.bases += output.length;
      count.minLength = Math.min(count.minLength, output.length); count.maxLength = Math.max(count.maxLength, output.length);
      const bin = output.length < 100 ? -1 : Math.floor(Math.log(output.length / 100) / Math.log(1.1));
      const key = `${assignment.sample}\t${bin}`;
      if (!histogram.has(key)) histogram.set(key, { sample: assignment.sample, bin, segments: 0, bases: 0 });
      const h = histogram.get(key); h.segments++; h.bases += output.length;
      add('assignments.tsv', [record.id, assignment.number, assignment.sample, assignment.leftPrimer, assignment.rightPrimer, assignment.start, assignment.end, assignment.strand, assignment.ampliconLength, output.length].join('\t') + '\n');
    }
    assignedReads += assigned.size; totalReads += records.length;
    for (const [id, record] of queryIds) if (!assigned.has(id)) add('unassigned.fq', `@${record.header}\n${record.sequence}\n+\n${record.quality}\n`);
    if (diagnostics) {
      for (const hit of tagHits) {
        const fields = [...hit.fields]; fields[0] = queryIds.get(hit.query).id; fields[1] = hit.primer.name;
        add('barcode-hits.tsv', `${fields.join('\t')}\n`);
      }
      for (const hit of annotated) {
        const fields = [...hit.fields]; fields[0] = queryIds.get(hit.query).id; fields[1] = hit.primer.name;
        add('primer-hits.tsv', `${fields.join('\t')}\t${Number(hit.barcode)}\n`);
      }
    }
    for (const name of ['batch.fa', 'primer-hits.tsv', 'tag-hits.tsv']) await blast.removeFile(name);
    progress(`バッチ ${batches} 完了`);
  }
  let batch = [];
  for (const file of fastqFiles) {
    for await (const record of readFastq(file, bytes => { consumed += bytes; })) {
      batch.push(record);
      if (batch.length === batchLimit) { await processBatch(batch); batch = []; }
    }
  }
  if (batch.length) await processBatch(batch);
  if (!totalReads && !allowEmpty) throw new Error('FASTQ にリードがありません。');
  phase = 'finalizing'; progress('ファイルの集計・出力準備');
  const rows = [...counts.values()].sort((a, b) => a.sample.localeCompare(b.sample));
  const summary = { totalReads, assignedReads, unassignedReads: totalReads - assignedReads, segments, totalBases, batches, memoryRetries, samples: rows, primerSequences: prepared.primers.length, sampleDefinitions: prepared.samples.length, normalizedPrimerNames: prepared.normalized, elapsedMs: performance.now() - started };
  const files = [...parts].map(([name, chunks]) => ({ name, blob: new Blob(chunks, { type: 'text/plain;charset=utf-8' }) })).sort((a, b) => a.name.localeCompare(b.name));
  if (includeReports) files.push(...reportFiles(summary, [...histogram.values()], { options: prepared.options, diagnostics, fastqFiles }));
  phase = 'complete'; progress('完了');
  return { summary, files, histogram: [...histogram.values()] };
}
