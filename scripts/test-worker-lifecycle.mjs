import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from './serve.mjs';
import { unzipSync, strFromU8 } from '../public/split-reads/vendor/fflate.mjs';

// Audit native calls; actual browser targets verify worker teardown. Only
// this test server modifies HTTP responses.
const audit=`self.addEventListener('message',({data})=>{if(data.__lifeAudit)globalThis.__lifeAudit=new Int32Array(data.__lifeAudit);});
function auditedCall(module,args){const a=globalThis.__lifeAudit,active=Atomics.add(a,3,1)+1;let old=Atomics.load(a,4);while(active>old){const seen=Atomics.compareExchange(a,4,old,active);if(seen===old)break;old=seen;}Atomics.add(a,5,1);try{return module.callMain(args);}finally{Atomics.sub(a,3,1);}}
`;
const sources=new Map();
for(const pathname of ['/split-reads/app/demultiplex-worker.mjs','/split-reads/app/demultiplex-file-worker.mjs','/split-reads/app/blast-worker.mjs','/get-consensus/app/pipeline-worker.mjs','/get-consensus/app/sample-worker.mjs','/get-consensus/tool-worker.mjs','/annotation/app/pipeline-worker.mjs','/shared/zip-worker.mjs']) {
  const source=await readFile(new URL('../public'+pathname,import.meta.url),'utf8');
  sources.set(pathname,audit+source.replace('module.callMain([...normalized])','auditedCall(module,[...normalized])').replace('instance.callMain(checkedArgs)','auditedCall(instance,checkedArgs)'));
}
const server=createServer(),staticHandler=server.listeners('request')[0];server.removeListener('request',staticHandler);
server.on('request',(req,res)=>{
  const body=sources.get(new URL(req.url,'http://localhost').pathname);
  if(!body)return staticHandler(req,res);
  res.writeHead(200,{'Content-Type':'text/javascript','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'});res.end(body);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const output=new URL('../test-results/',import.meta.url);await mkdir(output,{recursive:true});
let browser;
try {
  const channel=process.env.BROWSER_CHANNEL||'chrome';
  browser=await chromium.launch({channel,headless:true});
  const browserSession=await browser.newBrowserCDPSession();
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    const audit=window.top.__lifeAudit ||= new Int32Array(new SharedArrayBuffer(24)),NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      postMessage(data,...args){return super.postMessage({...data,__lifeAudit:audit.buffer},...args);}
    };
  });
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(180000);page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});
  await page.goto(base+'/');await page.waitForFunction(()=>window.nap?.state.annotation && window.nap.state.consensus && window.nap.state.split);
  const frame=stage=>page.frames().find(f=>f.url()===base+'/'+stage+'/');
  const split=frame('split-reads'),consensus=frame('get-consensus'),annotation=frame('annotation'),runs=[];
  const idle=async(checkNative=true)=>{
    if(checkNative)await page.waitForFunction(()=>window.__lifeAudit[3]===0,undefined,{timeout:10000});
    const counters=await page.evaluate(()=>Array.from(window.__lifeAudit));
    // terminate() being called is insufficient: pending worker-created Blobs
    // used to keep Chromium worker targets and their heaps alive indefinitely.
    // Check actual browser targets, without forcing garbage collection.
    let live=[];const deadline=Date.now()+10000;
    do {
      live=(await browserSession.send('Target.getTargets')).targetInfos.filter(target=>target.type==='worker');
      if(!live.length)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<deadline);
    assert.deepEqual(live.map(target=>target.url),[],'Completed analysis and ZIP workers must disappear from the browser');
    return counters;
  };
  assert.equal((await idle())[0],0,'No calculation worker is created before starting an analysis');
  await split.locator('#load-test').click();await split.waitForFunction(()=>!window.napSplit.state.busy && !document.getElementById('split').disabled);
  await split.locator('#batch-size').fill('2');
  for(let cycle=1;cycle<=3;cycle++) {
    await page.getByRole('tab',{name:/split-reads/}).click();await split.locator('#split').click();
    await split.waitForFunction(()=>!window.napSplit.state.busy && window.napSplit.state.files.length===2);const afterSplit=await idle();
    assert.equal(await split.evaluate(()=>window.demultiplexer.worker),null);
    const splitSnapshot=await split.evaluate(async()=>Object.fromEntries(await Promise.all(window.napSplit.state.files.map(async f=>[f.name,await (await window.demultiplexer.readFile(f.name)).text()]))));
    await page.getByRole('tab',{name:/get-consensus/}).click();await page.locator('#transfer-selected').click();
    await consensus.waitForFunction(()=>window.napConsensus.inputs.length===2);
    // Eleven synthetic samples use the two actual demultiplexed FASTQs. This
    // tests the reported workflow size without publishing experiment inputs.
    await consensus.evaluate(()=>{
      const source=window.napConsensus.inputs,provenance=window.napConsensus.state.provenance;
      const files=Array.from({length:11},(_,i)=>new File([source[i%2]],`BC${String(i+1).padStart(2,'0')}.fq`));
      window.__lifecycleInputs=files;window.napConsensus.setFiles(files,provenance);
      document.querySelector('[name=haplotypes]').checked=false;
    });
    const previousBytes=await page.evaluate(()=>window.nap.retainedResultBytes('get-consensus'));
    await consensus.locator('#start').click();await consensus.waitForFunction(()=>!window.napConsensus.busy && !!window.napConsensus.result);
    const afterConsensus=await idle(),summary=await consensus.evaluate(async()=>({txt:await window.napConsensus.result.files.get('all.cnt.seq.qual.txt').text(),manifest:window.napConsensus.result.manifest}));
    assert.equal(summary.manifest.samples.length,11);assert.equal(summary.manifest.concurrency.retainedResultMB,Math.ceil(previousBytes/1024/1024));
    if(runs.length)assert.equal(summary.txt,runs[0].txt,'Repeated same-page analyses produce identical sequences and counts');
    await page.getByRole('tab',{name:/rRNA annotation/}).click();await annotation.locator('#demo').click();
    await annotation.evaluate(()=>document.querySelector('[name=internalControl]').value='');
    await page.locator('#transfer-consensus').click();
    const annotationBytes=await page.evaluate(()=>window.nap.retainedResultBytes('annotation'));
    await annotation.locator('#start').click();await annotation.waitForFunction(()=>!window.napAnnotation.state.busy);
    assert.ok(await annotation.evaluate(()=>!!window.napAnnotation.result),await annotation.locator('#status').textContent());
    const afterAnnotation=await idle(),classified=await annotation.evaluate(()=>window.napAnnotation.result.manifest);
    assert.equal(classified.summary.annotated,2);assert.equal(classified.summary.samples,11);
    assert.equal(classified.execution.concurrency.retainedResultMB,Math.ceil(annotationBytes/1024/1024));
    assert.deepEqual(await split.evaluate(async()=>Object.fromEntries(await Promise.all(window.napSplit.state.files.map(async f=>[f.name,await (await window.demultiplexer.readFile(f.name)).text()])))),splitSnapshot,'Split FASTQs remain intact after both later stages');
    assert.equal(await consensus.evaluate(async()=>await window.napConsensus.result.files.get('all.cnt.seq.qual.txt').text()),summary.txt);
    const zip=await split.evaluate(async()=>[...new Uint8Array(await (await window.demultiplexer.zip()).arrayBuffer())]);
    const archive=unzipSync(Uint8Array.from(zip));for(const [name,text] of Object.entries(splitSnapshot))assert.equal(strFromU8(archive[name]),text);
    for(const stage of [consensus,annotation]) {
      await page.getByRole('tab',{name:stage===consensus?/get-consensus/:/rRNA annotation/}).click();
      const downloadPromise=page.waitForEvent('download');await stage.locator('#zip').click();const download=await downloadPromise;assert.equal(await download.failure(),null);
    }
    await idle();
    const bytes=await page.evaluate(()=>({split:window.nap.state.split.resultBytes,consensus:window.nap.state.consensus.resultBytes,annotation:window.nap.state.annotation.resultBytes}));
    assert.ok(Object.values(bytes).every(n=>n>0));runs.push({cycle,txt:summary.txt,afterSplit,afterConsensus,afterAnnotation,retainedBytes:bytes,concurrency:summary.manifest.concurrency});
    console.log(`PASS cycle ${cycle}: split -> 11-sample consensus -> annotation; all workers terminated, results and three ZIP downloads retained`);
  }
  const inputs=await consensus.evaluate(async()=>Promise.all(window.__lifecycleInputs.map(async f=>({name:f.name,text:await f.text()}))));
  const fresh=await context.newPage();fresh.setDefaultTimeout(180000);await fresh.goto(base+'/get-consensus/');await fresh.waitForFunction(()=>window.napConsensus);
  await fresh.evaluate(files=>{window.napConsensus.setFiles(files.map(f=>new File([f.text],f.name)));document.querySelector('[name=haplotypes]').checked=false;},inputs);
  await fresh.locator('#start').click();await fresh.waitForFunction(()=>!window.napConsensus.busy && !!window.napConsensus.result);
  const freshText=await fresh.evaluate(async()=>window.napConsensus.result.files.get('all.cnt.seq.qual.txt').text());assert.equal(freshText,runs[0].txt);
  const freshAudit=await fresh.evaluate(()=>Array.from(window.__lifeAudit));assert.equal(freshAudit[0],freshAudit[1]);assert.equal(freshAudit[2],0);
  console.log('PASS 11-sample consensus results match a fresh page exactly');
  await fresh.close();
  // Model an almost occupied memory budget without allocating fake gigabytes.
  // Verify the UI passes the retained artifacts all the way to scheduling.
  const simulatedBytes=(runs[0].concurrency.memoryBudgetMB-128)*1024*1024;
  await page.evaluate(bytes=>{const original=window.nap.retainedResultBytes.bind(window.nap);window.nap.retainedResultBytes=stage=>original(stage)+bytes;},simulatedBytes);
  await consensus.evaluate(()=>window.napConsensus.setFiles(window.__lifecycleInputs));
  await page.getByRole('tab',{name:/get-consensus/}).click();await consensus.locator('#start').click();
  await consensus.waitForFunction(()=>!window.napConsensus.busy && !!window.napConsensus.result);await idle();
  const limited=await consensus.evaluate(async()=>({txt:await window.napConsensus.result.files.get('all.cnt.seq.qual.txt').text(),concurrency:window.napConsensus.result.manifest.concurrency}));
  assert.ok(limited.concurrency.reservedMB>=simulatedBytes/1024/1024);
  assert.equal(limited.concurrency.limit,1);assert.equal(limited.concurrency.samplePeak,1);assert.equal(limited.concurrency.blastPeak,1);assert.equal(limited.txt,runs[0].txt);
  await consensus.evaluate(()=>window.napConsensus.setFiles(window.__lifecycleInputs));
  await consensus.locator('#start').click();await consensus.waitForFunction(()=>window.napConsensus.busy);
  await consensus.locator('#cancel').click();await consensus.waitForFunction(()=>!window.napConsensus.busy);
  await idle(false);assert.equal(await consensus.evaluate(()=>window.napConsensus.result),null);
  await consensus.evaluate(()=>window.napConsensus.setFiles([new File(['invalid FASTQ'],'broken.fq')]));
  await consensus.locator('#start').click();await consensus.waitForFunction(()=>!window.napConsensus.busy);
  await idle(false);assert.equal(await consensus.evaluate(()=>window.napConsensus.result),null);
  assert.match(await consensus.locator('#status').textContent(),/不正|不完全|リードがありません/);
  await consensus.evaluate(async()=>{
    const {ConsensusTools}=await import('./tool-client.mjs');
    try {await new ConsensusTools().run('vsearch',[],{files:{invalid:()=>{}}});throw Error('Expected clone failure');}
    catch(error){if(error.name!=='DataCloneError')throw error;}
  });
  await idle(false);
  console.log('PASS cancellation, malformed FASTQ and postMessage clone failure leave no browser workers');
  assert.deepEqual(errors,[]);
  await writeFile(new URL('worker-lifecycle-report.json',output),JSON.stringify({testedAt:new Date().toISOString(),browser:browser.version(),fixture:'11 synthetic FASTQs derived from two demultiplexed demo outputs',runs,limited:limited.concurrency,errors},null,2)+'\n');
  console.log('PASS retained result memory is reserved without losing outputs');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
