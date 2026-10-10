import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateOptions } from '../public/annotation/app/core.mjs';
import { queryGroups, parallelPlan, sharedReference, memoryBudget, cpuParallelism } from '../public/annotation/app/parallel.mjs';
import { runAnnotation } from '../public/annotation/app/pipeline.mjs';
import { isMemoryAllocationError } from '../public/get-consensus/app/memory.mjs';
const MiB = 1024 * 1024, environment = { hardwareConcurrency: 8, deviceMemory: 8 };
const file = (text, name) => Object.assign(new Blob([text]), { name });
const seq = 'ACGT'.repeat(50);
const input = options => ({ mode: 'fasta', options: { ...defaults, ...(options?.parallelQueries === undefined ? {} : {parallelMode:'manual'}), internalControl: '', shardBases: 200, ...options },
  tableFile: file('id\tseq\tqual\tA\n' + Array.from({length:12}, (_,i) => `id${i}\t${seq}\t${'I'.repeat(200)}\t${i+1}\n`).join(''), 'input.txt'),
  referenceFile: file(`>a\n${seq}\n>b\n${seq}\n`, 'ref.fa'), pathFile: file('a\tRoot;A\nb\tRoot;B\n', 'ref.path') });
function mockTools({ memory = false, fatal = false, delay = 12 } = {}) {
  const state = { active: 0, peak: 0, failed: false, starts: 0 };
  return { state, async run(tool, args, { files, signal }) {
    signal?.throwIfAborted();
    if (tool === 'makeblastdb') {
      const name = args[args.indexOf('-out')+1];
      const ordinal=Number(files['reference.fa']?.match(/^>r(\d+)/)?.[1] || 0);
      return { exitCode:0, stdout:'', stderr:'', files:Object.fromEntries(['nhr','nin','nsq'].map(ext=>[`${name}.${ext}`,Uint8Array.from([ordinal,0,0,0,0,0,0,0])])) };
    }
    state.starts++; state.active++; state.peak = Math.max(state.peak,state.active);
    const ids = [...files['query.fa'].matchAll(/^>(q\d+)/gm)].map(match=>match[1]);
    const failing = !state.failed && ids.includes('q0') && (memory || fatal);
    if (failing) state.failed = true;
    try {
      await new Promise((resolve,reject) => {
        const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},failing?2:delay+(Number(ids[0].slice(1))%3)*3);
        signal?.addEventListener('abort',abort,{once:true});
      });
      if(failing)throw memory?Object.assign(Error('WebAssembly.Memory(): could not allocate memory'),{code:'WASM_MEMORY'}):Error('invalid BLAST input');
      return { exitCode:0, stdout:'', stderr:'', files:{'hits.tsv':new TextEncoder().encode(ids.map(id=>`${id}\tr${files['reference.nhr'][0]}\t100.000\t200\t0\t0\t1\t200\t1\t200\t1e-90\t400\n`).join(''))} };
    } finally { state.active--; }
  } };
}
test('query groups bound batch size, split small inputs across lanes and retain globally unique query IDs', () => {
  const groups=queryGroups(Array.from({length:5},()=>({seq})),100,4);
  assert.deepEqual(groups.map(group=>group.count),[2,2,1]);
  assert.deepEqual(groups.map(group=>group.start),[0,2,4]);
  assert.equal(groups[2].query,`>q4\n${seq}\n`);
  assert.ok(queryGroups(Array.from({length:1000},()=>({seq})),100,4).every(group=>group.count<=100));
});
test('CPU, device RAM, input/DB copies and requested budget cap parallelism before workers start', () => {
  assert.equal(parallelPlan(defaults,{groups:10},environment).limit,8);
  assert.equal(parallelPlan(defaults,{groups:10},{hardwareConcurrency:1,deviceMemory:8}).limit,1);
  assert.equal(parallelPlan(defaults,{groups:10},{}).limit,2);
  assert.equal(parallelPlan(defaults,{groups:10},{hardwareConcurrency:8,deviceMemory:1}).limit,1);
  const manual={...defaults,memoryMode:'manual'};
  assert.equal(parallelPlan(manual,{groups:10,referenceBytes:180*MiB},environment).limit,1);
  assert.equal(parallelPlan(manual,{groups:10,inputBytes:200*MiB},environment).limit,1);
  assert.equal(parallelPlan({...manual,memoryBudgetMB:256},{groups:10},environment).limit,1);
  for(const options of [{parallelQueries:0},{parallelQueries:1.5},{parallelMode:'invalid'},{memoryMode:'invalid'},{memoryMode:'manual',memoryBudgetMB:128},{memoryMode:'manual',memoryBudgetMB:256.5}])assert.throws(()=>validateOptions(options));
  const bytes=new Uint8Array([1,2]);assert.equal(sharedReference({db:bytes}).files.db,bytes,'No isolation: use ordinary buffers');
});
test('automatic concurrency uses logical CPU cores, then bounds by memory and available query groups', () => {
  assert.equal(defaults.parallelMode,'auto');
  assert.deepEqual(cpuParallelism(defaults,{hardwareConcurrency:20}),{cores:20,parallelMode:'auto',requested:20,processorSource:'device'});
  assert.equal(cpuParallelism(defaults,{}).requested,2);
  assert.equal(cpuParallelism(defaults,{hardwareConcurrency:0}).requested,2);
  assert.equal(cpuParallelism({...defaults,parallelMode:'manual',parallelQueries:1},environment).requested,1);
  assert.equal(parallelPlan(defaults,{referenceBytes:32*MiB,groups:30},{hardwareConcurrency:20,deviceMemory:32}).limit,20);
  assert.equal(parallelPlan(defaults,{referenceBytes:32*MiB,groups:30},{hardwareConcurrency:20,deviceMemory:1}).limit,1);
  assert.equal(parallelPlan(defaults,{groups:3},{hardwareConcurrency:20,deviceMemory:32}).limit,3);
  const manual=validateOptions({parallelMode:'manual',parallelQueries:32});
  assert.equal(parallelPlan(manual,{groups:32},{hardwareConcurrency:4,deviceMemory:32}).limit,4);
});
test('automatic CPU parallelism overlaps tool jobs and preserves serial scientific outputs', async () => {
  const serial=await runAnnotation(input({parallelQueries:1,batchSize:1}),{tools:mockTools(),environment});
  const tools=mockTools(),automatic=await runAnnotation(input({batchSize:1}),{tools,environment});
  assert.equal(tools.state.peak,8);assert.equal(tools.state.active,0);
  assert.equal(automatic.manifest.execution.concurrency.requested,8);
  assert.equal(automatic.manifest.execution.concurrency.parallelMode,'auto');
  assert.equal(automatic.manifest.execution.concurrency.cores,8);
  assert.equal(await automatic.files.get('blast.tsv').text(),await serial.files.get('blast.tsv').text());
  assert.equal(await automatic.files.get('all.cnt.seq.qual.tax.sp.txt').text(),await serial.files.get('all.cnt.seq.qual.tax.sp.txt').text());
});
test('automatic memory uses the device hint rather than the old 1024 MiB ceiling, with an explicit fallback and manual override', () => {
  assert.equal(defaults.memoryMode,'auto');
  assert.deepEqual(memoryBudget(defaults,{deviceMemory:32}),{mode:'auto',budgetMB:8192,automaticBudgetMB:8192,deviceMemoryGB:32,source:'device'});
  assert.equal(memoryBudget(defaults,environment).budgetMB,2048);
  assert.equal(memoryBudget(defaults,{}).budgetMB,512);
  assert.equal(memoryBudget(defaults,{deviceMemory:NaN}).source,'fallback');
  assert.equal(memoryBudget(defaults,{deviceMemory:0}).source,'fallback');
  assert.equal(memoryBudget(defaults,{deviceMemory:.25}).budgetMB,64);
  const manual=validateOptions({memoryMode:'manual',memoryBudgetMB:8192});
  assert.equal(memoryBudget(manual,{}).budgetMB,8192,'Manual budget works even if device RAM is unavailable');
  assert.equal(memoryBudget(manual,environment).budgetMB,8192,'Explicit manual budget can exceed the coarse hint');
  assert.equal(parallelPlan({...defaults,parallelQueries:8},{groups:8,referenceBytes:32*MiB},{hardwareConcurrency:20,deviceMemory:32}).limit,8);
  assert.equal(parallelPlan({...defaults,memoryMode:'manual'},{groups:8,referenceBytes:32*MiB},{hardwareConcurrency:20,deviceMemory:32}).limit,3);
});
test('native heap and JS DB-copy allocation errors trigger recovery; unrelated traps do not', () => {
  for(const message of ['Array buffer allocation failed','std::bad_alloc','Aborted(OOM)','Cannot allocate memory'])assert.equal(isMemoryAllocationError(Error(message)),true);
  for(const message of ['memory access out of bounds','Cannot open OOM.fa','invalid query'])assert.equal(isMemoryAllocationError(Error(message)),false);
});
test('parallel search completion order preserves all sequential classifications, counts and BLAST files', async () => {
  const serial=await runAnnotation(input({parallelQueries:1,batchSize:3}),{tools:mockTools(),environment});
  const tools=mockTools(),progress=[];
  const parallel=await runAnnotation(input({parallelQueries:4,batchSize:3}),{tools,environment,onProgress:p=>progress.push(p)});
  assert.equal(tools.state.peak,4);assert.equal(tools.state.active,0);
  assert.equal(parallel.manifest.execution.referenceVolumes,2);
  assert.equal(parallel.manifest.execution.concurrency.peak,4);
  for(const name of ['blast.tsv','blast.filtered.tsv','all.cnt.seq.qual.tax.txt','all.cnt.seq.qual.tax.sp.txt'])assert.equal(await parallel.files.get(name).text(),await serial.files.get(name).text(),name);
  assert.ok(progress.every((p,i)=>!i||p.fraction>=progress[i-1].fraction));
  assert.equal(progress.find(p=>p.phase==='BLAST検索').fraction,.02,'Launching jobs does not advance work completed');
});
test('allocation failure reduces the shared limit for subsequent volumes and retries without duplicate hits', async () => {
  const expected=await runAnnotation(input({parallelQueries:1,batchSize:3}),{tools:mockTools(),environment});
  const tools=mockTools({memory:true}),actual=await runAnnotation(input({parallelQueries:4,batchSize:3}),{tools,environment});
  assert.equal(actual.manifest.execution.concurrency.memoryRetries,1);
  assert.equal(actual.manifest.execution.concurrency.finalLimit,2);assert.equal(tools.state.active,0);
  assert.equal(tools.state.starts,9,'Eight successful batches plus one failed attempt');
  assert.equal(await actual.files.get('blast.tsv').text(),await expected.files.get('blast.tsv').text());
  assert.equal(await actual.files.get('all.cnt.seq.qual.tax.sp.txt').text(),await expected.files.get('all.cnt.seq.qual.tax.sp.txt').text());
  assert.match(actual.manifest.warnings.join('\n'),/4から2/);
});
test('failure and cancellation drain every active query job before the pipeline rejects', async () => {
  const broken=mockTools({fatal:true});
  await assert.rejects(runAnnotation(input({batchSize:3}),{tools:broken,environment}),/invalid BLAST input/);
  assert.equal(broken.state.active,0);
  const tools=mockTools({delay:1000}),controller=new AbortController();
  const job=runAnnotation(input({batchSize:3}),{tools,environment,signal:controller.signal,onProgress:p=>{if(p.phase==='BLAST検索'&&tools.state.active>0)controller.abort();}});
  // onState precedes the actual worker call; wait until tasks are active.
  const timer=setInterval(()=>{if(tools.state.active)controller.abort();},1);
  try {await assert.rejects(job,error=>error.name==='AbortError');}finally{clearInterval(timer);}
  assert.equal(tools.state.active,0);
});
