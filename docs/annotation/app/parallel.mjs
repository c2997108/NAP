import { cpuParallelism, memoryBudget } from '../../shared/parallel-settings.mjs';
export { cpuParallelism, memoryBudget } from '../../shared/parallel-settings.mjs';
const MiB = 1024 * 1024;

export function queryGroups(rows, batchSize, parallelQueries) {
  const size = Math.min(batchSize, Math.max(1, Math.ceil(rows.length / parallelQueries)));
  const groups = [];
  for (let start = 0; start < rows.length; start += size) {
    const end = Math.min(rows.length, start + size), records = rows.slice(start, end);
    groups.push({ start, end, count: records.length, bases: records.reduce((sum, row) => sum + row.seq.length, 0),
      query: records.map((row, index) => `>q${start + index}\n${row.seq}\n`).join('') });
  }
  return groups;
}

export function parallelPlan(options, { referenceBytes = 0, inputBytes = 0, maxQueryBases = 0, groups = 1 } = {}, environment = globalThis.navigator || {}) {
  const cpu = cpuParallelism(options, environment);
  const memory = memoryBudget(options, environment);
  const reservedBytes = 64 * MiB + inputBytes * 8 + referenceBytes;
  // BLAST starts with a 64 MiB heap. Allow workspace/JS overhead plus private
  // MEMFS copies and heap growth; this is an estimate, not a hard RAM ceiling.
  const workerBytes = 192 * MiB + referenceBytes * 3 + maxQueryBases * 24;
  const memoryLimit = Math.max(1, Math.floor((memory.budgetMB * MiB - reservedBytes) / workerBytes));
  return { ...memory, ...cpu, limit: Math.max(1, Math.min(cpu.requested, cpu.cores, memoryLimit, groups)),
    estimatedWorkerMB: Math.ceil(workerBytes / MiB), reservedMB: Math.ceil(reservedBytes / MiB) };
}

export function sharedReference(files) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return { files, shared: false };
  for (const [name, bytes] of Object.entries(files)) {
    const view = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    view.set(bytes); files[name] = view;
  }
  return { files, shared: true };
}
