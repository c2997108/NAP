import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const ignored=new Set(['node_modules','test-results','build','.git','data','results']);
const relative=file=>path.relative(root,file).split(path.sep).join('/');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async name=>JSON.parse(await readFile(path.join(root,name),'utf8'));
async function walk(directory) {
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    assert.ok(!entry.isSymbolicLink(),`Distribution must be self-contained: ${relative(file)}`);
    if(entry.isDirectory()) {
      if(directory===root && ignored.has(entry.name))continue;
      result.push(...await walk(file));
    } else if(entry.isFile()) result.push(file);
  }
  return result;
}
const files=await walk(root),names=new Set(files.map(relative));
const requireFile=name=>assert.ok(names.has(name),`Missing packaged file (case-sensitive): ${name}`);
for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','sources/README.md',
  'licenses/VARSCAN-LICENSE.txt','upstream/LICENSE','upstream/provenance.json',
  'package.json','package-lock.json','.gitignore','.gitattributes','.github/workflows/test.yml',
  'scripts/serve.mjs','scripts/prepare-pages.mjs','scripts/test-integration.mjs','scripts/test-service-worker.mjs','public/index.html','public/nap.mjs',
  'public/bootstrap.mjs','public/isolation.mjs','public/coi-serviceworker.js',
  'public/coi-serviceworker-LICENSE.txt','public/coi-serviceworker.manifest.json',
  'public/nap.css','public/engine.css','public/split-reads/index.html','public/get-consensus/index.html','public/annotation/index.html','public/annotation/app/core.mjs','public/annotation/app/pipeline.mjs',
  'public/shared/wasm/THIRD_PARTY_NOTICES.txt','public/get-consensus/wasm/THIRD_PARTY_NOTICES.txt',
  'public/examples/raw-A.fastq.gz','public/examples/raw-B.fastq.gz','public/examples/primer.fa',
  'public/examples/sample.txt','public/examples/expected.json'])requireFile(name);

requireFile('docs/.nojekyll');
assert.equal((await readFile(path.join(root, 'docs/.nojekyll'))).length, 0);
let pagesFiles = 0;
for (const file of files.filter(file => relative(file).startsWith('public/'))) {
  const name = relative(file), published = 'docs/' + name.slice('public/'.length);
  requireFile(published);
  const [source, copy] = await Promise.all([readFile(file), readFile(path.join(root, published))]);
  assert.equal(digest(copy), digest(source), `Pages copy differs: ${published}. Run npm run prepare:pages.`);
  pagesFiles++;
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/VARSCAN-LICENSE.txt']) {
  requireFile('docs/' + name);
  const [source, copy] = await Promise.all([readFile(path.join(root, name)), readFile(path.join(root, 'docs', name))]);
  assert.equal(digest(copy), digest(source), `Pages license differs: docs/${name}. Run npm run prepare:pages.`);
}

let verified=0;
async function check(file,expected) {
  const name=relative(file);requireFile(name);
  const bytes=await readFile(file);
  if(expected.bytes!==undefined)assert.equal(bytes.length,expected.bytes,`Size: ${name}`);
  assert.equal(digest(bytes),expected.sha256,`SHA-256: ${name}`);verified++;
}
const sharedDirectory=path.join(root,'public/shared/wasm');
const shared=await readJson('public/shared/wasm/manifest.json');
assert.equal(shared.blastVersion,'2.16.0+');assert.equal(shared.emscriptenVersion,'3.1.64');
for(const [name,expected] of Object.entries(shared.files))await check(path.join(sharedDirectory,name),expected);
const consensusDirectory=path.join(root,'public/get-consensus/wasm');
const consensus=await readJson('public/get-consensus/wasm/manifest.json');
for(const [name,expected] of Object.entries({...consensus.files,...consensus.sharedFiles}))await check(path.resolve(consensusDirectory,name),expected);
assert.equal(Object.keys(consensus.sharedFiles).length,4);
for(const [name,expected] of Object.entries(shared.files)) {
  assert.deepEqual(consensus.sharedFiles['../../shared/wasm/'+name],expected);
  assert.ok(!names.has('public/get-consensus/wasm/'+name),'BLAST assets must be shared');
}
await check(path.resolve(consensusDirectory,consensus.source.path),consensus.source);
const vendor=await readJson('public/split-reads/vendor/manifest.json');
await check(path.join(root,'public/split-reads/vendor/fflate.mjs'),vendor);
const vendorSplit=await readFile(path.join(root,'public/split-reads/vendor/fflate.mjs'));
const vendorConsensus=await readFile(path.join(root,'public/get-consensus/vendor/fflate.mjs'));
assert.equal(digest(vendorSplit),digest(vendorConsensus),'Both stages use the same fflate');
for(const prefix of ['split-reads','get-consensus'])requireFile('public/'+prefix+'/vendor/fflate-LICENSE.txt');
const upstream=await readJson('upstream/provenance.json');
for(const [name,expected] of Object.entries(upstream.files))await check(path.join(root,'upstream',name),expected);
const annotationUpstream=await readJson('upstream/annotation-provenance.json');
for(const [name,expected] of Object.entries(annotationUpstream.files))await check(path.join(root,'upstream',name),expected);
const coi=await readJson('public/coi-serviceworker.manifest.json');
assert.equal(coi.version,'0.1.7');assert.equal(coi.license,'MIT');
for(const [name,expected] of Object.entries(coi.files))await check(path.join(root,'public',name),expected);

function checkReference(file,specifier,html=false) {
  if(!specifier.startsWith('.'))return;
  const target=fileURLToPath(new URL(specifier,pathToFileURL(file)));
  let name=relative(target).split(/[?#]/)[0];
  // This optional DB is mounted from ignored data/ by the local server and can
  // also be supplied through the browser folder/FASTA inputs. It is not bundled.
  if(name==='public/annotation/database/manifest.json')return;
  if(!html && specifier.endsWith('/')) {
    assert.ok([...names].some(file=>file.startsWith(name.replace(/\/$/,'')+'/')),`Missing packaged directory (case-sensitive): ${name}`);
    return;
  }
  if(html && (specifier.endsWith('/') || name==='public'))name=name.replace(/\/$/,'')+'/index.html';
  requireFile(name);
}
let references=0;
for(const file of files.filter(file=>relative(file).startsWith('public/'))) {
  const name=relative(file);
  if(name.includes('/wasm/') || name.includes('/vendor/') || !/\.(html|mjs|css)$/.test(name))continue;
  const text=await readFile(file,'utf8');
  const patterns=name.endsWith('.mjs')?
    [/\bfrom\s*['"](\.[^'"]+)['"]/g,/\bimport\s*['"](\.[^'"]+)['"]/g,/new URL\(['"](\.[^'"]+)['"],\s*import\.meta\.url\)/g]:
    name.endsWith('.html')?[/\b(?:src|href|data-nap-app)=["'](\.[^"']+)["']/g]:[/url\(["']?(\.[^\s)'" ]+)["']?\)/g];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)) {
    checkReference(file,match[1],name.endsWith('.html'));references++;
  }
}
const sizes=await Promise.all(files.map(async file=>({name:relative(file),bytes:(await stat(file)).size})));
sizes.sort((a,b)=>b.bytes-a.bytes);
assert.ok(sizes.every(file=>file.bytes<100*1024*1024),'Keep every distributable file below 100 MiB');
const expected=await readJson('public/examples/expected.json');
assert.equal(expected.inputReads,12);assert.equal(expected.samples.length,2);
for(const sample of expected.samples)assert.equal(digest(sample.sequence),sample.sha256);
const pkg=await readJson('package.json'),lock=await readJson('package-lock.json');
assert.equal(pkg.version,lock.version);assert.equal(pkg.name,lock.name);
assert.equal(pkg.devDependencies.playwright,lock.packages['node_modules/playwright'].version);
const report={checkedAt:new Date().toISOString(),files:files.length,verifiedHashes:verified,
  checkedReferences:references,pagesFiles,totalBytes:sizes.reduce((sum,file)=>sum+file.bytes,0),largest:sizes.slice(0,4)};
await mkdir(path.join(root,'test-results'),{recursive:true});
await writeFile(path.join(root,'test-results/package-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`PASS standalone package: ${report.files} files, ${verified} hashes, ${references} relative references, ${pagesFiles} matching Pages assets (${(report.totalBytes/1024/1024).toFixed(1)} MiB)`);
