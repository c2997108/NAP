export function resultBytes(files = []) {
  const values = files instanceof Map ? files.values() : files;
  let bytes = 0;
  for (const file of values) bytes += Math.max(0, Number(file.blob?.size ?? file.size) || 0);
  return bytes;
}

// Standalone pages have no other stages. In NAP's same-origin frames, reserve
// space for results kept by the other pages before planning calculation jobs.
export function retainedResultBytes(stage, environment = globalThis.window) {
  try { return Math.max(0, Number(environment?.parent?.nap?.retainedResultBytes(stage)) || 0); }
  catch { return 0; }
}
