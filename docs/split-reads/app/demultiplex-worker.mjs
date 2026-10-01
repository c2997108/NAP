import { BlastClient } from './blast-client.mjs';
import { createDatabases } from './demultiplex-pipeline.mjs';
import { prepareInputs } from './demultiplex-core.mjs';
import { runFilePool } from './demultiplex-file-pool.mjs';
import { FileProcessingSlot } from './demultiplex-file-client.mjs';
import { mergeFileResults } from './demultiplex-results.mjs';
import { makeZip } from './zip.mjs';
import { SPLIT_RESULT_PAGE, splitFastqArchiveFiles } from './result-page.mjs';

let files = [], fastqReport, running = false;
async function run(payload) {
  const started = performance.now();
  if (!payload.fastqFiles?.length) throw new Error('FASTQ または FASTQ.gz を選択してください。');
  const prepared = prepareInputs(payload.primerText, payload.sampleText, payload.options);
  const log = text => postMessage({ type: 'log', text });
  postMessage({ type: 'progress', stage: '共通プライマー DB を作成', totalReads: 0, assignedReads: 0, segments: 0, consumed: 0, totalBytes: payload.fastqFiles.reduce((sum, file) => sum + file.size, 0), activeFiles: 0, completedFiles: 0, fileCount: payload.fastqFiles.length });
  if (prepared.normalized) log(`${prepared.normalized} 配列の #_#番号 をサンプル表のプライマー名に対応させました。`);
  let databases;
  const databaseBlast = new BlastClient({ onLog: message => log(message.text) });
  try {
    await createDatabases(prepared, databaseBlast);
    const databaseFiles = (await databaseBlast.listFiles()).filter(file => /^(primers|tags)\./.test(file.name) && !file.name.endsWith('.fa'));
    databases = await Promise.all(databaseFiles.map(async file => ({ name: file.name, data: await databaseBlast.readFile(file.name, { encoding: 'binary' }) })));
  } finally { databaseBlast.dispose(); }
  const databaseBuildMs = performance.now() - started;
  log(`ファイル単位で最大 ${Math.min(prepared.options.concurrency, payload.fastqFiles.length)} ファイルを同時処理します。`);
  let lastProgress;
  const pool = await runFilePool({ files: payload.fastqFiles, concurrency: prepared.options.concurrency, createSlot: () => new FileProcessingSlot({ prepared, databases, diagnostics: payload.diagnostics }, log), onProgress: message => { lastProgress = message; postMessage(message); } });
  postMessage({ ...lastProgress, stage: '分割結果を統合・集計' });
  const output = mergeFileResults(pool.results, prepared, { ...payload, diagnostics: Boolean(payload.diagnostics) }, { ...pool.execution, databaseBuildMs }, performance.now() - started);
  files = output.files;
  fastqReport = output.fastqReport;
  return { summary: output.summary, files: files.map(({ name, blob }) => ({ name, size: blob.size })) };
}
self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    let result;
    if (type === 'run') {
      if (running) throw new Error('すでに処理中です。');
      running = true;
      files = [];
      fastqReport = null;
      try {
        result = await run(payload);
      } finally { running = false; }
    } else if (type === 'file') {
      result = files.find(file => file.name === payload.name)?.blob;
      if (!result) throw new Error(`出力がありません: ${payload.name}`);
    } else if (type === 'zip') {
      if (payload?.fastqOnly && !files.some(file => file.name.startsWith('output/') && file.name.endsWith('.fq'))) throw new Error('分割された FASTQ がありません。');
      const selected = payload?.fastqOnly
        ? [...splitFastqArchiveFiles(files), { name: SPLIT_RESULT_PAGE, blob: fastqReport }]
        : files;
      result = await makeZip(selected);
    }
    else throw new Error(`Unknown request: ${type}`);
    postMessage({ id, result });
  } catch (error) { postMessage({ id, error: error.message || String(error) }); }
};
