import { ConsensusPipeline } from './pipeline.mjs';
import { isMemoryAllocationError, memoryError, errorDetails } from './memory.mjs';
import { outputTransfers } from '../../shared/output-blob.mjs';
let controller;
self.onmessage=async({data})=>{
  if(data.cancel) {controller?.abort();return;}
  controller=new AbortController();
  let pending,timer,last=0;
  const flush=()=>{clearTimeout(timer);timer=undefined;if(pending){self.postMessage({progress:pending});pending=undefined;last=performance.now();}};
  // Hundreds of samples otherwise send a full progress table on every native
  // stage. Coalesce screen updates; complete command logs remain in pipeline.log.
  const progress=value=>{pending=value;if(performance.now()-last>=60 || value.message?.includes('メモリー不足'))flush();else if(!timer)timer=setTimeout(flush,60-(performance.now()-last));};
  try {
    const result=await new ConsensusPipeline({onProgress:progress}).run(data.files,data.options,controller.signal,data.memoryContext);
    flush();
    self.postMessage({result},outputTransfers(result.files));
  } catch(error) {flush();if(isMemoryAllocationError(error) && error.name!=='MemoryAllocationError')error=memoryError(error);self.postMessage({error:{message:error.message,stack:error.stack,name:error.name,details:errorDetails(error)}});}
  finally{clearTimeout(timer);self.close();}
};
