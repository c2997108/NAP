/** Port of the DNA alignment paths in MAFFT 7.525's mafft.tmpl shell driver.
 * MAFFT Copyright (c) 2009 Kazutaka Katoh. BSD notice: wasm/THIRD_PARTY_NOTICES.txt.
 */
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function options(args) {
  const settings = { auto: false, pair: 'ktuples', retree: 2, iterate: 0, direction: 0, reorder: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--auto') settings.auto = true;
    else if (flag === '--localpair') settings.pair = 'local';
    else if (flag === '--globalpair') settings.pair = 'global';
    else if (flag === '--adjustdirection') settings.direction = 1;
    else if (flag === '--adjustdirectionaccurately') settings.direction = 2;
    else if (flag === '--reorder') settings.reorder = true;
    else if (flag === '--inputorder') settings.reorder = false;
    else if (flag === '--nuc') settings.nuc = true;
    else if (flag === '--quiet') { /* Logs are returned separately from FASTA stdout. */ }
    else if (flag === '--thread') {
      if (!['0','1'].includes(args[++i])) throw new Error('MAFFT WASM supports --thread 0 or 1');
    } else if (flag === '--retree' || flag === '--maxiterate') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0 || (flag === '--retree' && ![1,2].includes(value))) throw new Error(`Invalid ${flag}`);
      settings[flag === '--retree' ? 'retree' : 'iterate'] = value;
    } else throw new Error(`Unsupported MAFFT option: ${flag}`);
  }
  settings.iterate = Math.min(settings.iterate, 16); // upstream shell driver caps refinement at 16
  return settings;
}
function validate(fasta) {
  if (typeof fasta !== 'string') fasta = decoder.decode(fasta);
  const records = [];
  for (const line of fasta.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('>')) records.push({ header: line.slice(1), sequence: '' });
    else if (line.trim()) {
      if (!records.length) throw new Error('Input must be FASTA');
      records.at(-1).sequence += line.replace(/\s/g, '');
    }
  }
  if (!records.length || records.some(r => !r.sequence || !/^[ACGTURYSWKMBDHVNacgturyswkmbdhvn-]+$/.test(r.sequence))) throw new Error('Expected nonempty DNA/RNA FASTA sequences');
  return records.map(r => '>' + r.header + '\n' + r.sequence + '\n').join('');
}
export async function alignMafft(input, args, run, progress = () => {}) {
  const config = options(args);
  const fasta = validate(input);
  let files = { infile: encoder.encode(fasta), 'hat3.seed': encoder.encode('') };
  const logs = [];
  let completed = 0, total;
  const report = command => progress(command, { command, completedSteps: completed, totalSteps: total, fraction: total ? completed / total : 0 });
  async function stage(command, argv, stdin = 'infile') {
    report(command);
    const result = await run('mafft-' + command, argv, { files, stdin: files[stdin] || '', outputs: null });
    logs.push(result.stderr);
    if (result.exitCode) throw new Error(`MAFFT ${command} exited ${result.exitCode}: ${result.stderr}`);
    files = result.files;
    completed++; report(command);
    return result.stdout;
  }
  const size = await stage('countlen', []);
  const match = size.match(/^(\d+) x (\d+) - (\d+)/);
  if (!match) throw new Error('MAFFT could not inspect the input');
  const count = Number(match[1]), maxLength = Number(match[2]);
  if (count >= 20000) throw new Error('This MAFFT wrapper supports fewer than 20000 sequences (large/PartTree modes are not ported).');
  if (config.auto) {
    if (maxLength < 3000 && count < 100) Object.assign(config, { pair: 'local', iterate: 16, retree: 1 });
    else if (maxLength < 1000 && count < 200) Object.assign(config, { pair: 'local', iterate: 2, retree: 1 });
    else if (maxLength < 10000 && count < 500) Object.assign(config, { pair: 'ktuples', iterate: 2, retree: 2 });
    else Object.assign(config, { pair: 'ktuples', iterate: 0, retree: 2 });
  }
  total = 3 + (config.direction ? 2 : 0) + (config.iterate ? 1 : 0) + (config.pair === 'ktuples' && config.iterate ? 1 : 0);
  report('countlen');
  if (config.direction) {
    const directions = await stage('makedirectionlist', ['-C','0','-m','-I','0','-i','infile','-t','0.00','-r',config.direction === 2 ? '5000' : '100','-o','a', ...(config.direction === 1 ? ['-d'] : [])]);
    files._direction = encoder.encode(directions);
    const directed = await stage('setdirection', ['-d','_direction','-i','infile']);
    files.infile = encoder.encode(directed);
  }
  const model = [...(config.nuc ? ['-D'] : []), '-b','62'];
  const common = ['-W','0.00001','-V','-1.53','-s','0.0','-O','-C','0',...model,'-f','-1.53','-Q','100.0','-h','0','-F'];
  const local = config.pair === 'ktuples' ? [] : ['-l','2.7'];
  const tree = ['-X','0.1'];
  if (config.pair !== 'ktuples') {
    // tbfast performs pairwise calculation internally, producing hat2/hat3/pre.
    const pair = ['_','-u','0.0',...local,'-C','0',...model,'-g','-0.100','-f','-2.00','-Q','100.0','-h','0.1', config.pair === 'global' ? '-A' : '-L',
      '_','-+',String(config.iterate),...common,...local,...tree];
    if (config.pair === 'global') pair[pair.indexOf('-0.100')] = '-0.10';
    await stage('tbfast', pair);
  } else {
    const text = await stage('disttbfast', ['-q','0','-E',String(config.retree),'-V','-1.53','-s','0.0','-W','6','-O','-C','0-0',...model,'-g','0.0','-f','-1.53','-Q','100.0','-h','0','-F',...tree,'-x','100']);
    files.pre = encoder.encode(text);
    files.hat3 = files['hat3.seed'];
    if (config.iterate) await stage('dndpre', ['-y','hat2',...model,'-M','2','-C','0'], 'pre');
  }
  if (config.iterate) {
    await stage('dvtditr', ['-W','0.00001','-E','0.0','-s','0.0','-C','0','-t','0','-F',...local,'-z','50',...model,'-f','-1.53','-Q','100.0','-h','0','-I',String(config.iterate),...tree,'-p','BAATARI2','-K','0'], 'pre');
  }
  const stdout = await stage('f2cl', ['-n','-1','-f','-l','60', ...(config.reorder ? ['-r','order'] : [])], 'pre');
  return { exitCode: 0, stdout, stderr: logs.join(''), files: { 'alignment.fa': encoder.encode(stdout) }, strategy: config.pair, iterations: config.iterate };
}
