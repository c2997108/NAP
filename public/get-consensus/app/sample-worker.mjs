import { ConsensusPipeline } from './pipeline.mjs';
import { isMemoryAllocationError } from './memory.mjs';
import { outputTransfers } from '../../shared/output-blob.mjs';

self.onmessage = async ({ data }) => {
  try {
    const pipeline = new ConsensusPipeline();
    const progress = value => self.postMessage({ progress: value });
    const result = data.kind === 'analysis'
      ? await pipeline.analyseSample(data.job, data.options, undefined, progress)
      : await pipeline.searchSample(data.job, data.options, undefined, progress);
    self.postMessage({ result }, outputTransfers(result.local.files));
  } catch (error) {
    self.postMessage({ error: { message: error.message, name: error.name, ...(isMemoryAllocationError(error) ? { code: 'WASM_MEMORY' } : {}) } });
  } finally { self.close(); }
};
