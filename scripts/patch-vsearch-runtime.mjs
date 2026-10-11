import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// The bundled Emscripten 3.1.64 runtime predates the mailbox shutdown fix.
// Use the runtime's postMessage mailbox fallback without rebuilding native code.
// The upstream fix needs an additional WASM export absent from this binary:
// https://github.com/emscripten-core/emscripten/pull/26692
const file=new URL('../public/get-consensus/wasm/vsearch.mjs',import.meta.url);
const marker='// NAP: use postMessage mailboxes to avoid uncollectable Atomics.waitAsync listeners.\n';
let source=await readFile(file,'utf8');
const originalWait='var __emscripten_thread_mailbox_await=pthread_ptr=>{if(typeof Atomics.waitAsync==="function"){var wait=Atomics.waitAsync(GROWABLE_HEAP_I32(),pthread_ptr>>2,pthread_ptr);wait.value.then(checkMailbox);var waitingAsync=pthread_ptr+128;Atomics.store(GROWABLE_HEAP_I32(),waitingAsync>>2,1)}};';
if(!source.startsWith(marker)) {
  if(source.split(originalWait).length!==2)throw Error('Unexpected VSEARCH runtime. Review the mailbox workaround against the new Emscripten version.');
  source=marker+source.replace(originalWait,'var __emscripten_thread_mailbox_await=pthread_ptr=>{};');
  await writeFile(file,source);
}
const manifestFile=new URL('../public/get-consensus/wasm/manifest.json',import.meta.url);
const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
manifest.files['vsearch.mjs']={bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')};
manifest.runtimePatches={...manifest.runtimePatches,'vsearch.mjs':{script:'scripts/patch-vsearch-runtime.mjs',upstream:'https://github.com/emscripten-core/emscripten/issues/20920',reason:'Use the existing postMessage mailbox fallback instead of infinite Atomics.waitAsync listeners.'}};
await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
console.log('VSEARCH mailbox fallback applied; runtime checksum updated.');
