import { BlastClient } from './blast-client.mjs';
import { runPipeline } from './demultiplex-pipeline.mjs';

let prepared, diagnostics, blast;
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      let result;
      if (data.type === 'initialize') {
        prepared = data.prepared; diagnostics = data.diagnostics;
        blast = new BlastClient({ onLog: message => postMessage({ type: 'log', text: message.text }) });
        for (const file of data.databases) await blast.writeFile(file.name, file.data);
        result = true;
      } else if (data.type === 'run') {
        result = await runPipeline({ fastqFiles: [data.file], prepared, diagnostics, databaseReady: true, includeReports: false, allowEmpty: true }, blast, message => postMessage(message));
      } else throw new Error(`Unknown file request: ${data.type}`);
      postMessage({ id: data.id, result });
    } catch (error) { postMessage({ id: data.id, error: error.message || String(error) }); }
  });
};
