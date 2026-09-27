/** Each job owns a disposable worker, so C/C++ global state never crosses runs. */
export class ConsensusTools {
  #jobs = new Set();
  run(tool, args = [], { files = {}, outputs = [], stdin = '', signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const worker = new Worker(new URL('./tool-worker.mjs', import.meta.url), { type: 'module' });
    this.#jobs.add(worker);
    return new Promise((resolve, reject) => {
      const done = () => {
        worker.terminate(); this.#jobs.delete(worker); signal?.removeEventListener('abort', abort);
      };
      const abort = () => { done(); reject(new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => { done(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.progress) { onProgress?.(data.progress); return; }
        done();
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.postMessage({ tool, args, files, outputs, stdin });
    });
  }
  align(fasta, options = {}) {
    const { args = ['--auto'], ...settings } = options;
    return this.run('mafft', args, { ...settings, stdin: fasta });
  }
}
