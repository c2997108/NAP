// A bounded pool owns one reusable processing slot per concurrent FASTQ file.
// All state is indexed by input position, including files with duplicate names.
export async function runFilePool({ files, concurrency, createSlot, onProgress = () => {}, now = () => performance.now() }) {
  if (!files.length) throw new Error('FASTQ または FASTQ.gz を選択してください。');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('同時処理ファイル数は 1〜16 の整数にしてください。');
  const limit = Math.min(concurrency, files.length), started = now(), results = new Array(files.length), slots = [];
  const states = files.map((file, index) => ({ index, name: file.name, size: file.size, state: 'queued', phase: 'queued', stage: '待機中', inputReads: null, countedReads: 0, scanConsumed: 0, consumed: 0, totalReads: 0, assignedReads: 0, segments: 0, batches: 0 }));
  // Start larger files first to avoid a single large file holding up the end.
  const order = files.map((file, index) => index).sort((a, b) => files[b].size - files[a].size || a - b);
  let next = 0, activeFiles = 0, completedFiles = 0, maxActiveFiles = 0;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const totalWeight = files.reduce((sum, file) => sum + Math.max(1, file.size), 0);
  const snapshot = () => states.map(state => ({ ...state, fraction: state.state === 'complete' ? 1 : state.inputReads > 0 ? Math.min(0.99, state.totalReads / state.inputReads) : 0 }));
  const emit = stage => {
    const progressFiles = snapshot();
    onProgress({ type: 'progress', stage, concurrency: limit, activeFiles, completedFiles, fileCount: files.length,
      fraction: progressFiles.reduce((sum, file) => sum + file.fraction * Math.max(1, file.size), 0) / totalWeight,
      totalBytes, consumed: states.reduce((sum, file) => sum + file.consumed, 0),
      totalReads: states.reduce((sum, file) => sum + file.totalReads, 0), assignedReads: states.reduce((sum, file) => sum + file.assignedReads, 0),
      segments: states.reduce((sum, file) => sum + file.segments, 0), batches: states.reduce((sum, file) => sum + file.batches, 0), files: progressFiles });
  };
  try {
    for (let index = 0; index < limit; index++) slots.push(createSlot(index));
    emit('ファイル処理の準備');
    await Promise.all(slots.map(slot => slot.initialize()));
    await Promise.all(slots.map(async (slot, workerIndex) => {
      while (next < order.length) {
        const index = order[next++], state = states[index];
        Object.assign(state, { state: 'running', phase: 'counting', stage: '総リード数を確認', workerIndex, startedMs: now() - started });
        activeFiles++; maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
        emit(`${state.name} を開始`);
        try {
          const result = await slot.run(files[index], message => {
            for (const key of ['phase', 'stage', 'inputReads', 'countedReads', 'scanConsumed', 'consumed', 'totalReads', 'assignedReads', 'segments', 'batches']) if (message[key] !== undefined) state[key] = message[key];
            emit(`${state.name}: ${message.stage}`);
          });
          results[index] = result;
          Object.assign(state, { state: 'complete', phase: 'complete', stage: '完了', inputReads: result.summary.totalReads, consumed: state.size, totalReads: result.summary.totalReads, assignedReads: result.summary.assignedReads, segments: result.summary.segments, batches: result.summary.batches, endedMs: now() - started });
          completedFiles++; activeFiles--;
          emit(`${state.name} 完了`);
        } catch (error) {
          state.state = 'error'; state.phase = 'error'; state.stage = error.message || String(error); activeFiles--; state.endedMs = now() - started;
          emit(`${state.name}: エラー`);
          throw new Error(`${state.name}: ${error.message || error}`);
        }
      }
    }));
    return { results, execution: { concurrency: limit, maxActiveFiles, files: snapshot() } };
  } finally {
    // On the first error stop every other file immediately. Disposing a slot
    // rejects its pending requests; Promise.all has handlers for all runners.
    for (const slot of slots) slot.dispose();
  }
}
