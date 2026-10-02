import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaults } from '../public/annotation/app/core.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'test-results','annotation-native');await mkdir(out,{recursive:true});
const job=`/tmp/nap-annotation-test-${randomUUID()}`,image='docker.io/c2997108/centos7:2-blast-taxid-2-KronaTools-2.7-pr2-mito-silva-3';
function run(command,args,input) {return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:[input?'pipe':'ignore','inherit','inherit'],shell:false});child.on('error',reject);child.on('close',code=>code?reject(Error(`${command}: ${code}`)):resolve());if(input)child.stdin.end(input);});}
const source=await readFile(path.join(root,'upstream/metagenome-rrna-single-end.sh'),'utf8');
const blastScript=source.split("cat << 'EOS' > run-blast.sh\n")[1]?.split('\nEOS')[0];if(!blastScript)throw Error('Native run-blast.sh extraction failed');
await writeFile(path.join(out,'run-blast.sh'),blastScript+'\n');
const annotation=await readFile(path.join(root,'upstream/annotation-rrna.sh'),'utf8');
const merge=annotation.split('\n').filter(line=>line.startsWith("awk -F'\\t'"));
if(merge.length!==2)throw Error('Native annotation AWK extraction failed');
const finish=`set -euo pipefail
mkdir -p temp-fasta
cp queries.fa.gz temp-fasta/all.cnt.seq.qual.txt.fa.gz
seqkit seq temp-fasta/all.cnt.seq.qual.txt.fa.gz > temp-fasta/all.cnt.seq.qual.txt.fa
bash run-blast.sh temp-fasta/all.cnt.seq.qual.txt.fa.gz 100 1 1 '' 0 90 100
cp temp-fasta/all.cnt.seq.qual.txt.fa.gz.blast.filtered.name.lca temp-fasta.lca
printf '>internalcontrol\\n${defaults.internalControl}\\n' > internalcontrol.fa
makeblastdb -in internalcontrol.fa -dbtype nucl
blastn -outfmt 6 -num_threads 1 -db internalcontrol.fa -query temp-fasta/all.cnt.seq.qual.txt.fa > temp-fasta.control
(cat temp-fasta.lca; awk -F'\\t' '$3>=80&&$4>=60{OFS="\\t"; $1="internal_control\\tinternal_control\\t"$1; print $0}' temp-fasta.control) > temp-fasta.lca.plus.control
input_1=input.txt
${merge.join('\n')}
`;
await writeFile(path.join(out,'finish.sh'),finish);
await run('ssh',['-o','BatchMode=yes','m768',`mkdir ${job}`]);
await run('scp',['-q',path.join(out,'run-blast.sh'),path.join(out,'finish.sh'),`m768:${job}/`]);
const python=`import subprocess,re,json,gzip,os
os.chdir(${JSON.stringify(job)})
p=subprocess.Popen(['podman','run','--rm','--network','none','--entrypoint','blastdbcmd',${JSON.stringify(image)},'-db','/usr/local/blastdb/mergedDB.maskadaptors.fa','-entry','all','-outfmt','%t\\t%s'],stdout=subprocess.PIPE,universal_newlines=True)
records=[]
while len(records)<2:
    line=p.stdout.readline()
    if not line: raise RuntimeError('No reference sequence')
    title,seq=line.strip().split('\\t',1)
    accession=title.split()[0]
    match=re.search('[ACGT]{450}',seq.upper())
    if match: records.append({'id':accession,'seq':match.group(0)})
p.terminate()
control=${JSON.stringify(defaults.internalControl)}
rows=[('native_mito_1',records[0]['seq'],[6,0]),('native_mito_2',records[1]['seq'],[0,6]),('native_control',control,[2,0.5]),('native_no_hit',${JSON.stringify(JSON.parse(await readFile(path.join(root,'public/examples/expected.json'),'utf8')).samples[0].sequence)},[1,0]),('native_short',records[0]['seq'][:90],[0,1])]
with open('input.txt','w') as f:
    f.write('id\\tseq\\tqual\\tA\\tB\\n')
    for name,seq,counts in rows: f.write('\\t'.join([name,seq,'I'*len(seq)]+[str(n) for n in counts])+'\\n')
with gzip.open('queries.fa.gz','wt') as f:
    for name,seq,counts in rows: f.write('>'+name+'\\n'+seq+'\\n')
with open('reference-fixture.json','w') as f: json.dump(records,f)
`;
const quote=value=>`'${value.replace(/'/g,`'"'"'`)}'`;
await run('ssh',['-o','BatchMode=yes','m768','bash','-s'],`set -euo pipefail
python3 - <<'NAP_PY'
${python}
NAP_PY
podman run --rm --network none -v ${quote(job+':/test:Z')} --workdir /test --entrypoint /bin/bash ${quote(image)} -c 'bash finish.sh'
`);
for(const filename of ['input.txt','reference-fixture.json','all.cnt.seq.qual.tax.txt','all.cnt.seq.qual.tax.sp.txt','temp-fasta.lca','temp-fasta.control'])await run('scp',['-q',`m768:${job}/${filename}`,path.join(out,filename)]);
await writeFile(path.join(out,'source.json'),JSON.stringify({image,remote:`m768:${job}`,upstream:'upstream/annotation-rrna.sh and metagenome-rrna-single-end.sh',native:'Actual upstream BLAST/filter/LCA/control/table-merge commands, against the full container database'},null,2));
console.log('Prepared native full-DB expected results from the original script commands.');
