// Keep all calculation workers owned by the page. Closing a worker that owns
// other workers can strand their contexts in Chromium; sibling workers can be
// disposed independently, including on failure or cancellation.
const inWorker = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
const oneShot = url => /\/(pipeline-worker|demultiplex-worker|sample-worker|tool-worker|zip-worker)\.mjs$/.test(new URL(url, import.meta.url).pathname);

function transfers(data, buffers = new Set(), seen = new Set()) {
  if (!data || typeof data !== 'object' || seen.has(data)) return [...buffers];
  seen.add(data);
  if (data instanceof ArrayBuffer) buffers.add(data);
  else if (ArrayBuffer.isView(data)) { if (data.buffer instanceof ArrayBuffer) buffers.add(data.buffer); }
  else if (data instanceof Map) for (const [key, value] of data) { transfers(key, buffers, seen); transfers(value, buffers, seen); }
  else if (Array.isArray(data)) for (const value of data) transfers(value, buffers, seen);
  else if (!(data instanceof Blob)) for (const value of Object.values(data)) transfers(value, buffers, seen);
  return [...buffers];
}

if (inWorker) {
  let host;
  const queued = [];
  self.addEventListener('message', event => {
    if (!event.data?.napWorkerHost) return;
    event.stopImmediatePropagation();
    host = event.data.napWorkerHost;
    for (const [message, transfer] of queued.splice(0)) host.postMessage(message, transfer);
  });
  const spawn = (message, transfer) => host ? host.postMessage(message, transfer) : queued.push([message, transfer]);
  globalThis.Worker = class extends EventTarget {
    constructor(url, options = {}) {
      super();
      const channel = new MessageChannel(); this.port = channel.port1;
      this.port.onmessage = ({ data }) => {
        if (this.stopped) return;
        const event = data.type === 'message' ? new MessageEvent('message', { data: data.data }) : new ErrorEvent('error', { message: data.message });
        this.dispatchEvent(event);
        if (!this.stopped) (data.type === 'message' ? this.onmessage : this.onerror)?.(event);
      };
      spawn({ url: String(url), options, port: channel.port2 }, [channel.port2]);
    }
    postMessage(data, transfer = []) { if (!this.stopped) this.port.postMessage({ type: 'post', data }, transfer); }
    terminate() {
      if (this.stopped) return;
      this.stopped = true; this.onmessage = this.onerror = null;
      this.port.postMessage({ type: 'terminate' }); this.port.close();
    }
  };
} else if (typeof window !== 'undefined') {
  const NativeWorker = globalThis.Worker, workers = new Set();
  function forget(record, force = false) {
    if (!workers.delete(record)) return;
    for (const child of [...workers]) if (child.parent === record) forget(child, true);
    record.worker.removeEventListener('message', record.message);
    record.worker.removeEventListener('error', record.error);
    record.host.close(); record.port?.close();
    if (force) NativeWorker.prototype.terminate.call(record.worker);
  }
  function own(worker, url, parent, port) {
    const channel = new MessageChannel(), record = { worker, parent, port, host: channel.port1 };
    workers.add(record);
    record.host.onmessage = ({ data }) => {
      try { own(new NativeWorker(data.url, data.options), data.url, record, data.port); }
      catch (error) { data.port.postMessage({ type: 'error', message: error.message }); data.port.close(); }
    };
    record.message = ({ data }) => {
      port?.postMessage({ type: 'message', data }, transfers(data));
      if ((oneShot(url) && (data.result || data.error)) || data.type === 'disposed') forget(record);
    };
    record.error = event => {
      port?.postMessage({ type: 'error', message: event.message || 'Worker error' });
      forget(record, true);
    };
    worker.addEventListener('message', record.message);
    worker.addEventListener('error', record.error);
    if (port) {
      port.onmessage = ({ data }) => {
        if (data.type === 'terminate') forget(record, true);
        else if (data.type === 'post') {
          try { worker.postMessage(data.data, transfers(data.data)); }
          catch (error) { port.postMessage({ type: 'error', message: error.message }); forget(record, true); }
        }
      };
    }
    if (oneShot(url) || /\/demultiplex-file-worker\.mjs$/.test(new URL(url, import.meta.url).pathname))
      worker.postMessage({ napWorkerHost: channel.port2 }, [channel.port2]);
    else channel.port2.close();
    return record;
  }
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) { super(url, options); this.record = own(this, String(url)); }
    terminate() { forget(this.record, true); }
  };
}
