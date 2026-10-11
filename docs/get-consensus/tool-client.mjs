/** Each job owns a disposable worker, so C/C++ global state never crosses runs. */
export class ConsensusTools {
  #jobs = new Set();
  #modules = new Map();
  constructor({ compiledModules = false } = {}) { this.compiledModules = compiledModules; }
  run(tool, args = [], { files = {}, outputs = [], stdin = '', signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (this.compiledModules && ['blastn', 'makeblastdb'].includes(tool)) {
      // Keep the compiled code alive for this pipeline, while each native job
      // still gets its own instance, heap and disposable worker.
      if (!this.#modules.has(tool)) {
        const pending = (async () => {
          const url = new URL(`../shared/wasm/${tool}.wasm`, import.meta.url);
          const response = await fetch(url);
          if (!response.ok) throw Error(`${tool}: WASMを読み込めません (HTTP ${response.status})`);
          return WebAssembly.compile(await response.arrayBuffer());
        })();
        this.#modules.set(tool, pending);
        pending.catch(() => { if (this.#modules.get(tool) === pending) this.#modules.delete(tool); });
      }
      return this.#modules.get(tool).then(wasmModule => this.#run(tool, args, { files, outputs, stdin, signal, onProgress }, wasmModule));
    }
    return this.#run(tool, args, { files, outputs, stdin, signal, onProgress });
  }
  #run(tool, args, { files, outputs, stdin, signal, onProgress }, wasmModule) {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    let worker = new Worker(new URL('./tool-worker.mjs', import.meta.url), { type: 'module' });
    this.#jobs.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (terminate = true) => {
        const finished = worker;
        if (!finished) return;
        settled = true; worker = null;
        finished.onmessage = null; finished.onerror = null;
        if (terminate) finished.terminate(); this.#jobs.delete(finished); signal?.removeEventListener('abort', abort);
      };
      const abort = () => { done(); reject(new DOMException('Cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => { done(); reject(new Error(event.message)); };
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.progress) { onProgress?.(data.progress); return; }
        // A final reply is followed by self.close() in the worker. Avoid racing
        // that graceful shutdown with a second, forced termination.
        done(false);
        if (data.error) reject(Object.assign(new Error(data.error), { code: data.code }));
        else resolve(data.result);
      };
      try { worker.postMessage({ tool, args, files, outputs, stdin, ...(wasmModule ? { wasmModule } : {}) }); }
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
import '../shared/worker-host.mjs';
