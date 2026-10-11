import { makeZip } from '../get-consensus/app/zip.mjs';
import { outputBlob, outputTransfers } from './output-blob.mjs';
self.onmessage = async ({ data }) => {
  try { const result = await makeZip(data.files, outputBlob); self.postMessage({ result }, outputTransfers([], result)); }
  catch (error) { self.postMessage({ error: error.message || String(error) }); }
  finally { self.close(); }
};
import './worker-host.mjs';
