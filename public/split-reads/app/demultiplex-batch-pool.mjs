import { readFastq } from './demultiplex-core.mjs';
import { runFilePool } from './demultiplex-file-pool.mjs';
import { fileParallelPlan } from '../../shared/parallel-settings.mjs';

// Only job metadata is queued up front. FASTQ records are streamed into at
// most one batch per active slot, and discarded after that batch succeeds.
export async function runSingleFileBatches({ file, options, referenceBytes = 0, retainedBytes = 0, createSlot, onProgress = () => {}, onPlan = () => {}, onMemoryPressure = () => {}, environment = globalThis.navigator || {}, retryDelay = 250 }) {
  let inputReads = 0, maxReadLength = 0, scanConsumed = 0, consumed = 0, lastCount = 0;
  const started = performance.now();
  const input = { index: 0, name: file.name, size: file.size, state: 'running', phase: 'counting', stage: '総リード数を確認', inputReads: null, countedReads: 0, scanConsumed: 0, consumed: 0, totalReads: 0, assignedReads: 0, segments: 0, batches: 0, fraction: 0 };
  const countProgress = () => {
    Object.assign(input, { countedReads: inputReads, scanConsumed });
    onProgress({ type: 'progress', stage: input.stage, phase: 'counting', fraction: 0, fileCount: 1, activeFiles: 1, completedFiles: 0, activeBatches: 0, completedBatches: 0, totalReads: 0, assignedReads: 0, segments: 0, files: [{ ...input }] });
  };
  countProgress();
  for await (const record of readFastq(file, bytes => { scanConsumed += bytes; })) {
    inputReads++; maxReadLength = Math.max(maxReadLength, record.sequence.length);
    if (performance.now() - lastCount >= 100) { countProgress(); lastCount = performance.now(); }
  }
  if (!inputReads) throw new Error('FASTQ にリードがありません。');
  const batchCount = Math.ceil(inputReads / options.batchSize);
  const plan = fileParallelPlan({ parallelMode: options.parallelMode, parallelCount: options.concurrency }, [file], { referenceBytes, retainedBytes, jobs: batchCount, workingBytes: maxReadLength * Math.min(options.batchSize, inputReads) * 24 }, environment);
  onPlan(plan);
  const jobs = Array.from({ length: batchCount }, (_, index) => ({ index, name: `${file.name} · バッチ ${index + 1}`, size: Math.min(options.batchSize, inputReads - index * options.batchSize) }));
  const reader = readFastq(file, bytes => { consumed += bytes; })[Symbol.asyncIterator]();
  let readQueue = Promise.resolve(), bufferedReads = 0, maxBufferedReads = 0, latest;
  const makeFile = job => {
    job.file = new File(job.chunks, `${file.name}.part${job.index + 1}.fq`);
    delete job.chunks; return job.file;
  };
  const readBatch = (job, signal) => {
    signal?.throwIfAborted();
    if (job.file) return Promise.resolve(job.file);
    if (job.chunks) return Promise.resolve().then(() => makeFile(job));
    const pending = readQueue.then(async () => {
      const chunks = [];
      try {
        for (let count = 0; count < job.size; count++) {
          signal?.throwIfAborted();
          const { value: record, done } = await reader.next();
          if (done) throw new Error(`${file.name}: 再読込時のリード数が変化しました。`);
          chunks.push(`@${record.header}\n${record.sequence}\n+\n${record.quality}\n`);
          bufferedReads++; maxBufferedReads = Math.max(maxBufferedReads, bufferedReads);
        }
        job.chunks = chunks;
        return makeFile(job);
      } catch (error) { if (!job.chunks) bufferedReads -= chunks.length; throw error; }
    });
    // Preserve original batch order even when worker completion order differs.
    readQueue = pending.then(() => {}, () => {});
    return pending;
  };
  const report = progress => {
    Object.assign(input, { state: progress.completedFiles === batchCount ? 'complete' : 'running', phase: 'processing', stage: progress.stage,
      inputReads, countedReads: inputReads, scanConsumed, consumed, totalReads: progress.totalReads, assignedReads: progress.assignedReads,
      segments: progress.segments, batches: progress.batches, fraction: progress.fraction });
    latest = { ...progress, mode: 'batches', batchCount, activeBatches: progress.activeFiles, completedBatches: progress.completedFiles,
      activeFiles: progress.completedFiles === batchCount ? 0 : 1, completedFiles: progress.completedFiles === batchCount ? 1 : 0,
      fileCount: 1, consumed, totalBytes: file.size, files: [{ ...input }] };
    onProgress(latest);
  };
  try {
    const pool = await runFilePool({ files: jobs, concurrency: plan.limit, prepareJob: (job, index, signal) => readBatch(job, signal), includeFiles: false, retryDelay, onProgress: report, onMemoryPressure,
      createSlot: index => {
        const slot = createSlot(index); let disposed = false;
        return { initialize: () => slot.initialize(), dispose: () => { disposed = true; return slot.dispose(); },
          run: async (job, notify) => {
            if (disposed) throw new Error('バッチ処理を中止しました。');
            const batch = await readBatch(job);
            if (disposed) throw new Error('バッチ処理を中止しました。');
            const result = await slot.run(batch, notify);
            bufferedReads -= job.size; delete job.file;
            return result;
          } };
      } });
    if (!(await reader.next()).done) throw new Error(`${file.name}: 再読込時のリード数が変化しました。`);
    Object.assign(input, { state: 'complete', phase: 'complete', stage: '完了', consumed: file.size, fraction: 1, endedMs: performance.now() - started });
    return { results: pool.results, execution: { ...plan, ...pool.execution, mode: 'batches', batchSize: options.batchSize, batchCount,
      completedBatches: batchCount, maxActiveBatches: pool.execution.maxActiveFiles, maxActiveFiles: 1,
      maxBufferedReads, maxReadLength, completedFiles: 1, files: [{ ...input }] }, progress: { ...latest, files: [{ ...input }] } };
  } finally { await reader.return(); }
}
