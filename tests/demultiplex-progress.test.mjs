import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { runFilePool } from '../public/split-reads/app/demultiplex-file-pool.mjs';
import { runPipeline } from '../public/split-reads/app/demultiplex-pipeline.mjs';

const summary = totalReads => ({ totalReads, assignedReads: totalReads, segments: totalReads, batches: 1 });
test('overall progress uses each job completion fraction, never file start or read-ahead bytes', { timeout: 5000 }, async () => {
  const files=[{name:'same.fq',size:60},{name:'same.fq',size:30},{name:'empty.fq',size:10}],pending=[],progress=[];
  const promise=runFilePool({files,concurrency:2,onProgress:message=>progress.push(message),createSlot:()=>({
    initialize:async()=>{},dispose:()=>{},
    run:(file,notify)=>new Promise(resolve=>pending.push({file,notify,resolve})),
  })});
  while(pending.length<2)await setImmediate();
  assert.equal(progress.at(-1).fraction,0);
  assert.equal(progress.at(-1).activeFiles,2);
  pending[0].notify({phase:'processing',inputReads:10,totalReads:0,consumed:60,stage:'BLAST'});
  pending[1].notify({phase:'processing',inputReads:4,totalReads:0,consumed:30,stage:'BLAST'});
  assert.equal(progress.at(-1).fraction,0,'Reading both files to EOF must not advance processing');
  pending[0].notify({totalReads:5,stage:'バッチ完了'});
  assert.equal(progress.at(-1).fraction,0.3);
  pending[1].notify({totalReads:2,stage:'バッチ完了'});
  assert.ok(Math.abs(progress.at(-1).fraction-0.45)<1e-12);
  assert.deepEqual(progress.at(-1).files.map(file=>file.fraction),[0.5,0.5,0]);
  pending[1].notify({totalReads:2,stage:'次の BLAST を開始'});
  assert.ok(Math.abs(progress.at(-1).fraction-0.45)<1e-12,'Starting another search is not completed work');
  pending[1].notify({totalReads:4,stage:'出力準備'});
  assert.ok(progress.at(-1).files[1].fraction<1,'Leave 100% for a successful file result');
  pending[1].resolve({summary:summary(4)});
  while(pending.length<3)await setImmediate();
  assert.equal(progress.at(-1).files[1].fraction,1);
  assert.equal(progress.at(-1).files[2].fraction,0,'Queued successor starts at zero');
  pending[2].notify({phase:'processing',inputReads:0,totalReads:0,consumed:10,stage:'出力準備'});
  assert.ok(Number.isFinite(progress.at(-1).fraction),'Zero-read files never produce NaN');
  pending[2].resolve({summary:summary(0)});pending[0].resolve({summary:summary(10)});
  const result=await promise;
  assert.equal(progress.at(-1).fraction,1);
  assert.ok(result.execution.files.every(file=>file.fraction===1));
  assert.ok(progress.every((message,index)=>index===0 || message.fraction>=progress[index-1].fraction));
});

const primerText='>F\nACGTACGA\n>R\nTTGCTAAC\n',sampleText='sample F R 28 28\n';
const records=Array.from({length:5},(_,index)=>`@read${index+1} metadata\nACGTACGAGGGGGGGGGGGGGTTAGCAA\n+\n${'J'.repeat(28)}\n`);
function mockBlast(memoryRetry=false) {
  const files=new Map(),queries=[];
  return {queries,
    writeFile:async(name,text)=>files.set(name,text),readFile:async name=>files.get(name),removeFile:async name=>files.delete(name),
    run:async(command,args)=>{
      if(command==='makeblastdb')return {exitCode:0};
      const ids=files.get('batch.fa').split('\n').filter(line=>line.startsWith('>')).map(line=>line.slice(1));
      const db=args[args.indexOf('-db')+1],out=args[args.indexOf('-out')+1];
      if(db==='primers')queries.push(ids.length);
      if(memoryRetry && ids.length>2)return {exitCode:4,stderr:'BLAST ran out of memory'};
      const id=index=>db==='primers'?`primer_${index}_variant_1`:`primer_${index}`;
      files.set(out,ids.flatMap(query=>[
        [query,id(1),100,8,0,0,1,8,1,8,0.1,30].join('\t'),
        [query,id(2),100,8,0,0,21,28,8,1,0.1,30].join('\t'),
      ]).join('\n'));
      return {exitCode:0};
    },
  };
}
const contents=async result=>Object.fromEntries(await Promise.all(result.files.map(async file=>[file.name,await file.blob.text()])));
test('concatenated gzip progress counts completed batches while preserving FASTQ output',async()=>{
  const input={primerText,sampleText,options:{batchSize:2},databaseReady:true};
  const plain=new File([records.join('')],'plain.fq');
  // One small Blob part makes EOF read-ahead deterministic across Node versions;
  // two parts can be delivered separately even though the gzip bytes are equal.
  const gzip=new File([Buffer.concat([gzipSync(records.slice(0,3).join('')),gzipSync(records.slice(3).join(''))])],'input.fq.gz');
  const events=[];
  const reference=await runPipeline({...input,fastqFiles:[plain]},mockBlast());
  const result=await runPipeline({...input,fastqFiles:[gzip]},mockBlast(),message=>events.push(message));
  assert.ok(events.some(message=>message.phase==='counting' && message.inputReads===null));
  const searches=events.filter(message=>message.stage.includes('プライマー BLAST'));
  assert.deepEqual(searches.map(message=>message.totalReads),[0,2,4]);
  assert.ok(searches.every(message=>message.inputReads===5));
  assert.equal(searches[0].consumed,gzip.size,'Reproduce EOF read-ahead before first BLAST');
  assert.deepEqual(events.filter(message=>/^バッチ \d+ 完了$/.test(message.stage)).map(message=>message.totalReads),[2,4,5]);
  const expected=await contents(reference),actual=await contents(result);
  for(const name of ['output/sample.fq','assignments.tsv','output.stats','sample-counts.tsv'])assert.equal(actual[name],expected[name]);
  assert.equal(result.summary.segments,5);
});

test('memory retry does not credit failed BLAST attempts or change the read denominator',async()=>{
  const input={fastqFiles:[new File([records.join('')],'input.fq')],primerText,sampleText,options:{batchSize:5},databaseReady:true};
  const reference=await runPipeline(input,mockBlast()),events=[],blast=mockBlast(true);
  const result=await runPipeline(input,blast,message=>events.push(message));
  assert.deepEqual(blast.queries,[5,3,2,1,2]);
  const processing=events.filter(message=>message.phase==='processing');
  assert.ok(processing.every(message=>message.inputReads===5));
  assert.ok(processing.every((message,index)=>index===0 || message.totalReads>=processing[index-1].totalReads));
  assert.deepEqual(events.filter(message=>/^バッチ \d+ 完了$/.test(message.stage)).map(message=>message.totalReads),[2,3,5]);
  const expected=await contents(reference),actual=await contents(result);
  for(const name of ['output/sample.fq','assignments.tsv','output.stats','sample-counts.tsv'])assert.equal(actual[name],expected[name]);
  assert.equal(result.summary.memoryRetries,2);
});

test('invalid gzip fails in the counting stage without claiming processing completion',async()=>{
  const bytes=gzipSync(records.join(''));bytes[bytes.length-8]^=1;
  const blast=mockBlast(),events=[];
  await assert.rejects(runPipeline({fastqFiles:[new File([bytes],'bad.fq.gz')],primerText,sampleText,databaseReady:true},blast,message=>events.push(message)),/CRC/);
  assert.deepEqual(blast.queries,[]);
  assert.ok(events.every(message=>message.totalReads===0 && message.phase==='counting'));
});
