/** Bounded sample jobs, ordered results, and cancellation of peers on failure. */
export async function mapParallel(items,limit,task,{signal,onState=()=>{}}={}) {
  if(!Number.isInteger(limit) || limit<1) throw new Error('Parallel limit must be a positive integer.');
  signal?.throwIfAborted();
  const controller=new AbortController(),active=new Set(),results=new Array(items.length);
  const abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  let next=0,completed=0,failed=false,failure;
  const report=()=>onState({active:[...active],completed,total:items.length,limit:Math.min(limit,items.length)});
  const consume=async()=>{
    while(!controller.signal.aborted && next<items.length) {
      const index=next++;
      try {
        active.add(index);report();
        results[index]=await task(items[index],index,controller.signal);
        completed++;active.delete(index);
        if(!controller.signal.aborted) report();
      } catch(error) {
        active.delete(index);
        if(!failed) {failed=true;failure=error;controller.abort(error);}
      }
    }
  };
  try {
    await Promise.all(Array.from({length:Math.min(limit,items.length)},consume));
    if(failed) throw failure;
    controller.signal.throwIfAborted();
    return results;
  } finally {signal?.removeEventListener('abort',abort);}
}
