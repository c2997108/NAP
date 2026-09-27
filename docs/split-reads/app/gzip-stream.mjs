import { Gunzip } from '../vendor/fflate.mjs';
import { updateCrc32 } from './zip.mjs';

// Chrome's DecompressionStream rejects concatenated gzip members. fflate's
// streaming Gunzip supports them; check each member's CRC and ISIZE ourselves.
export function gzipTransform(file) {
  let inflater, crc = 0xffffffff, length = 0, checks = [];
  async function validate(end, checksum, size) {
    const bytes = await file.slice(end - 8, end).arrayBuffer();
    if (bytes.byteLength !== 8) throw new Error(`${file.name || 'gzip'}: gzip の末尾が不完全です。`);
    const trailer = new DataView(bytes);
    if (trailer.getUint32(0, true) !== checksum || trailer.getUint32(4, true) !== size) throw new Error(`${file.name || 'gzip'}: gzip の CRC または展開サイズが一致しません。`);
  }
  return new TransformStream({
    start(controller) {
      inflater = new Gunzip((data) => {
        crc = updateCrc32(crc, data); length = (length + data.length) >>> 0;
        if (data.length) controller.enqueue(data);
      });
      inflater.onmember = offset => {
        checks.push([offset, (crc ^ 0xffffffff) >>> 0, length]);
        crc = 0xffffffff; length = 0;
      };
    },
    async transform(chunk) { inflater.push(chunk, false); await Promise.all(checks.map(check => validate(...check))); checks = []; },
    async flush() {
      inflater.push(new Uint8Array(), true);
      await Promise.all([...checks.map(check => validate(...check)), validate(file.size, (crc ^ 0xffffffff) >>> 0, length)]);
    }
  });
}
