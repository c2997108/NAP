/** Whole-sample workers keep parsing and result processing off the coordinator. */
export class ConsensusSamples {
  run(kind, payload, { signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./sample-worker.mjs', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const done = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
      const abort = () => { done(); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => { done(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.progress) { onProgress(data.progress); return; }
        done();
        if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name, code: data.error.code }));
        else resolve(data.result);
      };
      worker.postMessage({ kind, ...payload });
    });
  }
}
