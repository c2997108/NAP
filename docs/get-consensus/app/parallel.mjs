import { isMemoryAllocationError, memoryError } from './memory.mjs';

/** Bounded jobs, ordered output, and optional shared adaptive memory budget. */
export async function mapParallel(items, limit, task, { signal, onState = () => {}, budget, priority = () => 0, onMemoryPressure = () => {}, retryDelay = 250 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Parallel limit must be a positive integer.');
  signal?.throwIfAborted();
  const controller = new AbortController(), active = new Set(), results = new Array(items.length), retries = new Map();
  const pending = items.map((_, index) => index).sort((a, b) => priority(items[b], b) - priority(items[a], a) || a - b);
  if (budget) { budget.limit ??= limit; budget.memoryRetries ??= 0; }
  const capacity = () => Math.min(limit, budget?.limit ?? limit, items.length);
  let completed = 0, failure, timer, readyAt = 0, pump;
  const report = () => onState({ active: [...active], completed, total: items.length, limit: capacity(), requestedLimit: Math.min(limit, items.length), memoryRetries: budget?.memoryRetries || 0 });
  const abort = () => { controller.abort(signal.reason); pump?.(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise(resolve => {
      const settled = () => {
        if (!active.size && (controller.signal.aborted || completed === items.length)) { clearTimeout(timer); resolve(); return true; }
        return false;
      };
      const fail = error => { failure ??= error; controller.abort(error); };
      pump = () => {
        clearTimeout(timer);
        if (settled() || controller.signal.aborted) return;
        if (readyAt > Date.now()) { timer = setTimeout(pump, readyAt - Date.now()); return; }
        while (pending.length && active.size < capacity()) {
          const index = pending.shift(), launchedLimit = capacity(); active.add(index); report();
          Promise.resolve().then(() => task(items[index], index, controller.signal)).then(result => {
            active.delete(index); results[index] = result; completed++;
            if (!controller.signal.aborted) report();
          }, error => {
            active.delete(index);
            if (controller.signal.aborted) return;
            const attempt = (retries.get(index) || 0) + 1;
            // Drain jobs already running at the larger limit; retry only the
            // failed job. A single job is retried once after its worker closes.
            if (budget && isMemoryAllocationError(error) && attempt <= 5 && !(launchedLimit === 1 && attempt > 1)) {
              const previous = capacity();
              if (previous === launchedLimit) budget.limit = Math.max(1, Math.floor(previous / 2));
              budget.memoryRetries++; retries.set(index, attempt); pending.unshift(index);
              readyAt = Date.now() + retryDelay;
              onMemoryPressure({ index, previous, limit: capacity(), attempt, error }); report();
            } else fail(isMemoryAllocationError(error) ? memoryError(error) : error);
          }).catch(fail).finally(pump);
        }
      };
      pump();
    });
    if (failure) throw failure;
    controller.signal.throwIfAborted();
    return results;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
