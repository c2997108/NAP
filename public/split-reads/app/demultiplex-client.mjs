export class DemultiplexClient {
  constructor({ onProgress = () => {}, onLog = () => {} } = {}) {
    this.onProgress = onProgress; this.onLog = onLog; this.nextId = 1; this.pending = new Map(); this.createWorker();
  }
  createWorker() {
    this.worker = new Worker(new URL('./demultiplex-worker.mjs', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { this.onProgress(data); return; }
      if (data.type === 'log') { this.onLog(data.text); return; }
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
    };
    this.worker.onerror = event => { for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'Worker error')); this.pending.clear(); };
  }
  request(type, payload = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, type, payload }); });
  }
  run(payload) { return this.request('run', payload); }
  readFile(name) { return this.request('file', { name }); }
  zip({ fastqOnly = false } = {}) { return this.request('zip', { fastqOnly }); }
  cancel() { this.dispose(); this.createWorker(); }
  dispose() { this.worker.terminate(); for (const pending of this.pending.values()) pending.reject(new Error('処理を中止しました。')); this.pending.clear(); }
}
