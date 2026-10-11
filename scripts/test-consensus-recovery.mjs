import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from './serve.mjs';

const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
// Inject one native allocation failure into the combined MAFFT worker. The
// isolated-stage path must then run the real tools with the original arguments.
const workerSource = await readFile(new URL('../public/get-consensus/tool-worker.mjs', import.meta.url), 'utf8');
const injectedSource = workerSource.replace('const { tool, args, ...options } = data;', `const { tool, args, ...options } = data;
    if (tool === 'mafft' && data.__recoveryAudit && Atomics.compareExchange(new Int32Array(data.__recoveryAudit), 0, 0, 1) === 0) {
      throw new Error('MAFFT tbfast exited 1: Allocation error ( 200 double halfmtx )');
    }`);
const server = createServer(), handler = server.listeners('request')[0];
server.removeListener('request', handler);
server.on('request', (req, res) => {
  if (req.url !== '/get-consensus/tool-worker.mjs') return handler(req, res);
  res.writeHead(200, {'Content-Type':'text/javascript','Cache-Control':'no-store','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'});
  res.end(injectedSource);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL || 'chrome';
  browser = await chromium.launch({ channel, headless:true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/get-consensus/`);
  const report = await page.evaluate(async () => {
    const { ConsensusTools } = await import('./tool-client.mjs');
    const { toolScope } = await import('./app/tool-scope.mjs');
    const { haplotypes, phasePositions } = await import('./app/haplotype.mjs');
    const { ConsensusPipeline, validateOptions } = await import('./app/pipeline.mjs');
    const tools = new ConsensusTools(), records = [{id:'a',seq:'ACGTAACGTTTT'},{id:'b',seq:'ACGTAACGTT'},{id:'c',seq:'ACGTAACGTTTT'}];
    const input = records.map(r=>`>${r.id}\n${r.seq}\n`).join('');
    const fast = await tools.align(input), isolated = await tools.align(input, {isolatedStages:true});
    if (fast.stdout !== isolated.stdout) throw Error('Stage isolation changes the alignment');
    const audit = new Int32Array(new SharedArrayBuffer(4)), NativeWorker=globalThis.Worker;
    let active=0,peak=0;
    globalThis.Worker=class extends NativeWorker {
      constructor(...args){super(...args);active++;peak=Math.max(peak,active);this.disposed=false;}
      postMessage(data,...args){super.postMessage({...data,__recoveryAudit:audit.buffer},...args);}
      terminate(){if(!this.disposed){this.disposed=true;active--;}super.terminate();}
    };
    const scope = toolScope(tools, {options:{adjustDirection:false}});
    const recovered = await scope.align(records);
    if (recovered !== fast.stdout || scope.warnings.length !== 1 || audit[0] !== 1 || active !== 0 || peak !== 1) throw Error('Allocation fallback failed or retained a stage worker');
    globalThis.Worker=NativeWorker;
    const ref='A'.repeat(400), seq=alt=>alt ? ref.slice(0,24)+'C'+ref.slice(25,249)+'G'+ref.slice(250) : ref;
    const sam='@HD\tVN:1.6\tSO:unsorted\n@SQ\tSN:ref\tLN:400\n'+Array.from({length:100},(_,i)=>[
      `long.read.${String(i).padStart(4,'0')}`,i>=90?[256,512,1024,2048][i%4]:0,'ref',1,i%3?60:0,'400M','*',0,0,seq(i%2),'I'.repeat(400)
    ].join('\t')+'\n').join('');
    const sorted = await tools.run('samtools',['sort','-@','0','-m','64M','-o','reads.bam','reads.sam'],{files:{'reads.sam':sam},outputs:['reads.bam']});
    if(sorted.exitCode)throw Error(sorted.stderr);
    const indexed = await tools.run('samtools',['faidx','ref.fa'],{files:{'ref.fa':`>ref\n${ref}\n`},outputs:['ref.fa.fai']});
    const variants=[{chrom:'ref',pos:25,ref:'A',alt:'C'},{chrom:'ref',pos:250,ref:'A',alt:'G'}];
    const files={'reads.bam':sorted.files['reads.bam'],'ref.fa':`>ref\n${ref}\n`,'ref.fa.fai':indexed.files['ref.fa.fai']};
    const args=['mpileup','-f','ref.fa','-q','0','-Q','0','-B','-A','-d','60','--output-QNAME'];
    const full=await tools.run('samtools',[...args,'reads.bam'],{files});
    const filtered=await tools.run('samtools',[...args,'-l','variants.positions','reads.bam'],{files:{...files,'variants.positions':phasePositions(variants)}});
    if(full.exitCode || filtered.exitCode)throw Error(full.stderr+filtered.stderr);
    const expected=full.stdout.split('\n').filter(line=>['25','250'].includes(line.split('\t')[1])).join('\n')+'\n';
    if(expected!==filtered.stdout)throw Error('Position filtering changes pileup reads, order or depth');
    const reference=[{id:'ref',seq:ref}], options={minDepth:30};
    const all=haplotypes(sam,variants,reference,{...options,phasePileup:full.stdout});
    const selected=haplotypes(sam,variants,reference,{...options,phasePileup:filtered.stdout});
    if(JSON.stringify(all)!==JSON.stringify(selected) || selected.haplotypes.length!==2)throw Error('Position filtering changes haplotypes');
    const demo=await fetch('../examples/expected.json').then(r=>r.json()),sequences=demo.samples.map(s=>s.sequence);
    const db=await tools.run('makeblastdb',['-in','references.fa','-dbtype','nucl','-blastdb_version','4','-out','db'],{files:{'references.fa':sequences.map((seq,i)=>`>ref${i}\n${seq}\n`).join('')},outputs:null});
    if(db.exitCode)throw Error(db.stderr);
    const dbFiles=Object.fromEntries(Object.entries(db.files).filter(([name])=>name.startsWith('db.')));
    const file=new File([Array.from({length:12},(_,i)=>`@r${i}\n${sequences[i%2]}\n+\n${'I'.repeat(sequences[i%2].length)}\n`).join('')],'reads.fq');
    const optionsBlast=validateOptions({batchSize:12}),job=()=>({file,name:'S',sample:{reads:12,assigned:0},dbFiles});
    const baseline=await new ConsensusPipeline({tools}).searchSample(job(),optionsBlast);
    const limitedTools={run:(tool,args,settings)=>{
      if(tool==='blastn' && [...settings.files['query.fa'].matchAll(/^>/gm)].length>3)throw Error('BLAST ran out of memory');
      return tools.run(tool,args,settings);
    }};
    const recoveredBlast=await new ConsensusPipeline({tools:limitedTools}).searchSample(job(),optionsBlast);
    const hits=async result=>(await Promise.all([...result.local.files].filter(([name])=>name.endsWith('.blastn')).map(([,blob])=>blob.text()))).join('');
    if(await hits(baseline)!==await hits(recoveredBlast) || JSON.stringify([...baseline.counts])!==JSON.stringify([...recoveredBlast.counts]) || recoveredBlast.sample.assigned!==12 || recoveredBlast.local.warnings.length!==3)throw Error('BLAST retry changes hits or counts');
    return {mafft:{sameAlignment:true,recovered:true,warnings:scope.warnings,peakWorkers:peak,remainingWorkers:active},pileup:{fullBytes:full.stdout.length,filteredBytes:filtered.stdout.length,sameRows:true,sameHaplotypes:true,haplotypes:selected.haplotypes.length},blast:{sameHits:true,sameCounts:true,assigned:recoveredBlast.sample.assigned,warnings:recoveredBlast.local.warnings}};
  });
  assert.ok(report.pileup.filteredBytes < report.pileup.fullBytes / 100);
  await writeFile(new URL('consensus-recovery-report.json',output),JSON.stringify({testedAt:new Date().toISOString(),browser:browser.version(),...report},null,2)+'\n');
  console.log('PASS real MAFFT allocation recovery preserves alignment and releases each stage worker');
  console.log(`PASS real samtools restricted pileup preserves reads/depth/haplotypes (${report.pileup.fullBytes} -> ${report.pileup.filteredBytes} bytes)`);
  console.log('PASS real BLAST allocation recovery preserves every hit and count after splitting failed batches');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
