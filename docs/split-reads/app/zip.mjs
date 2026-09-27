// Dependency-free ZIP STORE writer. Streaming Blob parts avoid a second full
// archive-sized byte array. ZIP64 is intentionally not emitted.
const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
export function updateCrc32(crc, bytes) { for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
async function crc32(blob) {
  let crc = 0xffffffff;
  for await (const bytes of blob.stream()) crc = updateCrc32(crc, bytes);
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length) { const bytes = new Uint8Array(length); return { bytes, view: new DataView(bytes.buffer) }; }
export async function makeZip(files) {
  if (files.length > 65535) throw new Error('ZIP のファイル数上限を超えています。');
  const chunks = [], directory = []; let offset = 0, centralSize = 0;
  for (const { name, blob } of files) {
    const filename = encoder.encode(name), crc = await crc32(blob);
    if (filename.length > 65535) throw new Error('ZIP のファイル名が長すぎます。');
    if (blob.size > 0xffffffff || offset + blob.size + filename.length + 30 > 0xffffffff) throw new Error('ZIP は4 GiB未満に対応します。個別のファイルを保存してください。');
    const local = header(30), central = header(46);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true);
    local.view.setUint16(12, 0x21, true); local.view.setUint32(14, crc, true); local.view.setUint32(18, blob.size, true); local.view.setUint32(22, blob.size, true); local.view.setUint16(26, filename.length, true);
    central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true); central.view.setUint16(8, 0x800, true);
    central.view.setUint16(14, 0x21, true); central.view.setUint32(16, crc, true); central.view.setUint32(20, blob.size, true); central.view.setUint32(24, blob.size, true); central.view.setUint16(28, filename.length, true); central.view.setUint32(42, offset, true);
    chunks.push(local.bytes, filename, blob); directory.push(central.bytes, filename);
    offset += 30 + filename.length + blob.size; centralSize += 46 + filename.length;
  }
  if (offset + centralSize + 22 > 0xffffffff) throw new Error('ZIP の4 GiB上限を超えています。');
  const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true); end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end.bytes], { type: 'application/zip' });
}
