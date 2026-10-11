import test from 'node:test';
import assert from 'node:assert/strict';
import {outputBlob,asBlob,outputBlobs,outputTransfers,receivedOutputBlobs} from '../public/shared/output-blob.mjs';
import {resultBytes} from '../public/shared/result-memory.mjs';
import {makeZip} from '../public/get-consensus/app/zip.mjs';
import {unzipSync} from '../public/split-reads/vendor/fflate.mjs';

test('page outputs remain downloadable Blobs with binary views, UTF-8 and MIME types preserved',async()=>{
  const bytes=new Uint8Array([0,1,2,255]),blob=outputBlob(['配列\n',bytes.subarray(1,3)],{type:'application/octet-stream'});
  bytes.fill(9);
  assert.ok(blob instanceof Blob);assert.equal(blob.type,'application/octet-stream');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array([...new TextEncoder().encode('配列\n'),1,2]));
  assert.equal(asBlob(blob),blob);
});

test('nested worker outputs transfer once, detach sender buffers and preserve every saved byte and file size',async t=>{
  const original=globalThis.WorkerGlobalScope;
  globalThis.WorkerGlobalScope=class{static [Symbol.hasInstance](value){return value===globalThis;}};
  t.after(()=>{if(original===undefined)delete globalThis.WorkerGlobalScope;else globalThis.WorkerGlobalScope=original;});
  const bytes=new Uint8Array([0,65,66,0]),a=outputBlob(['配列\n',new DataView(bytes.buffer,1,2)],{type:'text/plain;charset=utf-8'});
  bytes.fill(9);
  const combined=outputBlob([a,a,'\n']),files=new Map([['a',a],['combined',combined]]);
  assert.equal(receivedOutputBlobs(files),files,'A coordinator keeps byte parts without recreating worker Blobs');
  assert.equal(resultBytes(files),a.size+combined.size);
  const transfers=outputTransfers(files);assert.equal(transfers.length,3,'Shared parts are transferred only once');
  const received=structuredClone(files,{transfer:transfers});
  assert.ok(transfers.every(buffer=>buffer.byteLength===0),'Transferred data no longer occupies the sending worker');
  const saved=outputBlobs(received);assert.equal(await saved.get('a').text(),'配列\nAB');
  assert.equal(saved.get('a').type,'text/plain;charset=utf-8');assert.equal(await saved.get('combined').text(),'配列\nAB配列\nAB\n');
  assert.equal(resultBytes(saved),resultBytes(received));
  const archive=await makeZip([...received].map(([name,blob])=>({name,blob})),outputBlob);
  const unpacked=unzipSync(new Uint8Array(await asBlob(archive).arrayBuffer()));
  for(const [name,blob] of saved)assert.deepEqual(unpacked[name],new Uint8Array(await blob.arrayBuffer()),'Worker ZIP creation preserves binary and UTF-8 data');
});
