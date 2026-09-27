import { normalizeArguments, filePath } from './arguments.mjs';

const files = new Map();
const binaries = new Map();
const factories = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function load(command) {
  if (!factories.has(command)) {
    const url = new URL(`../../shared/wasm/${command}.mjs`, import.meta.url);
    try {
      const [module, response] = await Promise.all([import(url.href), fetch(new URL(`${command}.wasm`, url))]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      factories.set(command, module.default);
      binaries.set(command, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      throw new Error(`${command} の WASM を読み込めません。NAP の public/shared/wasm の同梱ファイルと配信状態を確認してください。(${error.message})`);
    }
  }
  return factories.get(command);
}

function capture(fs, dir, output) {
  for (const entry of fs.readdir(dir)) {
    if (entry === '.' || entry === '..') continue;
    const path = `${dir}/${entry}`;
    const info = fs.stat(path);
    if (fs.isDir(info.mode)) capture(fs, path, output);
    else if (fs.isFile(info.mode)) output.set(path, fs.readFile(path));
  }
}

async function run(id, command, args) {
  const normalized = normalizeArguments(command, args);
  const factory = await load(command);
  const stdout = [], stderr = [];
  const log = (stream, lines) => text => {
    lines.push(text);
    postMessage({ type: 'log', id, stream, text });
  };
  // NCBI's application singleton and static destructors cannot safely be reused.
  // Each invocation gets a fresh runtime; only /work files survive between commands.
  let exitCode = 0;
  const module = await factory({ wasmBinary: binaries.get(command), noInitialRun: true, thisProgram: `/work/${command}`, onExit: code => { exitCode = code; }, print: log('stdout', stdout), printErr: log('stderr', stderr) });
  module.FS.mkdir('/work');
  module.FS.chdir('/work');
  for (const [name, data] of files) {
    module.FS.mkdirTree(name.slice(0, name.lastIndexOf('/')));
    module.FS.writeFile(name, data);
  }
  const start = performance.now();
  try {
    const status = module.callMain([...normalized]);
    if (Number.isInteger(status)) exitCode = status;
  } catch (error) {
    if (error.name === 'ExitStatus' || Number.isInteger(error.status)) exitCode = error.status;
    else throw new Error(`${command}: ${error.message || error}`);
  }
  // EXIT_RUNTIME may report an exit through quit() without propagating an exception.
  if (Number.isInteger(module.EXITSTATUS)) exitCode = module.EXITSTATUS;
  const saved = new Map();
  capture(module.FS, '/work', saved);
  files.clear();
  for (const [name, data] of saved) files.set(name, data);
  return { command, args: normalized, exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), elapsedMs: performance.now() - start, files: listFiles() };
}

function listFiles() {
  return [...files].map(([path, data]) => ({ name: path.slice(6), path, size: data.byteLength })).sort((a, b) => a.name.localeCompare(b.name));
}

async function handle(message) {
  const { id, type, name, data, encoding, command, args } = message;
  switch (type) {
    case 'writeFile': {
      const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
      files.set(filePath(name), bytes);
      return listFiles();
    }
    case 'readFile': {
      const bytes = files.get(filePath(name));
      if (!bytes) throw new Error(`ファイルがありません: ${name}`);
      return encoding === 'utf8' ? decoder.decode(bytes) : bytes;
    }
    case 'listFiles': return listFiles();
    case 'removeFile': files.delete(filePath(name)); return listFiles();
    case 'run': return run(id, command, args);
    default: throw new Error(`Unknown request: ${type}`);
  }
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try { postMessage({ id: data.id, result: await handle(data) }); }
    catch (error) { postMessage({ id: data.id, error: error.message || String(error) }); }
  });
};
