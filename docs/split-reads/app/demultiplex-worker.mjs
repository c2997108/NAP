import { fileParallelPlan } from '../../shared/parallel-settings.mjs';
import { BlastClient } from './blast-client.mjs';
import { createDatabases } from './demultiplex-pipeline.mjs';
import { prepareInputs } from './demultiplex-core.mjs';
import { runSingleFileBatches } from './demultiplex-batch-pool.mjs';
import { runFilePool } from './demultiplex-file-pool.mjs';
import { FileProcessingSlot } from './demultiplex-file-client.mjs';
import { mergeFileResults } from './demultiplex-results.mjs';
import { outputTransfers } from '../../shared/output-blob.mjs';
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
  const referenceBytes = databases.reduce((sum, file) => sum + file.data.byteLength, 0);
  const showPlan = (plan, unit) => log(`CPU ${plan.cores} 論理コア / ${plan.parallelMode === 'auto' ? '自動' : '手動'}の指定 ${plan.requested} / 推定メモリー予算 ${plan.memoryBudgetMB} MiB / 最大 ${plan.limit} ${unit}同時処理`);
  const onMemoryPressure = p => log(`メモリー不足: 同時処理上限 ${p.previous} → ${p.limit}。${p.name} を再試行します。`);
  const createSlot = () => new FileProcessingSlot({ prepared, databases, diagnostics: payload.diagnostics }, log);
  let lastProgress, pool, plan;
  const onProgress = message => { lastProgress = message; postMessage(message); };
  if (payload.fastqFiles.length === 1) {
    pool = await runSingleFileBatches({ file: payload.fastqFiles[0], options: prepared.options, referenceBytes, retainedBytes: payload.retainedBytes, createSlot, onProgress, onMemoryPressure,
      onPlan: value => { plan = value; showPlan(plan, 'バッチ'); } });
    lastProgress = pool.progress;
  } else {
    plan = fileParallelPlan({ parallelMode: prepared.options.parallelMode, parallelCount: prepared.options.concurrency }, payload.fastqFiles, { referenceBytes, retainedBytes: payload.retainedBytes });
    showPlan(plan, 'ファイル');
    pool = await runFilePool({ files: payload.fastqFiles, concurrency: plan.limit, onMemoryPressure, createSlot, onProgress });
  }
  postMessage({ ...lastProgress, stage: '分割結果を統合・集計' });
  const output = mergeFileResults(pool.results, prepared, { ...payload, diagnostics: Boolean(payload.diagnostics) }, { ...plan, ...pool.execution, databaseBuildMs }, performance.now() - started);
  // Transfer byte parts; construct downloadable Blobs in the page.
  return output;
}
self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type !== 'run') throw new Error(`Unknown request: ${type}`);
    const result = await run(payload);
    postMessage({ id, result }, outputTransfers(result.files, result.fastqReport));
  } catch (error) { postMessage({ id, error: error.message || String(error) }); }
  finally { self.close(); }
};
