import { fasta,parseFasta,parseUc,safeName,compare,decode } from './sequence.mjs';
export const qIdentity = q => (1-10**(-q/10)) - 2*10**(-q/10);
export function bins(width) {
  if (width === 'all') return [{label:'all',low:10,high:Infinity}];
  const result = [{label:'Q20-',low:20,high:Infinity}];
  for (let high=20;high>10;) { const low=Math.max(10,high-width); result.push({label:`Q${low}-Q${high}`,low,high}); high=low; }
  return result;
}
const tupleCompare = (a,b) => { for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return a[i]-b[i]; return 0; };
export async function qualityClusters(reads, name, minReads, run, emit, save, onProgress = () => {}) {
  const tagged = reads.map((r,i)=>({...r,label:`read${String(i+1).padStart(4,'0')}|${r.id.split(':')[0]}|len=${r.seq.length}`.replace(/[^A-Za-z0-9_.|=+-]/g,'_')}));
  let remaining = tagged.filter(r=>r.q!==null && Math.floor(r.q)>=10).sort((a,b)=>compare(a.label,b.label));
  const skipped = tagged.filter(r=>r.q===null || Math.floor(r.q)<10);
  save('skipped_reads.tsv','id\treason\tqscore\n'+skipped.map(r=>`${r.id}\t${r.q===null?'missing_qscore':'q_floor_below_10'}\t${r.q??''}\n`).join(''));
  const accepted=[], trace=[]; let stages=0;
  const widths=[1,2,3,4,5,6,7,8,9,10,'all'];
  for(const [iteration,width] of widths.entries()) {
    if(!remaining.length) break;
    stages++; const removed = new Set(); let processed=0;
    const stageReads=remaining.length, handled=reads.length-stageReads;
    for(const bin of bins(width)) {
      const members=remaining.filter(r=>Math.floor(r.q)>=bin.low && Math.floor(r.q)<bin.high);
      if(!members.length) continue;
      emit(`品質別クラスタリング: ${name} / ${width==='all'?'all':`幅${width}`} / ${bin.label} (${members.length} reads)`);
      const args=['--cluster_fast','input.fa','--id',qIdentity(bin.low).toFixed(6),'--iddef','2','--strand','both','--qmask','none','--centroids','center.fa','--consout','cons.fa','--clusterout_id','--clusterout_sort','--sizeout','--uc','clusters.uc'];
      const out=await run('vsearch',args,{files:{'input.fa':fasta(members.map(r=>({id:r.label,seq:r.seq})))},outputs:['center.fa','cons.fa','clusters.uc']});
      processed+=members.length;
      onProgress({fraction:(handled+stageReads*(iteration+processed/stageReads)/widths.length)/reads.length,iteration:iteration+1,iterations:widths.length,processedReads:processed,stageReads});
      const cons=new Map(parseFasta(out.files['cons.fa']).map((r,i)=>[Number(r.id.match(/clusterid=(\d+)/)?.[1]??i),r.seq]));
      const byLabel=new Map(members.map(r=>[r.label,r]));
      const prefix=`${String(stages).padStart(2,'0')}_${width==='all'?'all':`width_${width}`}/${safeName(bin.label)}`;
      save(prefix+'/clusters.uc',out.files['clusters.uc']); save(prefix+'/consensus.fasta',out.files['cons.fa']);
      for(const group of parseUc(out.files['clusters.uc']).sort((a,b)=>b.members.length-a.members.length || a.id-b.id)) {
        if(group.members.length<minReads) continue;
        const records=group.members.map(id=>byLabel.get(id)), seq=cons.get(group.id);
        if(!seq) throw new Error('VSEARCH consensus と UC の対応が見つかりません。');
        records.forEach(r=>removed.add(r.label));
        const label=`stage${stages}|${width==='all'?'all':`width_${width}`}|${bin.label}|cluster${group.id}|size${records.length}|len${seq.length}|meanQ${(records.reduce((s,r)=>s+r.q,0)/records.length).toFixed(6)}`;
        accepted.push({label,seq,records,priority:[width==='all'?1:-bin.low,-records.length,width==='all'?1e9:width,group.id,accepted.length+1]});
      }
    }
    remaining=remaining.filter(r=>!removed.has(r.label));
  }
  const dedup=new Map();
  for(const item of accepted) { if(!dedup.has(item.seq)) dedup.set(item.seq,[]); dedup.get(item.seq).push(item); }
  const groups=[...dedup.values()].map(items=>({items,rep:[...items].sort((a,b)=>tupleCompare(a.priority,b.priority))[0]})).sort((a,b)=>tupleCompare(a.rep.priority,b.rep.priority));
  const output=groups.map((g,index)=>{
    const members=g.items.flatMap(i=>i.records).sort((a,b)=>compare(a.id,b.id));
    const label=`${safeName(name)}.${g.rep.label};size=${g.items.length}`;
    for(const item of g.items) for(const r of item.records) trace.push([index,label,r.id,item.label,r.q,r.seq.length]);
    return {id:index+1,members,label};
  });
  trace.sort((a,b)=>a[0]-b[0] || compare(a[1],b[1]) || compare(a[2],b[2]));
  save('read_to_size3plus_consensus.dedup100.tsv','dedup_group_index\tdedup_consensus_label\toriginal_read_name\tcluster_consensus_label\tread_qscore\tread_length\n'+trace.map(r=>r.join('\t')+'\n').join(''));
  save('size3plus_consensus.dedup100.fa',fasta(groups.map(g=>({id:`${safeName(name)}.${g.rep.label};size=${g.items.length}`,seq:g.rep.seq}))));
  save('leftover_reads.fastq',remaining.map(r=>`@${r.header}\n${r.seq}\n+\n${r.qual}\n`).join(''));
  return {groups:output,skipped:skipped.length,leftover:remaining.length,stages,mode:'quality'};
}
