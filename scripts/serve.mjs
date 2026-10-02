import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.json':'application/json','.txt':'text/plain; charset=utf-8','.fa':'text/plain; charset=utf-8','.fastq':'text/plain; charset=utf-8','.gz':'application/gzip'};
const headers={
  'Cross-Origin-Opener-Policy':'same-origin',
  'Cross-Origin-Embedder-Policy':'require-corp',
  'Cross-Origin-Resource-Policy':'same-origin',
  'X-Content-Type-Options':'nosniff',
  'Cache-Control':'no-cache',
};
export function createServer() {
  return http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{...headers,Allow:'GET, HEAD'}).end();return;}
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const requested=pathname.endsWith('/')?pathname+'index.html':pathname;
      const annotationPrefix='/annotation/database/';
      const servedRoot=requested.startsWith(annotationPrefix)?fileURLToPath(new URL('../data/annotation/',import.meta.url)):publicRoot;
      const relative=requested.startsWith(annotationPrefix)?requested.slice(annotationPrefix.length):'.'+requested;
      const target=path.resolve(servedRoot,relative);
      if(!target.startsWith(path.resolve(servedRoot)+path.sep)) {res.writeHead(403,headers).end('Forbidden');return;}
      const info=await stat(target);
      if(info.isDirectory()) {res.writeHead(302,{...headers,Location:pathname+'/'}).end();return;}
      if(!info.isFile())throw Error('Not a file');
      res.writeHead(200,{...headers,'Content-Type':types[path.extname(target)]||'application/octet-stream','Content-Length':info.size});
      if(req.method==='HEAD')res.end();else await pipeline(createReadStream(target),res);
    } catch(error) {if(!res.headersSent)res.writeHead(404,headers);if(!res.destroyed)res.end('Not found');}
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||8002);
  const server=createServer();
  server.on('error',error=>{console.error(`NAP: ${error.message}`);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`NAP: http://localhost:${port}/`));
}
