import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

// Audit synchronous native calls inside nested workers. Only this test server
// rewrites responses; the application and WASM binaries are used unchanged.
const audit=`self.addEventListener('message',({data})=>{if(data.__cpuAudit)globalThis.__cpuAudit=new Int32Array(data.__cpuAudit);});
if(globalThis.Worker){const NativeWorker=globalThis.Worker;globalThis.Worker=class extends NativeWorker{postMessage(data,...args){return super.postMessage({...data,__cpuAudit:globalThis.__cpuAudit?.buffer},...args);}};}
function auditedCall(module,args){const a=globalThis.__cpuAudit;if(!a)return module.callMain(args);const active=Atomics.add(a,0,1)+1;let old=Atomics.load(a,1);while(active>old){const seen=Atomics.compareExchange(a,1,old,active);if(seen===old)break;old=seen;}Atomics.add(a,2,1);try{return module.callMain(args);}finally{Atomics.sub(a,0,1);}}
`;
const sources=new Map();
for(const name of ['/split-reads/app/demultiplex-worker.mjs','/split-reads/app/demultiplex-file-worker.mjs','/split-reads/app/blast-worker.mjs','/get-consensus/app/pipeline-worker.mjs','/get-consensus/app/sample-worker.mjs','/get-consensus/tool-worker.mjs']) {
  const source=await readFile(new URL('../public'+name,import.meta.url),'utf8');
  sources.set(name,audit+source.replace('module.callMain([...normalized])','auditedCall(module,[...normalized])').replace('instance.callMain(checkedArgs)','auditedCall(instance,checkedArgs)'));
}
let splitFailure=false;
const server=createServer(),staticHandler=server.listeners('request')[0];server.removeListener('request',staticHandler);
server.on('request',(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;let body=sources.get(pathname);
  if(body && pathname.endsWith('/split-reads/app/blast-worker.mjs')) body=body.replace('const module = await factory(',`if(command==='blastn' && ${splitFailure} && Atomics.compareExchange(globalThis.__cpuAudit,3,0,1)===0)throw new RangeError('WebAssembly.Memory(): could not allocate memory');\n  const module = await factory(`);
  if(!body)return staticHandler(req,res);
  res.writeHead(200,{'Content-Type':'text/javascript','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'});res.end(body);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const output=new URL('../test-results/',import.meta.url);await mkdir(output,{recursive:true});
let browser;
try {
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(180000);
  await page.addInitScript(()=>{
    window.__cpuAudit=new Int32Array(new SharedArrayBuffer(16));const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker{postMessage(data,...args){return super.postMessage({...data,__cpuAudit:window.__cpuAudit.buffer},...args);}};
  });
  await page.goto(base+'/split-reads/');await page.waitForFunction(()=>window.napSplit);
  const device=await page.evaluate(()=>({cores:navigator.hardwareConcurrency||2,ram:navigator.deviceMemory||null}));
  const splitRun=async (mode,single=false,gzip=false)=>page.evaluate(async ({mode,single,gzip})=>{
    window.__cpuAudit.fill(0);const began=performance.now();
    const [gz,primerText,sampleText]=await Promise.all([fetch('../examples/raw-A.fastq.gz').then(r=>r.blob()),fetch('../examples/primer.fa').then(r=>r.text()),fetch('../examples/sample.txt').then(r=>r.text())]);
    const template=await new Response(gz.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    let files=Array.from({length:24},(_,index)=>new File([Array.from({length:50},(_,copy)=>template.replace(/^(@\S+)/gm,`$1_file${index}_copy${copy}`)).join('')],`reads-${index}.fq`));
    if(single){let file=new File(files,'reads-single.fq');if(gzip)file=new File([await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob()],'reads-single.fq.gz');files=[file];window.__singleInputs={fastqFiles:files,primerFile:new File([primerText],'primer.fa'),sampleFile:new File([sampleText],'sample.txt')};}
    const {fileParallelPlan}=await import('../shared/parallel-settings.mjs');
    const plan=fileParallelPlan({parallelMode:mode,parallelCount:1},files,{jobs:single?24:files.length});
    const progress=[],original=window.demultiplexer.onProgress;window.demultiplexer.onProgress=p=>{original(p);progress.push({fraction:p.fraction||0,activeBatches:p.activeBatches,fileCount:p.fileCount,files:p.files?.length,totalReads:p.totalReads,label:document.getElementById('progress-label').textContent});};
    const result=await window.demultiplexer.run({fastqFiles:files,primerText,sampleText,options:{parallelMode:mode,concurrency:1},diagnostics:true});
    window.demultiplexer.onProgress=original;
    const report=JSON.parse(await (await window.demultiplexer.readFile('run.json')).text());
    const names=result.files.filter(f=>/^output\//.test(f.name)||['assignments.tsv','sample-counts.tsv'].includes(f.name)).map(f=>f.name);
    const science=await Promise.all(names.map(async name=>[name,await (await window.demultiplexer.readFile(name)).text()]));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(science))))].map(v=>v.toString(16).padStart(2,'0')).join('');
    return {elapsedMs:performance.now()-began,plan,execution:report.execution,summary:report.summary,progress,totalReads:report.summary.totalReads,hash,native:[...window.__cpuAudit]};
  },{mode,single,gzip});
  const splitAuto=await splitRun('auto');
  assert.equal(splitAuto.execution.maxActiveFiles,splitAuto.plan.limit);assert.equal(splitAuto.execution.requested,device.cores);
  assert.ok(splitAuto.native[1]>=Math.min(2,splitAuto.plan.limit));assert.equal(splitAuto.native[0],0);
  console.log(`PASS split automatic: CPU ${device.cores}, file jobs ${splitAuto.execution.maxActiveFiles}, native overlap ${splitAuto.native[1]}, ${splitAuto.totalReads} reads`);
  const splitSerial=await splitRun('manual');assert.equal(splitSerial.hash,splitAuto.hash);assert.equal(splitSerial.native[1],1);
  splitFailure=true;const splitRetry=await splitRun('auto');assert.equal(splitRetry.hash,splitAuto.hash);assert.equal(splitRetry.execution.memoryRetries,1);assert.ok(splitRetry.execution.concurrency<splitRetry.execution.initialLimit);splitFailure=false;
  console.log('PASS split serial/automatic/retried output hashes match; real allocation error reduces file concurrency');
  const singleAuto=await splitRun('auto',true),singleSerial=await splitRun('manual',true),singleGzip=await splitRun('auto',true,true);
  for(const report of [singleAuto,singleSerial,singleGzip]) {
    assert.equal(report.hash,splitAuto.hash);assert.equal(report.summary.completedFiles,1);assert.equal(report.execution.files.length,1);
    assert.equal(report.execution.batchCount,24);assert.ok(report.execution.maxBufferedReads<=report.execution.initialLimit*300);
    assert.ok(report.progress.every((p,i)=>!i||p.fraction>=report.progress[i-1].fraction));
    assert.ok(report.progress.filter(p=>p.activeBatches!==undefined).every(p=>p.fileCount===1&&p.files===1));
  }
  assert.equal(singleAuto.execution.maxActiveBatches,singleAuto.plan.limit);assert.ok(singleAuto.native[1]>=Math.min(2,singleAuto.plan.limit));
  assert.equal(singleSerial.native[1],1);assert.ok(singleAuto.progress.some(p=>p.activeBatches>1&&p.label.includes('バッチ')));
  splitFailure=true;const singleRetry=await splitRun('auto',true);splitFailure=false;
  assert.equal(singleRetry.hash,splitAuto.hash);assert.equal(singleRetry.execution.memoryRetries,1);assert.ok(singleRetry.execution.concurrency<singleRetry.execution.initialLimit);
  console.log(`PASS single FASTQ: 7200 reads / 24 batches of 300, ${singleAuto.execution.maxActiveBatches} concurrent batch jobs, native overlap ${singleAuto.native[1]}, buffered reads <= ${singleAuto.execution.initialLimit*300}`);
  console.log('PASS single FASTQ serial/parallel/gzip/allocation-retry outputs match multi-file outputs exactly');
  await page.evaluate(()=>window.napSplit.setInputs(window.__singleInputs));await page.waitForFunction(()=>!document.getElementById('split').disabled);
  await page.locator('#split').click();await page.waitForFunction(()=>window.napSplit.state.busy&&document.getElementById('progress-label').textContent.includes('バッチ'));
  await page.locator('#cancel').click();await page.waitForFunction(()=>!window.napSplit.state.busy);assert.equal(await page.evaluate(()=>window.napSplit.state.files.length),0);
  await page.locator('#split').click();await page.waitForFunction(()=>!window.napSplit.state.busy&&window.napSplit.state.files.length===2);
  assert.equal(await page.locator('#file-progress tbody tr').count(),1);assert.equal(await page.locator('#progress').evaluate(p=>p.value),1);
  const uiReport=await page.evaluate(async()=>JSON.parse(await (await window.demultiplexer.readFile('run.json')).text()));
  assert.equal(uiReport.summary.completedFiles,1);assert.equal(uiReport.execution.maxActiveBatches,singleAuto.plan.limit);assert.equal(uiReport.summary.assignedReads,7200);
  await page.screenshot({path:fileURLToPath(new URL('single-fastq-batches.png',output)),fullPage:true});
  console.log('PASS single-file UI: batch progress, one input row, completion at 100%, cancel/restart');
  await page.goto(base+'/get-consensus/');await page.waitForFunction(()=>window.napConsensus);
  const consensusRun=async mode=>page.evaluate(async mode=>{
    window.__cpuAudit.fill(0);const started=performance.now();
    const expected=await fetch('../examples/expected.json').then(r=>r.json());
    const files=Array.from({length:24},(_,index)=>{const seq=expected.samples[index%2].sequence;return new File([Array.from({length:200},(_,n)=>`@read${n}\n${seq}\n+\n${'I'.repeat(seq.length)}\n`).join('')],`sample${index}.fq`);});
    const {fileParallelPlan}=await import('../shared/parallel-settings.mjs');const plan=fileParallelPlan({parallelMode:mode,parallelCount:1},files,{readsInMemory:true});
    window.napConsensus.setFiles(files);const select=document.querySelector('[name=parallelMode]');select.value=mode;select.dispatchEvent(new Event('change'));
    if(mode==='manual')document.querySelector('[name=parallelSamples]').value='1';
    document.querySelector('[name=maxReads]').value='3';document.querySelector('[name=haplotypes]').checked=false;document.getElementById('start').click();
    const result=await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.getConsensus.busy)return;clearInterval(timer);window.getConsensus.result?resolve(window.getConsensus.result):reject(Error(document.getElementById('status').textContent));},50);});
    const text=await result.files.get('all.cnt.seq.qual.txt').text();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
    return {elapsedMs:performance.now()-started,plan,concurrency:result.manifest.concurrency,hash,native:[...window.__cpuAudit]};
  },mode);
  const consensusAuto=await consensusRun('auto');assert.equal(consensusAuto.concurrency.samplePeak,consensusAuto.plan.limit);assert.equal(consensusAuto.concurrency.blastPeak,consensusAuto.plan.limit);assert.equal(consensusAuto.concurrency.requested,device.cores);
  assert.ok(consensusAuto.native[1]>=Math.min(2,consensusAuto.plan.limit));assert.equal(consensusAuto.native[0],0);
  console.log(`PASS consensus automatic: CPU ${device.cores}, sample jobs ${consensusAuto.concurrency.samplePeak}, BLAST jobs ${consensusAuto.concurrency.blastPeak}, native overlap ${consensusAuto.native[1]}`);
  const consensusSerial=await consensusRun('manual');assert.equal(consensusAuto.hash,consensusSerial.hash);assert.equal(consensusSerial.native[1],1);
  console.log('PASS consensus automatic and serial TXT files match exactly');assert.deepEqual(errors,[]);
  await writeFile(new URL('cpu-parallel-report.json',output),JSON.stringify({testedAt:new Date().toISOString(),device,browser:browser.version(),splitAuto,splitSerial,splitRetry,singleAuto,singleSerial,singleGzip,singleRetry,uiReport,consensusAuto,consensusSerial,errors},null,2)+'\n');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
