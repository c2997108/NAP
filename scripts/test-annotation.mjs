import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from './serve.mjs';
import { unzipSync,strFromU8 } from '../public/get-consensus/vendor/fflate.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'test-results','annotation');await mkdir(out,{recursive:true});
const full=process.argv.includes('--full-db'),channel=process.env.BROWSER_CHANNEL||'chrome';
const demo=JSON.parse(await readFile(path.join(root,'public/examples/expected.json'),'utf8'));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({...(channel==='chromium'?{}:{channel}),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker,active=new Set();window.annotationTestWorkers=active;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);active.add(this);}
      terminate(){active.delete(this);return super.terminate();}
    };
  });
  page.setDefaultTimeout(600000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>window.nap?.state.annotation && window.nap.state.consensus);
  const consensus=page.frame({name:'consensus-frame'}),annotation=page.frame({name:'annotation-frame'});
  assert.ok(consensus && annotation);assert.equal(await page.getByRole('tab').count(),3);
  await page.getByRole('tab',{name:/get-consensus/}).click();
  await consensus.evaluate(samples=>window.napConsensus.setFiles(samples.map((sample,index)=>new File([Array.from({length:6},(_,read)=>`@test_${index}_${read}\n${sample.sequence}\n+\n${'I'.repeat(sample.sequence.length)}\n`).join('')],`sample_${index}.fq`))),demo.samples);
  await consensus.locator('#start').click();await consensus.waitForFunction(()=>!window.napConsensus.busy && window.napConsensus.result);
  const original=await consensus.evaluate(()=>window.napConsensus.result.files.get('all.cnt.seq.qual.txt').text());
  assert.equal(await page.locator('#open-annotation').isDisabled(),false);
  await page.locator('#open-annotation').click();
  assert.equal(await page.getByRole('tab',{name:/rRNA annotation/}).getAttribute('aria-selected'),'true');
  assert.equal(await annotation.evaluate(()=>window.napAnnotation.result),null);
  assert.match(await annotation.locator('#input-summary').textContent(),/get-consensusから受け取り/);
  const ref=`>A\n${demo.samples[0].sequence}\n>A_tie\n${demo.samples[0].sequence}\n>B\n${demo.samples[1].sequence}\n`;
  const taxonomy='A\tEukaryota;Genus;Species_A\nA_tie\tEukaryota;Genus;Species_B\nB\tEukaryota;Other;Species_C\n';
  await annotation.locator('#reference-mode').selectOption('fasta');
  await annotation.locator('#reference-file').setInputFiles({name:'reference.fa',mimeType:'text/plain',buffer:Buffer.from(ref)});
  await annotation.locator('#taxonomy-file').setInputFiles({name:'reference.path',mimeType:'text/plain',buffer:Buffer.from(taxonomy)});
  await annotation.locator('#options details summary').click();await annotation.locator('input[name=shardBases]').fill('400');
  await annotation.locator('#start').click();await annotation.waitForFunction(()=>!window.napAnnotation.state.busy && window.napAnnotation.result);
  const result=await annotation.evaluate(async()=>({manifest:window.napAnnotation.result.manifest,rows:window.napAnnotation.result.rows,input:await window.napAnnotation.result.files.get('all.cnt.seq.qual.txt').text()}));
  assert.equal(result.input,original,'Handoff retains complete seq/qual/count input bytes');
  assert.equal(result.manifest.execution.referenceVolumes,3);assert.equal(result.manifest.nap.stage,'get-consensus');
  assert.equal(result.manifest.summary.annotated,2);
  assert.deepEqual(result.rows.map(row=>row.annotation.lca).sort(),['Eukaryota;Genus','Eukaryota;Other;Species_C']);
  assert.deepEqual(result.rows.map(row=>row.counts).sort((a,b)=>a[0]-b[0]),[[0,6],[6,0]]);
  assert.equal(await annotation.locator('#progress').evaluate(element=>element.value),1);
  console.log('PASS actual get-consensus WASM -> exact seq.qual.txt handoff -> sharded BLAST WASM -> global LCA and sample counts');
  const event=page.waitForEvent('download');await annotation.locator('#zip').click();await (await event).saveAs(path.join(out,'annotation-results.zip'));
  const archive=unzipSync(await readFile(path.join(out,'annotation-results.zip')));
  assert.equal(strFromU8(archive['all.cnt.seq.qual.txt']),original);
  assert.ok(archive['all.cnt.seq.qual.tax.txt']);assert.ok(archive['all.cnt.seq.qual.tax.sp.txt']);assert.ok(archive['all.cnt.seq.qual.tax.sp.xlsx']);
  const xlsx=unzipSync(archive['all.cnt.seq.qual.tax.sp.xlsx']);assert.match(strFromU8(xlsx['xl/worksheets/sheet1.xml']),/top.taxpath/);
  const saved=path.join(out,'annotation-results.html');await writeFile(saved,archive['annotation-results.html']);
  const offline=await browser.newContext();await offline.setOffline(true);const savedPage=await offline.newPage(),network=[];
  savedPage.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
  await savedPage.goto(pathToFileURL(saved).href);assert.equal(await savedPage.locator('#annotation-results tbody tr').count(),2);
  const links=await savedPage.locator('a[download]').evaluateAll(elements=>elements.map(element=>decodeURIComponent(element.getAttribute('href').slice(2))));
  assert.ok(links.every(link=>Object.hasOwn(archive,link)));assert.deepEqual(network,[]);await offline.close();
  await page.screenshot({path:path.join(out,'annotation-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await annotation.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(out,'annotation-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
  await annotation.locator('#start').click();await annotation.waitForFunction(()=>window.napAnnotation.state.busy);
  assert.equal(await page.locator('#transfer-consensus').isDisabled(),true);
  const overwrite=await annotation.evaluate(()=>{try {window.napAnnotation.setTable(new File([''],'empty.txt'));return false;}catch(error){return /解析中/.test(error.message);}});assert.equal(overwrite,true);
  await annotation.locator('#cancel').click();await annotation.waitForFunction(()=>!window.napAnnotation.state.busy);
  assert.match(await annotation.locator('#status').textContent(),/中止/);
  assert.equal(await annotation.evaluate(()=>window.annotationTestWorkers.size),0,'Coordinator worker receives terminate after cancellation');
  const cdp=await browser.newBrowserCDPSession();let activeWorkers;
  // Chrome may retain debugger metadata for a terminated coordinator. Audit
  // its actual terminate call above and separately check native child targets.
  const deadline=Date.now()+5000;
  do {
    const targets=await cdp.send('Target.getTargets');
    activeWorkers=targets.targetInfos.filter(target=>target.type==='worker' && /get-consensus\/tool-worker/.test(target.url));
    if(!activeWorkers.length)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  } while(Date.now()<deadline);
  assert.deepEqual(activeWorkers,[],'Cancellation terminates analysis and native tool workers');await cdp.detach();
  console.log('PASS annotation ZIP/Excel/offline HTML, valid archive links, mobile layout, active input guard and cancel worker cleanup');
  const folder=path.join(out,'reference-folder');await mkdir(folder,{recursive:true});
  const generated=await annotation.evaluate(async text=>{
    const {ConsensusTools}=await import('../get-consensus/tool-client.mjs');
    const result=await new ConsensusTools().run('makeblastdb',['-in','reference.fa','-out','reference','-dbtype','nucl','-blastdb_version','4'],{files:{'reference.fa':text},outputs:['reference.nhr','reference.nin','reference.nsq']});
    if(result.exitCode!==0)throw Error(result.stderr);
    return Object.entries(result.files).map(([name,bytes])=>({name,bytes:[...bytes]}));
  },ref);
  const spec=(name,bytes)=>({name,url:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  const specs=[];for(const file of generated){const bytes=Buffer.from(file.bytes);await writeFile(path.join(folder,file.name),bytes);specs.push(spec(file.name,bytes));}
  const taxBytes=Buffer.from(taxonomy);await writeFile(path.join(folder,'taxonomy.path'),taxBytes);
  await writeFile(path.join(folder,'manifest.json'),JSON.stringify({format:'nap-blast-v4-shards-1',database:'generated-demo',totalBases:1200,sequences:3,taxonomy:spec('taxonomy.path',taxBytes),shards:[{name:'reference',files:specs}]}));
  await annotation.locator('#reference-mode').selectOption('folder');await annotation.locator('#db-folder').setInputFiles(folder);
  await annotation.locator('#start').click();await annotation.waitForFunction(()=>!window.napAnnotation.state.busy && window.napAnnotation.result);
  assert.deepEqual(await annotation.evaluate(()=>window.napAnnotation.result.rows.map(row=>row.annotation.lca).sort()),['Eukaryota;Genus','Eukaryota;Other;Species_C']);
  assert.equal(await annotation.evaluate(()=>window.napAnnotation.result.manifest.reference.mode),'folder');
  console.log('PASS browser-selected reference DB folder, SHA-256 checks and same taxonomy/count results');
  if(full) {
    await annotation.locator('#table-file').setInputFiles(path.join(root,'test-results/annotation-native/input.txt'));
    await annotation.locator('#reference-mode').selectOption('local');
    await annotation.locator('#start').click();
    const started=Date.now();let last='';
    while(await annotation.evaluate(()=>window.napAnnotation.state.busy)) {
      const status=await annotation.locator('#progress-detail').textContent();
      if(status!==last){console.log(status);last=status;}
      if(Date.now()-started>600000)throw Error('Full annotation timed out');
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    const final=await annotation.evaluate(async()=>window.napAnnotation.result?{manifest:window.napAnnotation.result.manifest,tax:await window.napAnnotation.result.files.get('all.cnt.seq.qual.tax.txt').text(),species:await window.napAnnotation.result.files.get('all.cnt.seq.qual.tax.sp.txt').text()}:null);
    assert.ok(final,await annotation.locator('#status').textContent());
    assert.equal(final.manifest.reference.totalBases,4479942144);assert.equal(final.manifest.reference.sequences,1599178);
    assert.equal(final.manifest.execution.referenceVolumes,36);
    const expected=await readFile(path.join(root,'test-results/annotation-native/all.cnt.seq.qual.tax.txt'),'utf8');
    const expectedSpecies=await readFile(path.join(root,'test-results/annotation-native/all.cnt.seq.qual.tax.sp.txt'),'utf8');
    await writeFile(path.join(out,'full-db.tax.txt'),final.tax);await writeFile(path.join(out,'full-db.tax.sp.txt'),final.species);
    assert.equal(final.tax,expected,'Full browser DB LCA/control/table matches original native script commands');
    assert.equal(final.species,expectedSpecies,'Grouped taxonomy sample counts match native output');
    await writeFile(path.join(out,'full-db.report.json'),JSON.stringify(final.manifest,null,2));
    console.log('PASS full container reference: 1,599,178 sequences / 4,479,942,144 bases / 36 volumes, taxonomy/control/No Hit/grouped counts exactly equal native scripts');
  }
  assert.deepEqual(errors,[]);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
