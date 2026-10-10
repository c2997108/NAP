import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pass concrete paths: directory arguments fail on Node 24, and shell glob
// expansion differs between macOS/Linux and Windows.
const directory = new URL('../tests/', import.meta.url);
const names = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
if (!names.length) throw Error('No unit tests found');
const child = spawn(process.execPath, ['--test', ...names.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
