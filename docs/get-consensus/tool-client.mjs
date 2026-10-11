/** Each job owns a disposable worker, so C/C++ global state never crosses runs. */
export class ConsensusTools {
  #jobs = new Set();
  run(tool, args = [], { files = {}, outputs = [], stdin = '', signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    let worker = new Worker(new URL('./tool-worker.mjs', import.meta.url), { type: 'module' });
    this.#jobs.add(worker);
    return new Promise((resolve, reject) => {
      const done = () => {
        const finished = worker;
        if (!finished) return;
        worker = null;
        finished.onmessage = null; finished.onerror = null;
        finished.terminate(); this.#jobs.delete(finished); signal?.removeEventListener('abort', abort);
      };
      const abort = () => { done(); reject(new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => { done(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (data.progress) { onProgress?.(data.progress); return; }
        done();
        if (data.error) reject(Object.assign(new Error(data.error), { code: data.code }));
        else resolve(data.result);
      };
      try { worker.postMessage({ tool, args, files, outputs, stdin }); }
      catch (error) { done(); reject(error); }
    });
  }
  align(fasta, options = {}) {
    const { args = ['--auto'], isolatedStages = false, ...settings } = options;
    // On memory pressure, terminate each native MAFFT stage before starting
    // the next. The normal path keeps its single worker and startup cost.
    if (isolatedStages) return import('./mafft.mjs').then(({ alignMafft }) => alignMafft(fasta, args,
      (tool, argv, files) => this.run(tool, argv, { ...files, signal: settings.signal }),
      (command, detail) => settings.onProgress?.(detail || { command })));
    return this.run('mafft', args, { ...settings, stdin: fasta });
  }
}
