import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { runSingleFileBatches } from '../public/split-reads/app/demultiplex-batch-pool.mjs';
const text=Array.from({length:103},(_,i)=>`@read${i%4} qs:f:${i%10}\nACGTACGT\n+\nIIIIIIII\n`).join('');
const environment={hardwareConcurrency:8,deviceMemory:32},options={parallelMode:'manual',concurrency:3,batchSize:10};
function slots({failure=false,permanent=false}={}) {
  let created=0,disposed=0,active=0,peak=0,failed=false;
  const attempts=[];
  return {get state(){return {created,disposed,active,peak,attempts};},createSlot:()=>{
    created++;const slotIndex=created;let rejectRunning;
    return {initialize:async()=>{await setTimeout(slotIndex===1?20:1);},dispose:()=>{disposed++;rejectRunning?.(Error('Disposed'));},run:async(file,notify)=>{
      const contents=await file.text(),count=contents.trimEnd().split('\n').length/4;attempts.push(file.name);
      active++;peak=Math.max(peak,active);
      notify({inputReads:count,totalReads:Math.floor(count/2),assignedReads:Math.floor(count/2),segments:Math.floor(count/2)});
      try {
        await new Promise((resolve,reject)=>{rejectRunning=reject;setTimeout(/\.part1\.fq$/.test(file.name)?15:4).then(resolve);});
        if((failure||permanent)&&!failed){failed=true;throw Error(permanent?'Invalid result':'WebAssembly.Memory(): could not allocate memory');}
        notify({totalReads:count,assignedReads:count,segments:count});
        return {contents,summary:{totalReads:count,assignedReads:count,segments:count,batches:1}};
      } finally {active--;rejectRunning=null;}
    }};
  }};
}
test('one FASTQ streams bounded batches into parallel slots, preserving names, qualities, order and read-based progress',async()=>{
  const tools=slots(),progress=[];
  const result=await runSingleFileBatches({file:new File([text],'one.fq'),options,environment,createSlot:tools.createSlot,onProgress:p=>progress.push(p)});
  assert.equal(result.results.map(r=>r.contents).join(''),text);
  assert.equal(tools.state.peak,3);assert.equal(tools.state.created,3);assert.equal(tools.state.disposed,3);
  assert.equal(result.execution.batchCount,11);assert.equal(result.execution.maxActiveBatches,3);assert.equal(result.execution.maxActiveFiles,1);
  assert.equal(result.execution.completedFiles,1);assert.equal(result.execution.files.length,1);
  assert.ok(result.execution.maxBufferedReads<=30);assert.ok(result.execution.maxBufferedReads>=10);
  assert.equal(result.execution.maxReadLength,8);assert.equal(progress.at(-1).fraction,1);
  assert.ok(progress.every(p=>p.fileCount===1&&p.files.length===1));
  assert.ok(progress.filter(p=>p.phase==='counting').every(p=>p.fraction===0));
  assert.ok(progress.some(p=>p.activeBatches===3&&p.totalReads===0),'Starting jobs alone must not advance progress');
  assert.ok(progress.some(p=>p.totalReads>0&&p.fraction>0&&p.fraction<1));
  assert.ok(progress.every((p,i)=>!i||p.fraction>=progress[i-1].fraction));
});
test('concatenated gzip is counted and streamed once into the same ordered batch outputs',async()=>{
  const gz=Buffer.concat([gzipSync(text.slice(0,127)),gzipSync(text.slice(127))]);
  const tools=slots(),result=await runSingleFileBatches({file:new File([gz],'one.fq.gz'),options,environment,createSlot:tools.createSlot});
  assert.equal(result.results.map(r=>r.contents).join(''),text);
  assert.equal(result.execution.files[0].totalReads,103);assert.equal(result.execution.files[0].consumed,gz.length);
  assert.ok(result.execution.maxBufferedReads<=30);
});
test('batch allocation retry keeps its input and output position, reduces parallelism and releases every slot',async()=>{
  const tools=slots({failure:true}),progress=[];
  const result=await runSingleFileBatches({file:new File([text],'one.fq'),options:{...options,concurrency:4},environment,createSlot:tools.createSlot,retryDelay:0,onProgress:p=>progress.push(p)});
  assert.equal(result.results.map(r=>r.contents).join(''),text);
  assert.equal(result.execution.concurrency,2);assert.equal(result.execution.memoryRetries,1);
  assert.equal(tools.state.attempts.length,12);assert.equal(tools.state.created,tools.state.disposed);
  assert.ok(result.execution.maxBufferedReads<=40);assert.ok(progress.every((p,i)=>!i||p.fraction>=progress[i-1].fraction));
});
test('permanent batch failure drains peers and closes all slots; invalid or empty FASTQ launches no slots',async()=>{
  const tools=slots({permanent:true});
  await assert.rejects(runSingleFileBatches({file:new File([text],'one.fq'),options,environment,createSlot:tools.createSlot}),/Invalid result/);
  assert.equal(tools.state.active,0);assert.equal(tools.state.created,tools.state.disposed);
  for(const contents of ['',text+'@truncated\nACGT\n+\n']) {
    const unused=slots();await assert.rejects(runSingleFileBatches({file:new File([contents],'bad.fq'),options,environment,createSlot:unused.createSlot}));assert.equal(unused.state.created,0);
  }
});
test('a single small batch or a memory-limited device stays within the usable parallel budget',async()=>{
  const tools=slots(),result=await runSingleFileBatches({file:new File([text],'one.fq'),options:{...options,parallelMode:'auto',batchSize:300},environment,createSlot:tools.createSlot});
  assert.equal(result.execution.requested,8);assert.equal(result.execution.concurrency,1);assert.equal(result.execution.batchCount,1);
  const limited=slots(),budget=await runSingleFileBatches({file:new File([text],'one.fq'),options:{...options,parallelMode:'auto'},environment:{hardwareConcurrency:20,deviceMemory:1},createSlot:limited.createSlot});
  assert.equal(budget.execution.concurrency,1);assert.equal(limited.state.peak,1);
});
