import { alignMafft } from './mafft.mjs';
const commands = new Set(['vsearch', 'cd-hit', 'cd-hit-est', 'minimap2', 'samtools', 'blastn', 'makeblastdb',
  ...['tbfast','disttbfast','dvtditr','pairlocalalign','dndpre','makedirectionlist','setdirection','f2cl','countlen'].map(name => 'mafft-' + name)]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function safePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) {
    throw new Error(`Invalid virtual file path: ${name}`);
  }
  return '/work/' + name;
}
function oneThread(tool, args) {
  // NCBI --without-mt builds omit -num_threads from the CLI entirely.
  if (tool === 'blastn') {
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-num_threads') {
        if (args[++i] !== '1') throw new Error('BLAST WASM supports one thread');
      } else filtered.push(args[i]);
    }
    return filtered;
  }
  if (tool === 'samtools') {
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-@' || args[i] === '--threads') && args[i + 1] !== '0') throw new Error('samtools WASM requires -@ 0 (synchronous execution)');
      if (/^-@\d|^--threads=/.test(args[i]) && !['-@0','--threads=0'].includes(args[i])) throw new Error('samtools WASM requires -@ 0');
    }
  }
  const flag = tool === 'vsearch' ? '--threads' : '-T';
  const result = [...args];
  if (tool === 'vsearch' || tool.startsWith('cd-hit')) {
    for (let i = 0; i < result.length; i++) {
      if (result[i].startsWith(flag + '=')) {
        if (result[i].slice(flag.length + 1) !== '1') throw new Error(`${tool} WASM supports ${flag} 1`);
      } else if (result[i] === flag && result[i + 1] !== '1') throw new Error(`${tool} WASM supports ${flag} 1`);
    }
    if (!result.some(arg => arg === flag || arg.startsWith(flag + '='))) result.push(flag, '1');
  }
  return result;
}
export async function callTool(tool, args, { files = {}, stdin = '', outputs = null } = {}) {
  if (!commands.has(tool)) throw new Error(`Unknown tool: ${tool}`);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('CLI arguments must be strings');
  const checkedArgs = oneThread(tool, args);
  if (tool === 'vsearch' && !globalThis.crossOriginIsolated) throw new Error('VSEARCH requires cross-origin isolation and SharedArrayBuffer. Open NAP over HTTPS or with npm start.');
  const directory = ['blastn','makeblastdb'].includes(tool) ? '../shared/wasm/' : './wasm/';
  const url = new URL(`${directory}${tool}.mjs`, import.meta.url);
  const { default: createTool } = await import(url.href);
  const input = typeof stdin === 'string' ? encoder.encode(stdin) : stdin;
  const stdout = [], stderr = [];
  let inputIndex = 0;
  let instance;
  try {
    instance = await createTool({ noInitialRun: true,
      locateFile: name => new URL(directory + name, import.meta.url).href,
      mainScriptUrlOrBlob: url.href,
      preRun: [module => {
        module.FS.init(() => inputIndex < input.length ? input[inputIndex++] : null,
          byte => stdout.push(byte), byte => stderr.push(byte));
        module.FS.mkdir('/work'); module.FS.chdir('/work');
        // MAFFT rewinds stdin between length counting and sequence parsing.
        // FD 0 must therefore point to a seekable MEMFS file, not a TTY callback.
        module.FS.writeFile('/stdin-input', input);
        module.FS.close(module.FS.getStream(0));
        module.FS.open('/stdin-input', 'r');
        for (const [name, content] of Object.entries(files)) {
          const file = safePath(name);
          module.FS.mkdirTree(file.slice(0, file.lastIndexOf('/')));
          module.FS.writeFile(file, typeof content === 'string' ? encoder.encode(content) : content);
        }
      }], print: line => stdout.push(...encoder.encode(line + '\n')),
      printErr: line => stderr.push(...encoder.encode(line + '\n')) });
    let exitCode = 0;
    try { exitCode = instance.callMain(checkedArgs) ?? 0; }
    catch (error) {
      if (typeof error?.status === 'number') exitCode = error.status;
      else throw error;
    }
    const resultFiles = {};
    function walk(directory, prefix = '') {
      for (const entry of instance.FS.readdir(directory)) {
        if (entry === '.' || entry === '..') continue;
        const full = directory + '/' + entry, name = prefix + entry;
        if (instance.FS.isDir(instance.FS.stat(full).mode)) walk(full, name + '/');
        else resultFiles[name] = instance.FS.readFile(full).slice();
      }
    }
    if (outputs === null) walk('/work');
    else for (const name of outputs) {
      const file = safePath(name);
      if (instance.FS.analyzePath(file).exists) resultFiles[name] = instance.FS.readFile(file).slice();
    }
    return { exitCode, stdout: decoder.decode(Uint8Array.from(stdout)), stderr: decoder.decode(Uint8Array.from(stderr)), files: resultFiles };
  } finally { instance?.PThread?.terminateAllThreads(); }
}
self.onmessage = async ({ data }) => {
  try {
    const { tool, args, ...options } = data;
    const result = tool === 'mafft'
      ? await alignMafft(options.stdin, args, callTool, (command, detail) => self.postMessage({ progress: detail || command }))
      : await callTool(tool, args, options);
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error.stack || error.message || String(error) }); }
};
