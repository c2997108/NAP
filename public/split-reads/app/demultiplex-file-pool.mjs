import { mapParallel } from '../../get-consensus/app/parallel.mjs';

// Reuse BLAST slots between files; release failed and surplus slots before
// retrying. Outputs remain indexed by the original input order.
export async function runFilePool({ files, concurrency, createSlot, prepareJob = () => {}, includeFiles = true, onProgress = () => {}, onMemoryPressure = () => {}, retryDelay = 250, now = () => performance.now() }) {
  if (!files.length) throw new Error('FASTQ または FASTQ.gz を選択してください。');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('同時処理ファイル数は1以上の整数にしてください。');
  const limit = Math.min(concurrency, files.length), started = now(), slots = new Set(), idle = [];
  const budget = { limit, memoryRetries: 0 };
  const states = files.map((file, index) => ({ index, name: file.name, size: file.size, state: 'queued', phase: 'queued', stage: '待機中', inputReads: null, countedReads: 0, scanConsumed: 0, consumed: 0, totalReads: 0, assignedReads: 0, segments: 0, batches: 0, attempts: 0 }));
  let activeFiles = 0, completedFiles = 0, maxActiveFiles = 0, nextSlot = 0;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const totalWeight = files.reduce((sum, file) => sum + Math.max(1, file.size), 0);
  const fraction = state => state.state === 'complete' ? 1 : state.inputReads > 0 ? Math.min(0.99, state.totalReads / state.inputReads) : 0;
  const snapshot = () => states.map(state => ({ ...state, fraction: fraction(state) }));
  const emit = stage => {
    const progressFiles = includeFiles ? snapshot() : undefined;
    onProgress({ type: 'progress', stage, concurrency: budget.limit, memoryRetries: budget.memoryRetries, activeFiles, completedFiles, fileCount: files.length,
      fraction: states.reduce((sum, file) => sum + fraction(file) * Math.max(1, file.size), 0) / totalWeight,
      totalBytes, consumed: states.reduce((sum, file) => sum + file.consumed, 0),
      totalReads: states.reduce((sum, file) => sum + file.totalReads, 0), assignedReads: states.reduce((sum, file) => sum + file.assignedReads, 0),
      segments: states.reduce((sum, file) => sum + file.segments, 0), batches: states.reduce((sum, file) => sum + file.batches, 0), files: progressFiles });
  };
  const closing = [];
  const close = slot => { if (slots.delete(slot)) closing.push(slot.dispose()); };
  try {
    const results = await mapParallel(files, limit, async (file, index, signal) => {
      const state = states[index];
      Object.assign(state, { state: 'running', phase: 'counting', stage: '総リード数を確認', startedMs: state.startedMs ?? now() - started });
      state.attempts++; emit(`${state.name} を開始`);
      let slot;
      const abort = () => { if (slot) close(slot); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await prepareJob(file, index, signal);
        signal.throwIfAborted();
        slot = idle.pop();
        if (!slot) { slot = createSlot(nextSlot++); slots.add(slot); await slot.initialize(); }
        signal.throwIfAborted();
        const result = await slot.run(file, message => {
          for (const key of ['phase', 'stage']) if (message[key] !== undefined) state[key] = message[key];
          if (message.inputReads !== undefined && message.inputReads !== null) state.inputReads = message.inputReads;
          // Keep high-water marks during a whole-file retry. Nothing from a
          // failed attempt is added to final output or counted twice.
          for (const key of ['countedReads', 'scanConsumed', 'consumed', 'totalReads', 'assignedReads', 'segments', 'batches']) if (message[key] !== undefined) state[key] = Math.max(state[key], message[key]);
          emit(`${state.name}: ${message.stage}`);
        });
        Object.assign(state, { state: 'complete', phase: 'complete', stage: '完了', inputReads: result.summary.totalReads, consumed: state.size, totalReads: result.summary.totalReads, assignedReads: result.summary.assignedReads, segments: result.summary.segments, batches: result.summary.batches, endedMs: now() - started });
        if (slots.size > budget.limit) close(slot); else idle.push(slot);
        return result;
      } catch (error) {
        if (slot) close(slot);
        state.state = 'error'; state.phase = 'error'; state.stage = error.message || String(error); state.endedMs = now() - started;
        emit(`${state.name}: エラー`);
        throw new Error(`${state.name}: ${error.message || error}`);
      } finally { signal.removeEventListener('abort', abort); }
    }, { budget, retryDelay, priority: file => file.size,
      onState: state => { activeFiles = state.active.length; completedFiles = state.completed; maxActiveFiles = Math.max(maxActiveFiles, activeFiles); emit('ファイル分割'); },
      onMemoryPressure: pressure => {
        while (idle.length && slots.size > budget.limit) close(idle.pop());
        const state = states[pressure.index]; state.state = 'queued'; state.phase = 'queued'; state.stage = 'メモリー不足のため再試行待ち';
        onMemoryPressure({ ...pressure, name: state.name });
      }
    });
    return { results, execution: { concurrency: budget.limit, initialLimit: limit, maxActiveFiles, memoryRetries: budget.memoryRetries, files: snapshot() } };
  } finally { for (const slot of slots) close(slot); await Promise.all(closing); }
}
