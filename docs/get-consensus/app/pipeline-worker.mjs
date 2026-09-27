import { ConsensusPipeline } from './pipeline.mjs';
let controller;
self.onmessage=async({data})=>{
  if(data.cancel) {controller?.abort();return;}
  controller=new AbortController();
  try {
    const result=await new ConsensusPipeline({onProgress:progress=>self.postMessage({progress})}).run(data.files,data.options,controller.signal);
    self.postMessage({result});
  } catch(error) {self.postMessage({error:{message:error.message,stack:error.stack,name:error.name}});}
};
