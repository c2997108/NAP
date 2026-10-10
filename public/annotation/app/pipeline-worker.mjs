import { runAnnotation } from './pipeline.mjs';
import { isMemoryAllocationError } from '../../get-consensus/app/memory.mjs';
let controller;
self.onmessage = async ({ data }) => {
  if (data.cancel) { controller?.abort(); return; }
  controller = new AbortController();
  try { self.postMessage({ result: await runAnnotation(data, { signal: controller.signal, onProgress: progress => self.postMessage({ progress }) }) }); }
  catch (error) { self.postMessage({ error: { name: error.name, message: isMemoryAllocationError(error) ? '解析用メモリーを確保できませんでした。1グループの最大配列数や参照FASTAの分割サイズを小さくするか、ほかの解析を終了してください。' : error.message, stack: error.stack } }); }
  finally { self.close(); }
};
