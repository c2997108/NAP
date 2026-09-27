// A command-line parser, with quoting but without shell expansion or execution.
export function parseCommandLine(text) {
  const words = [];
  let value = '', quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") {
      if (++i >= text.length) throw new Error('末尾のバックスラッシュの後に文字が必要です。');
      value += text[i]; started = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else value += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started) { words.push(value); value = ''; started = false; }
    } else {
      value += ch; started = true;
    }
  }
  if (quote) throw new Error('引用符が閉じられていません。');
  if (started) words.push(value);
  return words;
}

export function normalizeArguments(command, args) {
  if (!['makeblastdb', 'blastn'].includes(command)) throw new Error('実行可能なコマンドは makeblastdb と blastn です。');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('引数には文字列の配列を指定してください。');
  const normalized = [...args];
  if (normalized.includes('-remote')) throw new Error('ブラウザ内実行では -remote は使用できません。');
  const help = normalized.some(arg => ['-h', '-help', '-version'].includes(arg));
  if (command === 'makeblastdb' && !help) {
    const index = normalized.indexOf('-blastdb_version');
    if (index >= 0 && normalized[index + 1] !== '4') throw new Error('このビルドは BLAST DB v4 を使用します。-blastdb_version 4 を指定してください。');
    if (index < 0) normalized.push('-blastdb_version', '4');
  }
  const threads = normalized.indexOf('-num_threads');
  if (threads >= 0 && normalized[threads + 1] !== '1') throw new Error('このビルドはシングルスレッドです。-num_threads 1 を指定してください。');
  // NCBI omits this CLI option entirely in builds configured without MT.
  if (threads >= 0) normalized.splice(threads, 2);
  return normalized;
}

export function filePath(name) {
  if (typeof name !== 'string') throw new Error('ファイル名が必要です。');
  const path = name.startsWith('/work/') ? name : `/work/${name}`;
  const parts = path.slice(6).split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\0\\]/.test(part))) throw new Error('ファイルは /work 内の有効なパスで指定してください。');
  return path;
}
