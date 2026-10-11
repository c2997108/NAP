// Report linear-memory capacity without copying buffers or retaining runtimes.
// This is the space available to active WASM commands, not physical RAM usage.
export function createWasmMemoryTracker(environment, publish) {
  const ids = new WeakMap(), active = new Map();
  let nextId = 0;
  const report = () => {
    try { publish({ bytes: [...active.values()].reduce((sum, item) => sum + item.bytes, 0), instances: active.size }); }
    catch { /* Monitoring must never interrupt a calculation. */ }
  };
  const prototype = environment.WebAssembly.Memory.prototype, grow = prototype.grow;
  prototype.grow = function (...args) {
    const id = ids.get(this.buffer), result = grow.apply(this, args);
    if (active.has(id)) {
      ids.set(this.buffer, id); active.get(id).bytes = this.buffer.byteLength; report();
    }
    return result;
  };
  return buffer => {
    if (!buffer || !Number.isFinite(buffer.byteLength)) return () => {};
    let id = ids.get(buffer);
    if (!active.has(id)) { id = ++nextId; ids.set(buffer, id); active.set(id, { bytes: buffer.byteLength, references: 0 }); }
    active.get(id).references++; report();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--active.get(id).references === 0) active.delete(id);
      report();
    };
  };
}

const inWorker = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
export const trackWasmMemory = inWorker
  ? createWasmMemoryTracker(globalThis, snapshot => self.postMessage({ napWasmMemory: snapshot }))
  : () => () => {};
