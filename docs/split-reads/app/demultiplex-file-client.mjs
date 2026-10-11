export class FileProcessingSlot {
  constructor(configuration, onLog = () => {}) {
    this.configuration = configuration; this.pending = new Map(); this.nextId = 1;
    this.worker = new Worker(new URL('./demultiplex-file-worker.mjs', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { this.onProgress?.(data); return; }
      if (data.type === 'log') { onLog(this.fileName ? `[${this.fileName}] ${data.text}` : data.text); return; }
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
    };
    this.worker.onerror = event => { for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'ファイル Worker エラー')); this.pending.clear(); };
  }
  request(type, payload = {}) {
    if (this.disposed) return Promise.reject(new Error('ファイル処理を中止しました。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  initialize() { return this.request('initialize', this.configuration); }
  run(file, onProgress) { this.fileName = file.name; this.onProgress = onProgress; return this.request('run', { file }); }
  dispose() {
    if (this.closing) return this.closing;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('ファイル処理を中止しました。'));
    this.pending.clear();
    // Let the file worker explicitly terminate its BLAST child before ending
    // the parent. A timeout still closes a crashed/unresponsive file worker.
    this.closing = new Promise(resolve => {
      const finish = (terminate = true) => {
        const worker = this.worker; this.worker = null;
        clearTimeout(timer);
        if (worker) { worker.onmessage = worker.onerror = null; if (terminate) worker.terminate(); }
        this.configuration = this.onProgress = null; resolve();
      };
      const timer = setTimeout(finish, 1000);
      this.worker.onmessage = ({ data }) => { if (data.type === 'disposed') finish(false); };
      this.worker.onerror = finish;
      try { this.worker.postMessage({ type: 'dispose' }); } catch { finish(); }
    });
    return this.closing;
  }
}
