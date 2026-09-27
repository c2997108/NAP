import { ConsensusTools } from '../tool-client.mjs';
import { readFastq,fasta,fastq,parseFasta,parseUc,consensus,decode,sampleName,safeName,compare } from './sequence.mjs';
import { qualityClusters } from './qcluster.mjs';
import { callVariants,vcf } from './variants.mjs';
import { haplotypes } from './haplotype.mjs';
import { mapParallel } from './parallel.mjs';
import { ConsensusProgress } from './progress.mjs';
export const defaults={firstIdentity:.97,minReads:3,maxReads:30,secondIdentity:.99,allIdentity:1,blastIdentity:.9,minBitscore:200,minDepth:30,batchSize:300,parallelSamples:8,strand:'plus',adjustDirection:false,haplotypes:true};
export function validateOptions(options={}) {
  const o={...defaults,...options};
  for(const key of ['firstIdentity','secondIdentity','blastIdentity']) if(!Number.isFinite(o[key]) || o[key]<=0 || o[key]>1) throw new Error(`${key}: 0 より大きく 1 以下にしてください。`);
  if(!Number.isFinite(o.allIdentity) || o.allIdentity<.4 || o.allIdentity>1) throw new Error('CD-HIT の閾値は 0.4〜1 です。');
  for(const key of ['minReads','maxReads','minDepth','batchSize','parallelSamples']) if(!Number.isInteger(o[key]) || o[key]<1) throw new Error(`${key}: 正の整数にしてください。`);
  if(o.maxReads>=20000) throw new Error('MAFFT に用いるリード数は 20000 未満にしてください。');
  if(!Number.isFinite(o.minBitscore) || o.minBitscore<0) throw new Error('Bitscore は 0 以上にしてください。');
  if(!['plus','both'].includes(o.strand)) throw new Error('strand が不正です。');
  return o;
}
export function blastCounts(text,{blastIdentity=.9,minBitscore=200}={}) {
  const queries=new Map(),counts=new Map();
  for(const line of text.trim().split('\n')) {
    if(!line) continue;
    const f=line.split('\t'); if(f.length<14) throw new Error('BLAST 出力が不正です。');
    const bit=Number(f[13]),row={subject:f[1],length:Number(f[3]),identity:Number(f[4]),bit};
    if(!queries.has(f[0])) queries.set(f[0],{bit,rows:[row]});
    else {const q=queries.get(f[0]); if(bit>q.bit) {q.bit=bit;q.rows=[row];} else if(bit===q.bit) q.rows.push(row);}
  }
  let assigned=0;
  for(const {rows} of queries.values()) {
    const valid=rows.filter(r=>r.identity>=blastIdentity*100 && r.bit>=minBitscore); if(!valid.length) continue;
    const shortest=Math.min(...valid.map(r=>r.length)),ties=valid.filter(r=>r.length===shortest);
    for(const hit of ties) counts.set(hit.subject,(counts.get(hit.subject)||0)+1/ties.length);
    assigned++;
  }
  return {counts,assigned};
}
export class ConsensusPipeline {
  constructor({tools=new ConsensusTools(),onProgress=()=>{}}={}) {this.tools=tools;this.onProgress=onProgress;}
  async run(inputFiles,options={},signal) {
    const o=validateOptions(options),samples=[],entries=[];
    const started=new Date().toISOString(); let commands=0, ties=0;
    let parallel, tracker;
    const concurrency={limit:Math.min(o.parallelSamples,inputFiles?.length||0),samplePeak:0,blastPeak:0};
    // Each sample owns its outputs and logs; merge in input order after the
    // barrier so worker completion order never changes consensus selection.
    const scope=(label='',signal)=>{
      const files=new Map(),logs=[],warnings=[];
      const save=(name,data)=>files.set(name,new Blob([data]));
      const emit=message=>{signal?.throwIfAborted();this.onProgress({message:label?`[${label}] ${message}`:message,commands,parallel,...tracker?.snapshot()});};
      const warn=message=>{warnings.push(message);emit(message);};
      const run=async(tool,args,settings={})=>{
        signal?.throwIfAborted(); commands++; emit(`${tool}: ${args.slice(0,5).join(' ')}`);
        const result=await this.tools.run(tool,args,{...settings,signal});
        logs.push(`${label?`[${label}] `:''}$ ${tool} ${args.join(' ')}\n${result.stderr}\n`);
        if(result.exitCode) throw new Error(`${label?`${label}: `:''}${tool} が終了コード ${result.exitCode} で失敗しました。\n${result.stderr.slice(-4000)}`);
        return result;
      };
      const align=async(records,onProgress=()=>{})=>{
        signal?.throwIfAborted();commands++;emit(`MAFFT: ${records.length} 配列をアラインメント`);
        const result=await this.tools.align(fasta(records),{args:[...(o.adjustDirection?['--adjustdirection']:[]),'--auto'],signal,onProgress:step=>{
          if(typeof step.fraction==='number') {onProgress(step);emit(`MAFFT ${step.command}: ${step.completedSteps} / ${step.totalSteps??'?'} 段階完了`);}
        }});
        logs.push(`${label?`[${label}] `:''}$ mafft --auto (${records.length} sequences)\n${result.stderr}\n`);
        if(result.exitCode) throw new Error(`${label?`${label}: `:''}MAFFT に失敗しました。`);
        return result.stdout;
      };
      return {files,logs,warnings,save,emit,warn,run,align};
    };
    const global=scope('',signal),{files,logs,warnings,save,emit,run,align}=global;
    const merge=local=>{for(const [name,data] of local.files) files.set(name,data);logs.push(...local.logs);warnings.push(...local.warnings);};
    if(!inputFiles?.length) throw new Error('FASTQ ファイルを選択してください。');
    const usedNames=new Set();
    const jobs=Array.from(inputFiles,(file,sampleIndex)=>{
      let name=safeName(sampleName(file.name)) || `sample${sampleIndex+1}`,base=name,counter=2;
      while(usedNames.has(name)) name=`${base}_${counter++}`; usedNames.add(name);
      return {file,name};
    });
    tracker=new ConsensusProgress(jobs);
    const progress=(phase,list,metric)=>state=>{
      parallel={phase,activeSamples:state.active.map(i=>list[i].name),completed:state.completed,total:state.total,limit:state.limit};
      concurrency[metric]=Math.max(concurrency[metric],state.active.length);
      emit(`${phase}: ${state.completed} / ${state.total} サンプル完了（同時実行上限 ${state.limit}）`);
    };
    emit(`${jobs.length} FASTQ を最大 ${concurrency.limit} サンプルずつ並列実行`);
    const processed=await mapParallel(jobs,o.parallelSamples,async({file,name},sampleIndex,signal)=>{
      const local=scope(name,signal),{save,emit,warn,run,align}=local,entries=[];
      const step=(stage,fraction,detail='',extra={})=>{tracker.update(name,stage,fraction,detail,extra);emit(`${file.name}: ${detail}`);};
      let ties=0;
      step('reading',0,'FASTQを読み込み');
      const reads=await readFastq(file,{signal,onProgress:p=>step('reading',p.fraction,`${p.reads.toLocaleString()} reads 読み込み`)});
      step('reading',1,`${reads.length.toLocaleString()} reads 読み込み完了`,{totalReads:reads.length});
      const sample={name,filename:file.name,reads:reads.length,round1:0,round2:0,haplotypes:0,assigned:0};
      const work=`work/${name}`,byId=new Map(reads.map(r=>[r.id,r]));
      let clusters;
      step('clustering',0,'初回クラスタリング');
      // The shell detects any qs:f: tag, including malformed tags. Missing or
      // malformed numeric tags must then be skipped instead of legacy fallback.
      if(reads.some(r=>/(?:^|\s)qs:f:/.test(r.header))) {
        const report=await qualityClusters(reads,name,o.minReads,run,emit,(path,data)=>save(`${work}/iterative_qbin_vsearch/${path}`,data),p=>step('clustering',p.fraction,`品質別 ${p.iteration}/${p.iterations} 回目: ${p.processedReads}/${p.stageReads} reads 処理済み`));
        clusters=report.groups; Object.assign(sample,{clusterMode:'quality',skipped:report.skipped,leftover:report.leftover});
      } else {
        const result=await run('vsearch',['--cluster_fast','reads.fq','--id',String(o.firstIdentity),'--strand',o.strand,'--centroids','centers.fa','--uc','clusters.uc'],{files:{'reads.fq':fastq(reads)},outputs:['centers.fa','clusters.uc']});
        save(`${work}/vsearch-clusters.uc`,result.files['clusters.uc']); save(`${work}/vsearch-center.fasta`,result.files['centers.fa']);
        clusters=parseUc(result.files['clusters.uc']).filter(g=>g.members.length>=o.minReads).map(g=>({id:g.id,members:g.members.map(id=>byId.get(id))}));
        sample.clusterMode='legacy'; sample.leftover=reads.length-clusters.reduce((n,g)=>n+g.members.length,0);
      }
      sample.round1=clusters.length;
      step('clustering',1,`${clusters.length} クラスターを検出`,{totalClusters:clusters.length});
      if(!clusters.length) {warn(`${file.name}: ${o.minReads} reads 以上のクラスターがありません。BLAST 集計には使用します。`);step('analysed',1,'サンプル解析完了・BLAST待ち');sample.input=reads;return {local,sample,entries,ties};}
      // File glob ordering in the shell determines round1 input order.
      clusters.sort((a,b)=>compare(`cluster${a.id}_${a.members.length}reads`,`cluster${b.id}_${b.members.length}reads`));
      const first=[];
      for(const [clusterIndex,cluster] of clusters.entries()) {
        const clusterId=`cluster${cluster.id}_${cluster.members.length}reads`, subset=cluster.members.slice(0,o.maxReads);
        save(`${work}/${clusterId}.fasta`,fasta(cluster.members));
        const alignmentProgress=offset=>p=>step('aligning',(clusterIndex*2+offset+p.fraction)/(clusters.length*2),`クラスター ${clusterIndex+1}/${clusters.length} · MAFFT ${p.command} ${p.completedSteps}/${p.totalSteps??'?'}`);
        const msa=await align(subset,alignmentProgress(0)),id=`consensus_${safeName(file.name)}_${clusterId}`,c=consensus(msa,id); ties+=c.ties;
        const withConsensus=await align([c,...subset],alignmentProgress(1));
        first.push({...c,count:cluster.members.length,alignment:withConsensus});
        save(`${work}/round1/${safeName(file.name)}_${clusterId}.fasta`,fasta([c]));
        save(`${work}/round1/${safeName(file.name)}_${clusterId}.fasta.mafft`,withConsensus);
        step('aligning',(clusterIndex+1)/clusters.length,`${clusterIndex+1}/${clusters.length} クラスター完了`,{completedClusters:clusterIndex+1});
      }
      const firstMap=new Map(first.map(r=>[r.id,r]));
      step('merging',0,'クラスターを統合');
      const merged=await run('vsearch',['--notrunclabels','--cluster_fast','first.fa','--id',String(o.secondIdentity),'--strand',o.strand,'--centroids','centers.fa','--uc','clusters.uc'],{files:{'first.fa':fasta(first)},outputs:['centers.fa','clusters.uc']});
      save(`${work}/round2/vsearch-clusters.uc`,merged.files['clusters.uc']);
      const second=parseUc(merged.files['clusters.uc']).map(g=>{
        const members=g.members.map(id=>firstMap.get(id));
        // AWK @val_num_desc: choose the largest round1 read count; lexical
        // order settles ties that were implementation-dependent upstream.
        const representative=[...members].sort((a,b)=>b.count-a.count || compare(a.id,b.id))[0];
        return {members,representative,count:members.reduce((n,r)=>n+r.count,0)};
      }).sort((a,b)=>b.count-a.count || compare(a.representative.id,b.representative.id));
      const references=second.map((g,i)=>{
        const c={...g.representative,id:`${name}_cluster${i+1}_${g.count}reads`,count:g.count,sample:name,type:'cluster'};
        c.alignment=c.alignment.replace(/^>consensus_.*$/m,'>consensus'); return c;
      });
      sample.round2=references.length; entries.push(...references);
      for(const c of references) {save(`output-consensus-alignments/${c.id}.fasta.mafft`,c.alignment);save(`output-consensus-fastq/${c.id}.fq`,fastq([c]));}
      step('merging',1,`${references.length} コンセンサスへ統合完了`);
      if(o.haplotypes) {
        step('mapping',0,'リードをコンセンサスにマッピング');
        const ref=fasta(references),mapping=await run('minimap2',['-ax','map-ont','-t','1','ref.fa','reads.fq'],{files:{'ref.fa':ref,'reads.fq':fastq(reads)}});
        step('mapping',.2,'マッピング完了・BAMをソート');
        const sorted=await run('samtools',['sort','-@','0','-m','64M','-o','reads.bam','reads.sam'],{files:{'reads.sam':mapping.stdout},outputs:['reads.bam']});
        step('mapping',.35,'BAMのソート完了');
        const bam=sorted.files['reads.bam'];
        if(!bam?.length) throw new Error('samtools が BAM を生成しませんでした。');
        const indexed=await run('samtools',['index','reads.bam'],{files:{'reads.bam':bam},outputs:['reads.bam.bai']});
        step('mapping',.45,'BAMインデックス完了');
        const faidx=await run('samtools',['faidx','ref.fa'],{files:{'ref.fa':ref},outputs:['ref.fa.fai']});
        step('mapping',.5,'参照インデックス完了');
        const shared={'reads.bam':bam,'reads.bam.bai':indexed.files['reads.bam.bai'],'ref.fa':ref,'ref.fa.fai':faidx.files['ref.fa.fai']};
        const pileup=await run('samtools',['mpileup','-f','ref.fa','-q','10','-Q','13','-B','reads.bam'],{files:shared});
        step('mapping',.65,'pileup完了・変異を判定');
        save(`${work}/round3.fa`,ref);save(`${work}/round3.bam`,bam);save(`${work}/round3.bam.bai`,indexed.files['reads.bam.bai']);save(`${work}/round3.fa.fai`,faidx.files['ref.fa.fai']);save(`${work}/round3.mpileup`,pileup.stdout);
        const called=callVariants(pileup.stdout,{minDepth:o.minDepth});
        save(`${work}/round3.snp.vcf`,vcf(called.snps));save(`${work}/round3.indel.vcf`,vcf(called.indels));save(`${work}/round3.dp.vcf`,vcf(called.variants));
        sample.variants=called.variants.length;
        step('mapping',.75,`${called.variants.length} 変異を判定`);
        if(called.variants.length) {
          const sam=await run('samtools',['view','-h','reads.bam'],{files:shared});
          step('mapping',.8,'ハプロタイプ用SAM生成完了');
          const phase=await run('samtools',['mpileup','-f','ref.fa','-q','0','-Q','0','-B','-A','-d','8000','--output-QNAME','reads.bam'],{files:shared});
          step('mapping',.85,'ハプロタイプ用pileup完了');
          const haps=haplotypes(sam.stdout,called.variants,references,{minDepth:o.minDepth,phasePileup:phase.stdout});
          save(`${work}/round3-haplotypes.debug.json`,JSON.stringify(haps.debug,null,2));
          save(`${work}/round3-haplotypes.tsv`,'contig\thaplotype\tread_count\tfrequency\n'+haps.haplotypes.map(h=>`${h.chrom}\t${h.hap}\t${h.count}\t${h.freq.toFixed(6)}\n`).join(''));
          save(`${work}/round3-haplotypes.fasta`,fasta(haps.haplotypes,60));
          step('mapping',.88,`${haps.haplotypes.length} ハプロタイプを検出`);
          for(const [hapIndex,h] of haps.haplotypes.entries()) {
            save(`${work}/haplotypes/${h.id}.fastq`,fastq(h.members));
            const hapProgress=offset=>p=>step('mapping',.88+.12*(hapIndex*2+offset+p.fraction)/(haps.haplotypes.length*2),`ハプロタイプ ${hapIndex+1}/${haps.haplotypes.length} · MAFFT ${p.command}`);
            const subset=h.members.slice(0,o.maxReads),msa=await align(subset,hapProgress(0)),c=consensus(msa,h.id); ties+=c.ties;
            const alignment=await align([{id:`haplotype_${h.id}.fasta`,seq:h.seq},...subset],hapProgress(1));
            const entry={...c,count:h.count,sample:name,type:'haplotype',alignment}; entries.push(entry);
            save(`output-consensus-fastq/${h.id}.fq`,fastq([entry])); save(`output-consensus-alignments/${h.id}.fasta.mafft`,alignment);
          }
          sample.haplotypes=haps.haplotypes.length;
        }
      }
      step('analysed',1,'サンプル解析完了・BLAST待ち');
      sample.input=reads;
      return {local,sample,entries,ties};
    },{signal,onState:progress('サンプル解析',jobs,'samplePeak')});
    parallel=undefined;
    for(const result of processed) {merge(result.local);samples.push(result.sample);entries.push(...result.entries);ties+=result.ties;}
    if(!entries.length) throw new Error('コンセンサスが生成されませんでした。クラスターの最小リード数・同一率を確認してください。');
    save('output-consensus.fastq',fastq(entries)); save('output-consensus.fasta',fasta(entries));
    const sortedEntries=[...entries].sort((a,b)=>b.seq.length-a.seq.length || compare(a.id,b.id));
    save('output-all.sorted.fasta',fasta(sortedEntries));
    tracker.setGlobal('全サンプルの統合',0);emit('全サンプルのコンセンサスを CD-HIT で統合');
    const word=o.allIdentity>=.7?5:o.allIdentity>=.6?4:o.allIdentity>=.5?3:2;
    const cd=await run('cd-hit',['-i','all.fa','-c',String(o.allIdentity),'-n',String(word),'-T','1','-o','centers.fa','-M','0','-d','0'],{files:{'all.fa':fasta(sortedEntries)},outputs:['centers.fa','centers.fa.clstr']});
    tracker.setGlobal('代表配列のアラインメント',.4);emit('全サンプル統合完了');
    save('output-all-center.fasta',cd.files['centers.fa']);save('output-all-center.fasta.clstr',cd.files['centers.fa.clstr']);
    const groups=[]; let group;
    for(const line of decode(cd.files['centers.fa.clstr']).split('\n')) {
      if(line.startsWith('>Cluster')) {group=[];groups.push(group);}
      else {const m=line.match(/>(.*?)\.\.\./); if(m && group) group.push(m[1]);}
    }
    const allMap=new Map(entries.map(r=>[r.id,r]));
    const representatives=groups.map(g=>g.map(id=>allMap.get(id)).sort((a,b)=>b.count-a.count || compare(a.id,b.id))[0]);
    if(representatives.some(r=>!r)) throw new Error('CD-HIT クラスターの対応に失敗しました。');
    save('output-all-center.fasta.clstr.uc',groups.map((g,i)=>[...g].sort((a,b)=>allMap.get(b).count-allMap.get(a).count || compare(a,b)).map(id=>`${id}\t${i+1}\t${allMap.get(id).count}\n`).join('')).join(''));
    save('output-all-clusters.max.uc.fasta',fasta(representatives));
    const allAlignment=await align(representatives,p=>tracker.setGlobal('代表配列のアラインメント',.4+.4*p.fraction)); save('output-all-clusters.max.uc.fasta.mafft',allAlignment);
    tracker.setGlobal('BLASTデータベース生成',.8);emit('BLAST データベースを生成');
    const db=await run('makeblastdb',['-in','references.fa','-dbtype','nucl','-blastdb_version','4','-out','db'],{files:{'references.fa':fasta(representatives)},outputs:null});
    const dbFiles=Object.fromEntries(Object.entries(db.files).filter(([name])=>name.startsWith('db.')));
    if(!Object.keys(dbFiles).length) throw new Error('BLAST データベースが生成されませんでした。');
    tracker.setGlobal('BLAST集計',1);emit('BLASTデータベース生成完了');
    const sampleCounts=new Map(),totals=new Map();
    const searched=await mapParallel(samples,o.parallelSamples,async(sample,index,signal)=>{
      const local=scope(sample.name,signal),{save,emit,run}=local;
      const counts=new Map(),reads=sample.input; delete sample.input;
      for(let start=0;start<reads.length;start+=o.batchSize) {
        tracker.update(sample.name,'blast',start/reads.length,`${start}/${reads.length} reads 処理済み`,{processedReads:start});
        emit(`${sample.name}: BLAST ${start+1}〜${Math.min(start+o.batchSize,reads.length)} / ${reads.length} reads`);
        const result=await run('blastn',['-db','db','-query','query.fa','-num_threads','1','-outfmt','6 qseqid sseqid qlen slen pident length mismatch gapopen qstart qend sstart send evalue bitscore staxids stitle'],{files:{...dbFiles,'query.fa':fasta(reads.slice(start,start+o.batchSize))}});
        save(`work-blast/${sample.name}/part${String(Math.floor(start/o.batchSize)+1).padStart(4,'0')}.blastn`,result.stdout);
        const assignment=blastCounts(result.stdout,o); sample.assigned+=assignment.assigned;
        for(const [id,count] of assignment.counts) counts.set(id,(counts.get(id)||0)+count);
        const completed=Math.min(start+o.batchSize,reads.length);
        tracker.update(sample.name,'blast',completed/reads.length,`${completed}/${reads.length} reads 処理済み`,{processedReads:completed});
        emit(`${sample.name}: BLAST ${completed}/${reads.length} reads 完了`);
      }
      save(`work-blast/${sample.name}.cnt`,`id\t${sample.name}\n`+[...counts].sort((a,b)=>b[1]-a[1] || compare(a[0],b[0])).map(([id,n])=>`${id}\t${n}\n`).join(''));
      return {local,sample,counts};
    },{signal,onState:progress('BLAST 集計',samples,'blastPeak')});
    parallel=undefined;
    for(const result of searched) {
      merge(result.local);sampleCounts.set(result.sample.name,result.counts);
      for(const [id,count] of result.counts) totals.set(id,(totals.get(id)||0)+count);
    }
    const names=samples.map(s=>s.name).sort(compare);
    const rows=[...totals].sort((a,b)=>b[1]-a[1] || compare(a[0],b[0])).map(([id,total])=>({id,total,seq:allMap.get(id).seq,qual:allMap.get(id).qual,counts:names.map(name=>sampleCounts.get(name).get(id)||0)}));
    save('all.cnt.txt','id\t'+names.join('\t')+'\n'+rows.map(r=>[r.id,...r.counts].join('\t')+'\n').join(''));
    save('all.cnt.seq.txt','id\tseq\t'+names.join('\t')+'\n'+rows.map(r=>[r.id,r.seq,...r.counts].join('\t')+'\n').join(''));
    save('all.cnt.seq.qual.txt','id\tseq\tqual\t'+names.join('\t')+'\n'+rows.map(r=>[r.id,r.seq,r.qual,...r.counts].join('\t')+'\n').join(''));
    const manifest={started,finished:new Date().toISOString(),options:o,concurrency,samples,commands,consensuses:entries.length,representatives:representatives.length,consensusTiedColumns:ties,warnings,
      versions:{mafft:'7.525',vsearch:'2.29.3','cd-hit':'4.8.1',minimap2:'2.28',samtools:'1.17',htslib:'1.17',varscan:'2.4.6 JavaScript port',blastn:'2.16.0+'},
      upstream:'https://github.com/c2997108/OpenPortablePipeline/blob/53c159aeedff6038f0fe5ab032bdd4f064067483/PortablePipeline/scripts/nanopore~get-consensus',
      compatibilityNotes:['SNP and INDEL records are merged; upstream shell incorrectly counts VCF headers and drops INDELs.','Tied consensus bases use lexical order; upstream uses unseeded random.choice.','Equal-count representatives and read ordering use deterministic lexical order.','Legacy singleton clusters are accepted when minReads=1.','One compute thread per tool; browser memory limit is 2 GiB per WASM instance.','Consensus FASTQ qualities encode column agreement, not Phred quality.','CD-HIT (amino acid command) is retained as in the original pipeline.']};
    save('run.json',JSON.stringify(manifest,null,2));save('pipeline.log',logs.join('\n'));
    emit(`完了: ${entries.length} コンセンサス / ${representatives.length} 代表配列`);
    return {files,manifest,samples,names,rows,entries,representatives,alignment:allAlignment};
  }
}
