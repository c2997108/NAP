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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  writeFile(name, data) { return this.request('writeFile', { name, data }); }
  readFile(name, { encoding = 'utf8' } = {}) { return this.request('readFile', { name, encoding }); }
  listFiles() { return this.request('listFiles'); }
  run(command, args = []) { return this.request('run', { command, args }); }
  removeFile(name) { return this.request('removeFile', { name }); }
  reset() {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error('処理を中止し、作業領域をリセットしました。'));
    this.pending.clear();
    this.createWorker();
  }
  dispose() {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error('Worker を終了しました。'));
    this.pending.clear();
  }
}
