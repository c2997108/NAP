/** Read-backed phasing from haplotype_from_vcf_bam.py. SAM bases/qualities
 * already have alignment orientation; do not reverse-complement them again.
 */
export function parseSam(text) {
  return text.split('\n').filter(l=>l && !l.startsWith('@')).map(line=>{
    const f=line.split('\t'); return {id:f[0],flag:Number(f[1]),chrom:f[2],pos:Number(f[3]),mapq:Number(f[4]),cigar:f[5],seq:f[9],qual:f[10]};
  });
}
export function alleleAt(read,v) {
  let reference=read.pos,query=0;
  const ops=[...read.cigar.matchAll(/(\d+)([MIDNSHP=X])/g)].map(m=>({n:Number(m[1]),op:m[2]}));
  for(let i=0;i<ops.length;i++) {
    const {n,op}=ops[i];
    if('M=X'.includes(op)) {
      if(v.pos>=reference && v.pos<reference+n) {
        const q=query+v.pos-reference, base=read.seq[q]?.toUpperCase();
        let indel=0;
        if(v.pos===reference+n-1) {
          if(ops[i+1]?.op==='I') indel=ops[i+1].n;
          else if(ops[i+1]?.op==='D') indel=-ops[i+1].n;
        }
        if(v.ref.length===1 && v.alt.length===1) return indel!==0?null:base===v.ref?'0':base===v.alt?'1':null;
        if(base!==v.ref[0]) return null;
        if(v.ref.length>v.alt.length) return indel===-(v.ref.length-v.alt.length)?'1':indel===0?'0':null;
        if(v.ref.length<v.alt.length) return indel===v.alt.slice(1).length && read.seq.slice(q+1,q+1+indel).toUpperCase()===v.alt.slice(1)?'1':indel===0?'0':null;
        return null;
      }
      reference+=n; query+=n;
    } else if(op==='D' || op==='N') { if(v.pos>=reference && v.pos<reference+n) return null; reference+=n; }
    else if(op==='I' || op==='S') query+=n;
  }
  return null;
}
export function applyVariants(seq,vars,hap) {
  let result='',pos=0;
  vars.forEach((v,i)=>{result+=seq.slice(pos,v.pos-1)+(hap[i]==='1'?v.alt:v.ref); pos=v.pos-1+v.ref.length;});
  return result+seq.slice(pos);
}
export function haplotypes(sam,variants,references,{minDepth=30,minFreq=.1,phasePileup=null}={}) {
  const reads=parseSam(sam).filter(r=>!(r.flag & (4|256|2048))),output=[],debug=[];
  const allowed=new Map();
  // samtools supplies the same HTSlib pileup depth/flag filtering as pysam's
  // stepper="all" (including the 8000-read depth limit).
  if(phasePileup!==null) for(const line of phasePileup.trim().split('\n')) {
    const f=line.split('\t'); if(f.length>=7) allowed.set(`${f[0]}:${f[1]}`,new Set(f[6].split(',')));
  }
  const byChrom=new Map();
  for(const v of variants) { if(!byChrom.has(v.chrom)) byChrom.set(v.chrom,[]); byChrom.get(v.chrom).push(v); }
  for(const [chrom,vars] of byChrom) {
    vars.sort((a,b)=>a.pos-b.pos); const chromReads=reads.filter(r=>r.chrom===chrom);
    const calls=new Map();
    for(let i=0;i<vars.length;i++) for(const read of chromReads) {
      if(read.flag & (512|1024)) continue;
      const available=allowed.get(`${chrom}:${vars[i].pos}`);
      if(phasePileup!==null && !available?.has(read.id)) continue;
      const allele=alleleAt(read,vars[i]); if(allele===null) continue;
      if(!calls.has(read.id)) calls.set(read.id,new Map()); calls.get(read.id).set(i,allele);
    }
    const groups=new Map();
    for(const [id,c] of calls) {
      if(c.size<2 || c.size<vars.length) continue;
      const hap=vars.map((_,i)=>c.get(i)||'.').join('');
      if(!groups.has(hap)) groups.set(hap,[]); groups.get(hap).push(id);
    }
    const total=[...groups.values()].reduce((sum,ids)=>sum+ids.length,0);
    debug.push({chrom,variants:vars.length,primaryReads:chromReads.length,readsWithCalls:calls.size,completeReads:total});
    if(total<minDepth) continue;
    for(const [hap,ids] of [...groups].sort((a,b)=>b[1].length-a[1].length)) {
      if(ids.length/total<minFreq) continue;
      const idSet=new Set(ids),members=chromReads.filter(r=>idSet.has(r.id));
      const ref=references.find(r=>r.id===chrom); if(!ref) throw new Error(`Reference がありません: ${chrom}`);
      output.push({id:`${chrom}.hap_${hap}_${ids.length}reads`,chrom,hap,count:ids.length,freq:ids.length/total,seq:applyVariants(ref.seq,vars,hap),members});
    }
  }
  return {haplotypes:output,debug};
}
