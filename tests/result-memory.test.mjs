import test from 'node:test';
import assert from 'node:assert/strict';
import { resultBytes, retainedResultBytes } from '../public/shared/result-memory.mjs';
import { fileParallelPlan } from '../public/shared/parallel-settings.mjs';
import { parallelPlan } from '../public/annotation/app/parallel.mjs';
import { defaults } from '../public/annotation/app/core.mjs';
import { DemultiplexClient } from '../public/split-reads/app/demultiplex-client.mjs';
import { runFilePool } from '../public/split-reads/app/demultiplex-file-pool.mjs';
import { setImmediate } from 'node:timers/promises';
import { ConsensusPipeline } from '../public/get-consensus/app/pipeline.mjs';

test('result sizes count preserved Blob artifacts; standalone and inaccessible parents need no reservation', () => {
  const blob = new Blob(['ABC']);
  assert.equal(resultBytes(new Map([['a',blob],['b',new Blob(['DEF'])]])),6);
  assert.equal(resultBytes([{name:'a',blob},{name:'b',size:5}]),8);
  assert.equal(resultBytes(),0);
  assert.equal(retainedResultBytes('split-reads'),0);
  assert.equal(retainedResultBytes('get-consensus',{parent:{nap:{retainedResultBytes:stage=>stage==='get-consensus'?400:0}}}),400);
  assert.equal(retainedResultBytes('annotation',{get parent(){throw Error('Cross origin');}}),0);
});

test('all three planners reserve previous results and lower parallelism without changing CPU request', () => {
  const env={hardwareConcurrency:8,deviceMemory:4},files=Array.from({length:8},()=>({name:'x.fq',size:1}));
  const retainedBytes=400*1024*1024;
  for(const readsInMemory of [false,true]) {
    const ordinary=fileParallelPlan({parallelMode:'auto'},files,{readsInMemory},env);
    const retained=fileParallelPlan({parallelMode:'auto'},files,{readsInMemory,retainedBytes},env);
    assert.equal(ordinary.limit,4); // Eight bytes of input leave just under 960 MiB.
    assert.equal(retained.limit,2);assert.equal(retained.retainedResultMB,400);
    assert.equal(retained.requested,8);assert.equal(retained.reservedMB-ordinary.reservedMB,400);
  }
  const ordinary=parallelPlan(defaults,{groups:8},env),retained=parallelPlan(defaults,{groups:8,retainedBytes},env);
  assert.equal(ordinary.limit,5);assert.equal(retained.limit,2);assert.equal(retained.retainedResultMB,400);
});

test('split coordinator is lazy, terminates on completion, and keeps files readable without workers', async t => {
  const workers=[];
  class Worker {
    constructor(url){this.url=url;this.stops=0;workers.push(this);}
    postMessage(data){this.data=data;}
    terminate(){this.stops++;}
    respond(data){this.onmessage({data});}
  }
  const original=globalThis.Worker;globalThis.Worker=Worker;t.after(()=>{globalThis.Worker=original;});
  const client=new DemultiplexClient();assert.equal(workers.length,0);
  const promise=client.run({});assert.equal(workers.length,1);
  await assert.rejects(client.run({}),/処理中/);
  const blob=new Blob(['@r\nA\n+\nI\n']),report=new Blob(['report']);
  workers[0].respond({id:1,result:{summary:{totalReads:1},files:[{name:'output/a.fq',blob}],fastqReport:report}});
  const result=await promise;assert.equal(result.files[0].size,blob.size);
  assert.equal(client.worker,null);assert.equal(workers[0].stops,0); // Successful workers self.close().
  assert.equal(await (await client.readFile('output/a.fq')).text(),await blob.text());
  assert.equal(client.fastqReport,report);assert.equal(workers.length,1);
  await assert.rejects(client.readFile('missing'),/出力がありません/);
  const archive=client.zip({fastqOnly:true});assert.equal(workers.length,2);
  assert.match(workers[1].url.href,/zip-worker\.mjs$/);
  assert.ok(workers[1].data.files.some(f=>f.name==='split-barcode-results.html'));
  workers[1].respond({result:new Blob(['ZIP'])});assert.equal(await (await archive).text(),'ZIP');
  assert.equal(workers[1].stops,0);assert.equal(client.files.size,1);assert.equal(client.archive,null);
});

test('split failure and cancellation terminate the coordinator; restart and archive cancellation do not leak workers', async t => {
  const workers=[];
  class Worker {
    constructor(){workers.push(this);this.stops=0;}
    postMessage(){}
    terminate(){this.stops++;}
  }
  const original=globalThis.Worker;globalThis.Worker=Worker;t.after(()=>{globalThis.Worker=original;});
  const client=new DemultiplexClient();let promise=client.run({});
  workers[0].onmessage({data:{error:'Malformed FASTQ'}});await assert.rejects(promise,/Malformed/);
  assert.equal(client.worker,null);assert.equal(workers[0].stops,0); // Error replies also self.close().
  promise=client.run({});client.cancel();await assert.rejects(promise,/中止/);
  assert.equal(client.worker,null);assert.equal(workers[1].stops,1);
  promise=client.run({});workers[2].onerror({message:'Worker crash'});await assert.rejects(promise,/crash/);
  assert.equal(client.worker,null);assert.equal(workers[2].stops,1);
  client.files.set('output/a.fq',new Blob(['A']));client.fastqReport=new Blob(['report']);
  promise=client.zip();client.dispose();await assert.rejects(promise,/abort/i);
  assert.equal(workers[3].stops,1);assert.equal(client.files.size,0);assert.equal(client.archive,null);
});

test('split completion waits for child cleanup before returning the saved result', async () => {
  let finishCleanup,returned=false;
  const pending=runFilePool({files:[{name:'reads.fq',size:1}],concurrency:1,createSlot:()=>({
    initialize:async()=>{},
    run:async()=>({summary:{totalReads:1,assignedReads:1,segments:1,batches:1}}),
    dispose:()=>new Promise(resolve=>{finishCleanup=resolve;}),
  })});
  pending.then(()=>{returned=true;});
  while(!finishCleanup)await setImmediate();
  assert.equal(returned,false);finishCleanup();
  const result=await pending;assert.equal(result.results[0].summary.totalReads,1);
});

test('growing consensus outputs reduce later sample and BLAST jobs while preserving the table', async () => {
  const MiB=1024*1024,seq='ACGT'.repeat(100),files=Array.from({length:12},(_,i)=>Object.assign(new Blob(['FASTQ']),{name:`sample${i}.fq`}));
  const run=async parallelSamples=>{
    let active=0;const starts=[],progress=[];
    const sampleJobs={async run(kind,{job}) {
      if(kind==='blast')return {local:{files:new Map(),logs:[],warnings:[]},sample:job.sample,counts:new Map([['sample0_cluster',3]])};
      active++;starts.push({name:job.name,active});await setImmediate();active--;
      // Simulate large saved artifacts through their size metadata; no large
      // allocation is needed to exercise the scheduling policy.
      return {local:{files:new Map([[`work/${job.name}`,{size:200*MiB}]]),logs:[],warnings:[]},sample:{name:job.name,filename:job.file.name,reads:3},
        entries:[{id:job.name+'_cluster',seq,qual:'Z'.repeat(seq.length),count:3}],ties:0};
    }};
    const tools={async align(text){return {exitCode:0,stdout:text,stderr:''};},async run(tool,args,{files}) {
      if(tool==='makeblastdb')return {exitCode:0,stdout:'',stderr:'',files:{'db.nsq':new Uint8Array([1])}};
      const names=[...files['all.fa'].matchAll(/^>(\S+)/gm)].map(m=>m[1]);
      return {exitCode:0,stdout:'',stderr:'',files:{'centers.fa':`>${names[0]}\n${seq}\n`,'centers.fa.clstr':'>Cluster 0\n'+names.map((id,i)=>`${i} 400aa, >${id}... *\n`).join('')}};
    }};
    const result=await new ConsensusPipeline({tools,sampleJobs,environment:{hardwareConcurrency:8,deviceMemory:4},onProgress:p=>progress.push(p)}).run(files,{parallelSamples,haplotypes:false});
    return {result,starts,progress};
  };
  const serial=await run(1),parallel=await run(8);
  assert.equal(parallel.result.manifest.concurrency.limit,4);
  assert.ok(parallel.starts.slice(4).every(start=>start.active===1),'Queued jobs use the reduced limit after saved output grows');
  assert.equal(parallel.result.manifest.concurrency.effectiveLimit,1);
  assert.equal(parallel.result.manifest.concurrency.blastPeak,1);
  assert.equal(parallel.result.manifest.concurrency.analysisOutputMB,2400);
  assert.ok(parallel.result.manifest.warnings.some(message=>message.includes('保存済み結果')));
  assert.equal(await parallel.result.files.get('all.cnt.seq.qual.txt').text(),await serial.result.files.get('all.cnt.seq.qual.txt').text());
});
