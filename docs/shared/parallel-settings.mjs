const MiB = 1024 * 1024;

export function cpuParallelism(options, environment = globalThis.navigator || {}) {
  const hasCores = Number.isFinite(environment.hardwareConcurrency) && environment.hardwareConcurrency > 0;
  const cores = hasCores ? Math.max(1, Math.floor(environment.hardwareConcurrency)) : 2;
  const parallelMode = options.parallelMode === 'manual' ? 'manual' : 'auto';
  return { cores, parallelMode, requested: parallelMode === 'manual' ? options.parallelQueries : cores,
    processorSource: hasCores ? 'device' : 'fallback' };
}

export function memoryBudget(options = {}, environment = globalThis.navigator || {}) {
  // The browser exposes approximate total RAM, not available RAM.
  const deviceMemoryGB = Number.isFinite(environment.deviceMemory) && environment.deviceMemory > 0 ? environment.deviceMemory : null;
  const automaticBudgetMB = deviceMemoryGB === null ? 512 : Math.max(1, Math.floor(deviceMemoryGB * 256));
  const mode = options.memoryMode === 'manual' ? 'manual' : 'auto';
  return { mode, budgetMB: mode === 'manual' ? options.memoryBudgetMB : automaticBudgetMB,
    automaticBudgetMB, deviceMemoryGB, source: mode === 'manual' ? 'manual' : deviceMemoryGB === null ? 'fallback' : 'device' };
}

export function fileParallelPlan({ parallelMode, parallelCount }, files, { readsInMemory = false, referenceBytes = 0, jobs = files.length, workingBytes = 0, retainedBytes = 0 } = {}, environment = globalThis.navigator || {}) {
  const cpu = cpuParallelism({ parallelMode, parallelQueries: parallelCount }, environment);
  const memory = memoryBudget({}, environment);
  // Consensus holds one complete sample in JS and native memory; gzip's size
  // needs an allowance for expansion. Split streams batches instead. These
  // estimates guide scheduling; allocation failures still trigger a retry.
  const largestInput = readsInMemory ? files.reduce((largest, file) => Math.max(largest, file.size * (/\.gz$/i.test(file.name) ? 32 : 8)), 0) : 0;
  retainedBytes = Math.max(0, Number(retainedBytes) || 0);
  const reservedBytes = 64 * MiB + referenceBytes + retainedBytes + files.reduce((sum, file) => sum + file.size, 0);
  const workerBytes = 192 * MiB + referenceBytes * 3 + largestInput + workingBytes;
  const memoryLimit = Math.max(1, Math.floor((memory.budgetMB * MiB - reservedBytes) / workerBytes));
  return { ...cpu, limit: Math.max(1, Math.min(cpu.requested, cpu.cores, memoryLimit, jobs || 1)),
    memoryLimit, memoryBudgetMB: memory.budgetMB, budgetSource: memory.source, deviceMemoryGB: memory.deviceMemoryGB,
    retainedResultMB: Math.ceil(retainedBytes / MiB), estimatedWorkerMB: Math.ceil(workerBytes / MiB), reservedMB: Math.ceil(reservedBytes / MiB) };
}

export function bindCpuParallelism({ mode, input, hint, manualDefault = 8 }, environment = globalThis.navigator || {}) {
  let manualValue = String(manualDefault);
  const refresh = () => {
    const cpu = cpuParallelism({ parallelMode: mode.value, parallelQueries: Number(manualValue) }, environment);
    input.readOnly = cpu.parallelMode === 'auto';
    input.value = input.readOnly ? String(cpu.cores) : manualValue;
    hint.textContent = cpu.processorSource === 'device'
      ? `CPU ${cpu.cores} 論理コア。実際の同時処理数はジョブ数と推定メモリー量で調整します。`
      : 'CPU情報を取得できないため2を使用します。実際の同時処理数はジョブ数と推定メモリー量で調整します。';
  };
  input.addEventListener('input', () => { if (mode.value === 'manual') manualValue = input.value; });
  mode.addEventListener('change', refresh);
  refresh();
}
