export class BlastClient {
  constructor({ onLog = () => {}, workerUrl = new URL('./blast-worker.mjs', import.meta.url) } = {}) {
    this.workerUrl = workerUrl;
    this.onLog = onLog;
    this.pending = new Map();
    this.nextId = 1;
    this.createWorker();
  }
  createWorker() {
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'log') { this.onLog(data); return; }
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = event => {
      for (const request of this.pending.values()) request.reject(new Error(event.message || 'Worker の実行に失敗しました。'));
      this.pending.clear();
    };
  }
  request(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('Worker は終了しています。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, type, ...payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  writeFile(name, data) { return this.request('writeFile', { name, data }); }
  readFile(name, { encoding = 'utf8' } = {}) { return this.request('readFile', { name, encoding }); }
  listFiles() { return this.request('listFiles'); }
  run(command, args = []) { return this.request('run', { command, args }); }
  removeFile(name) { return this.request('removeFile', { name }); }
  reset() {
    this.release('処理を中止し、作業領域をリセットしました。');
    this.createWorker();
  }
  dispose() {
    this.release('Worker を終了しました。');
  }
  release(message) {
    const worker = this.worker; this.worker = null;
    if (worker) { worker.onmessage = worker.onerror = null; worker.terminate(); }
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }
}
import '../../shared/worker-host.mjs';
