import { makeZipInWorker } from '../../shared/zip-client.mjs';
import { SPLIT_RESULT_PAGE, splitFastqArchiveFiles } from './result-page.mjs';
import { asBlob } from '../../shared/output-blob.mjs';

export class DemultiplexClient {
  constructor({ onProgress = () => {}, onLog = () => {} } = {}) {
    this.onProgress = onProgress; this.onLog = onLog;
    this.files = new Map(); this.worker = null; this.archive = null;
  }
  run(payload) {
    if (this.worker || this.archive) return Promise.reject(new Error('すでに処理中です。'));
    this.files.clear(); this.fastqReport = null;
    const worker = new Worker(new URL('./demultiplex-worker.mjs', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (terminate = true) => {
        settled = true; worker.onmessage = worker.onerror = null;
        if (terminate) worker.terminate();
        this.worker = null; this.abortRun = null;
      };
      this.abortRun = () => { done(); reject(new Error('処理を中止しました。')); };
      worker.onerror = event => { done(); reject(new Error(event.message || 'Worker error')); };
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'progress') { this.onProgress(data); return; }
        if (data.type === 'log') { this.onLog(data.text); return; }
        done(false); // The coordinator closes itself after replying.
        if (data.error) { reject(new Error(data.error)); return; }
        const { summary, files, fastqReport } = data.result;
        this.files = new Map(files.map(({ name, blob }) => [name, asBlob(blob)]));
        this.fastqReport = asBlob(fastqReport);
        resolve({ summary, files: files.map(({ name, blob }) => ({ name, size: blob.size })) });
      };
      try { worker.postMessage({ id: 1, type: 'run', payload }); }
      catch (error) { done(); reject(error); }
    });
  }
  async readFile(name) {
    const blob = this.files.get(name);
    if (!blob) throw new Error(`出力がありません: ${name}`);
    return blob;
  }
  async zip({ fastqOnly = false } = {}) {
    if (this.worker || this.archive) throw new Error('すでに処理中です。');
    if (!this.files.size) throw new Error('出力がありません。');
    const files = [...this.files].map(([name, blob]) => ({ name, blob }));
    if (fastqOnly && !files.some(file => file.name.startsWith('output/') && file.name.endsWith('.fq'))) throw new Error('分割された FASTQ がありません。');
    const selected = fastqOnly ? [...splitFastqArchiveFiles(files), { name: SPLIT_RESULT_PAGE, blob: this.fastqReport }] : files;
    const controller = new AbortController(); this.archive = controller;
    try { return await makeZipInWorker(selected, { signal: controller.signal }); }
    finally { if (this.archive === controller) this.archive = null; }
  }
  cancel() { this.dispose(); }
  dispose() {
    this.abortRun?.(); this.archive?.abort(); this.archive = null;
    this.files.clear(); this.fastqReport = null;
  }
}
import '../../shared/worker-host.mjs';
