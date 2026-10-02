import { runAnnotation } from './pipeline.mjs';
import { isMemoryAllocationError } from '../../get-consensus/app/memory.mjs';
let controller;
self.onmessage = async ({ data }) => {
  if (data.cancel) { controller?.abort(); return; }
  controller = new AbortController();
  try { self.postMessage({ result: await runAnnotation(data, { signal: controller.signal, onProgress: progress => self.postMessage({ progress }) }) }); }
  catch (error) { self.postMessage({ error: { name: error.name, message: isMemoryAllocationError(error) ? '参照DBの読み込みに必要なメモリーを確保できませんでした。ほかの解析を終了するか、参照FASTAを指定して分割サイズを小さくしてください。' : error.message, stack: error.stack } }); }
  finally { self.close(); }
};
