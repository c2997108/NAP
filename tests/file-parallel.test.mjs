import test from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { fileParallelPlan } from '../public/shared/parallel-settings.mjs';
import { validateOptions as splitOptions } from '../public/split-reads/app/demultiplex-core.mjs';
import { validateOptions as consensusOptions } from '../public/get-consensus/app/pipeline.mjs';
import { runFilePool } from '../public/split-reads/app/demultiplex-file-pool.mjs';
setMaxListeners(32); // Twenty legitimate file jobs listen to the shared abort signal.
const MiB=1024*1024,env={hardwareConcurrency:20,deviceMemory:32};
const files=Array.from({length:24},(_,index)=>({name:`${index}.fq`,size:1024}));

test('both stages default to automatic CPU counts; explicit numeric API settings remain manual',()=>{
  for(const [validate,key] of [[splitOptions,'concurrency'],[consensusOptions,'parallelSamples']]) {
    assert.equal(validate().parallelMode,'auto');assert.equal(validate({[key]:1}).parallelMode,'manual');
    assert.equal(validate({parallelMode:'auto',[key]:8}).parallelMode,'auto');
    assert.equal(validate({[key]:24})[key],24);
    assert.throws(()=>validate({[key]:Infinity}));assert.throws(()=>validate({parallelMode:'other'}));
  }
});
test('CPU-derived file planning respects file counts, missing hints and large/compressed consensus inputs',()=>{
  const auto={parallelMode:'auto',parallelCount:8};
  const split=fileParallelPlan(auto,files,{},env),consensus=fileParallelPlan(auto,files,{readsInMemory:true},env);
  assert.equal(split.requested,20);assert.equal(split.limit,20);assert.equal(consensus.limit,20);
  assert.equal(fileParallelPlan(auto,files.slice(0,3),{},env).limit,3);
  assert.equal(fileParallelPlan({parallelMode:'manual',parallelCount:1},files,{},env).limit,1);
  assert.equal(fileParallelPlan({parallelMode:'manual',parallelCount:100},files,{},env).limit,20);
  const fallback=fileParallelPlan(auto,files,{},{});assert.equal(fallback.requested,2);assert.equal(fallback.memoryBudgetMB,512);
  const large=files.map(file=>({...file,size:32*MiB}));
  const raw=fileParallelPlan(auto,large,{readsInMemory:true},env);
  const gzip=fileParallelPlan(auto,large.map(file=>({...file,name:file.name+'.gz'})),{readsInMemory:true},env);
  assert.ok(gzip.limit<raw.limit);assert.ok(raw.limit<20);
  assert.equal(fileParallelPlan(auto,large,{},env).limit,20,'Split uses streamed batches rather than whole-file buffers');
  assert.equal(fileParallelPlan(auto,files,{}, {hardwareConcurrency:32,deviceMemory:1}).limit,1);
});
test('split pool runs 20 lanes, reuses slots and returns every file once in input order',async()=>{
  let active=0,peak=0,created=0,disposed=0;
  const result=await runFilePool({files,concurrency:20,createSlot:()=>{
    created++;return {initialize:async()=>{},dispose:()=>{disposed++;},run:async(file,notify)=>{
      active++;peak=Math.max(peak,active);await setTimeout(5);active--;
      notify({inputReads:1,totalReads:1});return {name:file.name,summary:{totalReads:1,assignedReads:1,segments:1,batches:1}};
    }};
  }});
  assert.equal(peak,20);assert.equal(created,20);assert.equal(disposed,created);
  assert.equal(result.execution.maxActiveFiles,20);assert.deepEqual(result.results.map(r=>r.name),files.map(f=>f.name));
});
test('split allocation retry reduces lanes and releases slots without duplicate output or backward progress',async()=>{
  let failed=false,created=0,disposed=0;const attempts=new Map(),progress=[],warnings=[];
  const input=files.slice(0,8);
  const result=await runFilePool({files:input,concurrency:4,retryDelay:0,onProgress:p=>progress.push(p),onMemoryPressure:p=>warnings.push(p),createSlot:()=>{
    created++;return {initialize:async()=>{},dispose:()=>{disposed++;},run:async(file,notify)=>{
      attempts.set(file.name,(attempts.get(file.name)||0)+1);notify({inputReads:4,totalReads:2,assignedReads:2,segments:2});
      await setTimeout(3);
      if(!failed){failed=true;throw new RangeError('WebAssembly.Memory(): could not allocate memory');}
      notify({inputReads:4,totalReads:4});return {name:file.name,summary:{totalReads:4,assignedReads:4,segments:4,batches:2}};
    }};
  }});
  assert.equal(result.execution.concurrency,2);assert.equal(result.execution.memoryRetries,1);
  assert.equal(warnings.length,1);assert.equal(disposed,created);
  assert.equal([...attempts.values()].reduce((sum,n)=>sum+n,0),9);
  assert.deepEqual(result.results.map(r=>r.name),input.map(f=>f.name));
  assert.ok(progress.every((p,index)=>!index||p.fraction>=progress[index-1].fraction));assert.equal(progress.at(-1).fraction,1);
});
test('split permanent failure cancels peers and closes every processing slot before rejecting',async()=>{
  let created=0,disposed=0;const pending=new Map();
  await assert.rejects(runFilePool({files:files.slice(0,4),concurrency:4,createSlot:index=>{
    created++;return {initialize:async()=>{},dispose:()=>{disposed++;pending.get(index)?.(Error('Disposed'));},run:async()=>{
      if(index===0){await setTimeout(3);throw Error('Malformed FASTQ');}
      return new Promise((resolve,reject)=>pending.set(index,reject));
    }};
  }}),/Malformed FASTQ/);
  assert.equal(disposed,created);assert.equal(created,4);
});
