// Tool stdout can contain large SAM/pileup files. A number[] costs several
// times as much as the actual bytes; fixed byte chunks keep that overhead bounded.
export class ByteOutput {
  constructor(size = 65536) { this.size = size; this.chunks = []; this.current = new Uint8Array(size); this.used = 0; }
  push(byte) {
    this.current[this.used++] = byte;
    if (this.used === this.size) { this.chunks.push(this.current); this.current = new Uint8Array(this.size); this.used = 0; }
  }
  write(bytes) {
    for (let at = 0; at < bytes.length;) {
      const length = Math.min(this.size - this.used, bytes.length - at);
      this.current.set(bytes.subarray(at, at + length), this.used); this.used += length; at += length;
      if (this.used === this.size) { this.chunks.push(this.current); this.current = new Uint8Array(this.size); this.used = 0; }
    }
  }
  text() {
    const decoder = new TextDecoder();
    const parts = this.chunks.map(chunk => decoder.decode(chunk, { stream: true }));
    parts.push(decoder.decode(this.current.subarray(0, this.used)));
    return parts.join('');
  }
}
