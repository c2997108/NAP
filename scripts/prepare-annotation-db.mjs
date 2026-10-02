import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const host = process.argv[2] || 'm768';
const image = process.argv[3] || 'docker.io/c2997108/centos7:2-blast-taxid-2-KronaTools-2.7-pr2-mito-silva-3';
const directory = fileURLToPath(new URL('../data/annotation/', import.meta.url));
const job = process.argv[4] || `/tmp/nap-annotation-${randomUUID()}`;
if (!/^\/tmp\/nap-annotation-[a-f0-9-]{36}$/.test(job)) throw Error('Invalid temporary database directory');
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
function run(command, args, { input, output = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', output, 'inherit'], shell: false });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`${command} exited with ${code}`)));
    if (input) child.stdin.end(input);
  });
}
await mkdir(directory, { recursive: true });
const python = `import glob, gzip, hashlib, json, os, re, shutil
root = ${JSON.stringify(job)}
info = open(root+'/info.txt').read()
seqs, bases = re.search(r'([\\d,]+) sequences; ([\\d,]+) total bases', info).groups()
source = json.load(open(root+'/image.json'))[0]
def pack(filename):
    raw = root+'/'+filename
    target = raw+'.gz'
    with open(raw, 'rb') as src, gzip.open(target, 'wb', compresslevel=1) as dst:
        shutil.copyfileobj(src, dst, 1024*1024)
    digest = hashlib.sha256()
    with open(target,'rb') as packed:
        for chunk in iter(lambda:packed.read(1024*1024), b''): digest.update(chunk)
    return {'name':filename, 'url':filename+'.gz', 'compression':'gzip', 'bytes':os.path.getsize(raw), 'sha256':digest.hexdigest()}
shards = []
for index in sorted(glob.glob(root+'/merged*.nin')):
    prefix = os.path.basename(index[:-4])
    shards.append({'name':prefix, 'files':[pack(prefix+suffix) for suffix in ['.nhr','.nin','.nsq']]})
manifest = {'format':'nap-blast-v4-shards-1', 'database':'mergedDB.maskadaptors.fa', 'totalBases':int(bases.replace(',','')), 'sequences':int(seqs.replace(',','')), 'source':{'image':${JSON.stringify(image)}, 'imageId':source.get('Id'), 'info':info}, 'taxonomy':pack('taxonomy.path'), 'shards':shards}
with open(root+'/manifest.json','w') as out: json.dump(manifest,out,ensure_ascii=False,indent=2)
print('Prepared',len(shards),'reference volumes',flush=True)
`;
const container = `set -euo pipefail
ref=/usr/local/blastdb/mergedDB.maskadaptors.fa
blastdbcmd -db "$ref" -info > /nap-db/info.txt
# %a can return BL_ORD_ID:... for an unparsed database. The original subject
# names used by the .path table are in the first token of %t (FASTA title).
blastdbcmd -db "$ref" -entry all -outfmt '%t\t%s' | awk -F'\t' '{split($1,id," "); print ">"id[1]"\\n"$2}' | makeblastdb -dbtype nucl -in - -blastdb_version 4 -out /nap-db/merged -max_file_sz 32MB -title 'NAP mergedDB compact v4'
cp "$ref.path" /nap-db/taxonomy.path
`;
console.log(`Preparing the existing container database on ${host}; temporary directory ${job}`);
await run('ssh', ['-o', 'BatchMode=yes', host, 'bash', '-s'], { input: `set -euo pipefail
mkdir -p ${quote(job)}
${process.argv[4] ? '' : `podman image inspect ${quote(image)} > ${quote(job+'/image.json')}
podman run --rm --network none -v ${quote(job+':/nap-db:Z')} --entrypoint /bin/bash ${quote(image)} -c ${quote(container)}`}
python3 - <<'NAP_PYTHON'
${python}
NAP_PYTHON
` });
// tar receives bytes directly; PowerShell redirection must not transcode them.
await new Promise((resolve, reject) => {
  const remote = spawn('ssh', ['-o', 'BatchMode=yes', host, `cd ${quote(job)} && tar -cf - manifest.json *.gz`], { stdio: ['ignore','pipe','inherit'], shell: false });
  const local = spawn('tar', ['-xf','-','-C',directory], { stdio: ['pipe','inherit','inherit'], shell: false });
  remote.stdout.pipe(local.stdin);
  let a, b;
  const finish = () => { if (a !== undefined && b !== undefined) (a === 0 && b === 0 ? resolve() : reject(Error(`Transfer failed: ssh ${a}, tar ${b}`))); };
  remote.on('error',reject);local.on('error',reject);
  remote.on('close',code=>{a=code;finish();});local.on('close',code=>{b=code;finish();});
});
await writeFile(new URL('../data/annotation/source-location.txt', import.meta.url), `${host}:${job}\n`);
console.log(`Local reference database: ${directory}\nOriginal container data were not modified. Temporary server copies: ${host}:${job}`);
