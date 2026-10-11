const encoder = new TextEncoder();
const transport = () => typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;

// Blob construction can outlive a terminated worker in Chromium and retain
// its entire heap. Workers keep immutable byte parts and transfer ownership;
// the page constructs the downloadable Blob after receiving the result.
export function outputBlob(parts, options = {}) {
  if (!transport()) return new Blob(parts.map(asBlob), options);
  const bytes = [];
  for (const part of parts) {
    if (part?.napOutput === 'byte-parts') bytes.push(...part.parts);
    else if (part instanceof Blob) bytes.push(part); // Existing input Blob from the page.
    else if (ArrayBuffer.isView(part)) bytes.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength).slice());
    else if (part instanceof ArrayBuffer) bytes.push(new Uint8Array(part).slice());
    else bytes.push(encoder.encode(String(part)));
  }
  return { napOutput: 'byte-parts', parts: bytes, size: bytes.reduce((n, part) => n + (part.size ?? part.byteLength), 0), type: options.type || '' };
}

export function asBlob(file) {
  return file?.napOutput === 'byte-parts' ? new Blob(file.parts, { type: file.type }) : file;
}

export function outputBlobs(files) {
  return new Map([...files].map(([name, file]) => [name, asBlob(file)]));
}

export function outputTransfers(files, ...extra) {
  const values = files instanceof Map ? files.values() : files.map(file => file.blob);
  return byteTransfers([...values, ...extra].flatMap(file => file?.napOutput === 'byte-parts' ? file.parts : []));
}

export function byteTransfers(parts) {
  // Several outputs may share the same part; a buffer must be transferred once.
  return [...new Set(parts.map(part => ArrayBuffer.isView(part) ? part.buffer : part).filter(buffer => buffer instanceof ArrayBuffer))];
}

export function receivedOutputBlobs(files) { return transport() ? files : outputBlobs(files); }

export async function* outputChunks(file) {
  if (file?.napOutput !== 'byte-parts') { yield* file.stream(); return; }
  for (const part of file.parts) {
    if (part instanceof Blob) yield* part.stream();
    else yield part;
  }
}
