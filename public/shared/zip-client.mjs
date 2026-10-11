// ZIP work gets its own short-lived worker instead of retaining an analysis.
export function makeZipInWorker(files, { signal } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./zip-worker.mjs', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const done = (terminate = true) => {
      worker.onmessage = worker.onerror = null;
      if (terminate) worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { done(); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { done(); reject(new Error(event.message || 'ZIP Worker error')); };
    worker.onmessage = ({ data }) => {
      done(false);
      if (data.error) reject(new Error(data.error)); else resolve(asBlob(data.result));
    };
    try { worker.postMessage({ files }); } catch (error) { done(); reject(error); }
  });
}
import { asBlob } from './output-blob.mjs';
import './worker-host.mjs';
