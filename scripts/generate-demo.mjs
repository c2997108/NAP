import { mkdir,writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { reverseComplement } from '../public/split-reads/app/demultiplex-core.mjs';

const directory=new URL('../public/examples/',import.meta.url);await mkdir(directory,{recursive:true});
let seed=20260927;
const dna=length=>Array.from({length},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return 'ACGT'[seed>>>30];}).join('');
const samples=['nap_demo_A','nap_demo_B'].map(name=>({name,forward:dna(40),reverse:dna(40),sequence:dna(400)}));
await writeFile(new URL('primer.fa',directory),samples.map(sample=>`>${sample.name}_F\n${sample.forward}\n>${sample.name}_R\n${sample.reverse}\n`).join(''));
await writeFile(new URL('sample.txt',directory),samples.map(sample=>`${sample.name}\t${sample.name}_F\t${sample.name}_R\t430\t530\n`).join(''));
for(const [index,letter] of ['A','B'].entries()) {
  const records=samples.flatMap(sample=>Array.from({length:3},(_,read)=>{
    const id=`${sample.name}_read${String(index*3+read+1).padStart(3,'0')}`;
    const sequence=sample.forward+sample.sequence+reverseComplement(sample.reverse);
    return `@${id} qs:f:30\n${sequence}\n+\n${'I'.repeat(sequence.length)}\n`;
  })).join('');
  await writeFile(new URL(`raw-${letter}.fastq.gz`,directory),gzipSync(records));
}
await writeFile(new URL('expected.json',directory),JSON.stringify({description:'Entirely synthetic, seeded DNA; 12 input reads -> two FASTQ samples, six reads each',inputReads:12,samples:samples.map(sample=>({name:sample.name,reads:6,sequence:sample.sequence,sha256:createHash('sha256').update(sample.sequence).digest('hex')}))},null,2)+'\n');
console.log('Created synthetic NAP end-to-end demo');
