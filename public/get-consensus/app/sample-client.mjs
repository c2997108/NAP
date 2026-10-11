/** Whole-sample workers keep parsing and result processing off the coordinator. */
export class ConsensusSamples {
  run(kind, payload, { signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    let worker = new Worker(new URL('./sample-worker.mjs', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (terminate = true) => {
        const finished = worker;
        if (!finished) return;
        settled = true; worker = null;
        finished.onmessage = null; finished.onerror = null;
        if (terminate) finished.terminate(); signal?.removeEventListener('abort', abort);
      };
      const abort = () => { done(); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => { done(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.progress) { onProgress(data.progress); return; }
        done(false); // The worker closes itself after its final reply.
        if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name, code: data.error.code }));
        else { data.result.local.files = receivedOutputBlobs(data.result.local.files); resolve(data.result); }
      };
      try { worker.postMessage({ kind, ...payload }); }
      catch (error) { done(); reject(error); }
    });
  }
}
import { receivedOutputBlobs } from '../../shared/output-blob.mjs';
