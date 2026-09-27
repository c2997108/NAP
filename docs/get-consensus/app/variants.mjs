/** Port of the single-sample mpileup2snp/mpileup2indel path in VarScan 2.4.6.
 * Daniel C. Koboldt / Washington University; see THIRD_PARTY_NOTICES.txt.
 * Preserve the upstream pileup parser and one-tailed Fisher calculation.
 */
const logFactorial=[0];
function probability(a,b,c,d) {
  const n=a+b+c+d;
  for(let i=logFactorial.length;i<=n;i++) logFactorial[i]=logFactorial[i-1]+Math.log(i);
  const f=logFactorial;
  return Math.exp((f[a+b]+f[c+d]+f[a+c]+f[b+d])-(f[a]+f[b]+f[c]+f[d]+f[n]));
}
export function significance(a,b,c,d) {
  if(c===undefined) {const coverage=a+b, error=Math.trunc(coverage*.001); return significance(coverage-error,error,a,b);}
  [a,b,c,d]=[a,b,c,d].map(x=>Math.max(0,x));
  let p=probability(a,b,c,d), right=p;
  let aa=a,bb=b,cc=c,dd=d;
  for(let i=0,n=Math.min(c,b);i<n;i++) right+=probability(++aa,--bb,--cc,++dd);
  if(right<.999) return right;
  for(let i=0,n=Math.min(a,d);i<n;i++) p+=probability(--a,++b,++c,--d);
  return p;
}
export function readCounts(ref,bases,qualities,minQual=15) {
  const counts=new Map(); let j=0,baseQual=0,prevQual=0,reads1indel=0;
  function add(key,strand,quality) {
    if(!counts.has(key)) counts.set(key,{n:0,plus:0,minus:0,sum:0});
    const c=counts.get(key); c.n++; c[strand==='+'?'plus':'minus']++; c.sum+=quality;
  }
  for(let i=0;i<bases.length;i++) {
    const base=bases[i], next=bases[i+1]||'', prev=i>1 && i<bases.length-1 ? bases[i-1] : '';
    if(j>1 && j<qualities.length-1) prevQual=qualities.charCodeAt(j-1)-33;
    if(j<qualities.length) baseQual=qualities.charCodeAt(j)-33;
    if((base==='.' || base===',') && !['+','-'].includes(next)) {
      if(baseQual>=minQual) add(ref,base==='.'?'+':'-',baseQual); j++;
    } else if(/[ACGTacgt]/.test(base)) {
      if(baseQual>=minQual) add(base.toUpperCase(),base===base.toUpperCase()?'+':'-',baseQual); j++;
    } else if(base==='+' || base==='-') {
      if((prev==='.' || prev===',') && prevQual>=minQual) reads1indel++;
      const m=bases.slice(i+1).match(/^(\d+)/); if(!m) throw new Error('不正な mpileup INDEL');
      const length=Number(m[1]), allele=bases.slice(i+1+m[1].length,i+1+m[1].length+length);
      i+=m[1].length+length;
      if(length && allele.length) {
        if(j<qualities.length) {baseQual=qualities.charCodeAt(j)-33; j++;}
        add(base+allele.toUpperCase(),allele===allele.toUpperCase()?'+':'-',baseQual);
      }
    } else if(base==='^') i++;
    else if(base==='$') { /* read end consumes no quality */ }
    else if(base!=='.' && base!==',') j++;
  }
  if(!counts.has(ref)) counts.set(ref,{n:0,plus:0,minus:0,sum:0});
  for(const c of counts.values()) c.qual=c.n?Math.trunc(c.sum/c.n):0;
  counts.get(ref).reads1indel=reads1indel;
  return counts;
}
export function callVariants(pileup,{minDepth=30}={}) {
  const variants=[], all=[];
  for(const line of pileup.trim().split('\n')) {
    if(!line) continue;
    const [chrom,position,ref,depth,bases,quals]=line.split('\t');
    if(Number(depth)<10 || !quals) continue;
    const qualityDepth=[...quals].filter(q=>q.charCodeAt(0)-33>=15).length;
    if(qualityDepth<10) continue;
    const counts=readCounts(ref,bases,quals), r=counts.get(ref);
    const total=[...counts.values()].reduce((sum,c)=>sum+c.n,0);
    let chosen;
    for(const [allele,c] of [...counts].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      if(allele===ref || c.qual<15 || (chosen && c.n<=chosen.c.n)) continue;
      chosen={allele,c};
    }
    if(!chosen) continue;
    const {allele,c}=chosen, freq=c.n/total, p=significance(r.n,c.n);
    if(c.n<2 || freq<.1 || p>.05) continue;
    // genotypeToCode returns N for heterozygous calls whose reference is N.
    if(ref==='N' && freq<.75) continue;
    const varPlus=c.plus/c.n,refPlus=r.n>1?r.plus/r.n:.5;
    let strandP=1;
    if(varPlus<.1 || varPlus>.9) strandP=r.n>1?significance(r.plus,r.minus,c.plus,c.minus):significance(Math.trunc(c.n/2),c.n-Math.trunc(c.n/2),c.plus,c.minus);
    if(refPlus>=.1 && refPlus<=.9 && (varPlus<.1 || varPlus>.9) && strandP<.01) continue;
    const indel=/^[+-]/.test(allele);
    const v={chrom,pos:Number(position),ref:allele.startsWith('-')?ref+allele.slice(1):ref,alt:allele.startsWith('+')?ref+allele.slice(1):allele.startsWith('-')?ref:allele,
      type:indel?'INDEL':'SNP',dp:qualityDepth,rawDepth:Number(depth),refCount:r.n,altCount:c.n,freq,p,refQual:r.qual,altQual:c.qual,rdf:r.plus,rdr:r.minus,adf:c.plus,adr:c.minus,gt:freq>=.75?'1/1':'0/1'};
    all.push(v); if(qualityDepth>=minDepth) variants.push(v);
  }
  const order=(a,b)=>(a.chrom<b.chrom?-1:a.chrom>b.chrom?1:0)||a.pos-b.pos;
  all.sort(order); variants.sort(order);
  return {all,variants,snps:all.filter(v=>v.type==='SNP'),indels:all.filter(v=>v.type==='INDEL')};
}
export function vcf(variants) {
  const formats=[['GT','String','Genotype'],['GQ','Integer','Genotype quality'],['SDP','Integer','Raw depth'],['DP','Integer','Quality depth'],['RD','Integer','Reference depth'],['AD','Integer','Alternate depth'],['FREQ','String','Variant frequency'],['PVAL','Float','Fisher p value'],['RBQ','Integer','Reference base quality'],['ABQ','Integer','Alternate base quality'],['RDF','Integer','Reference forward'],['RDR','Integer','Reference reverse'],['ADF','Integer','Alternate forward'],['ADR','Integer','Alternate reverse']];
  return '##fileformat=VCFv4.2\n##source=VarScan2.4.6-JavaScript-port\n'+
    [...new Set(variants.map(v=>v.chrom))].map(chrom=>`##contig=<ID=${chrom}>\n`).join('')+
    '##INFO=<ID=ADP,Number=1,Type=Integer,Description="Average quality depth">\n'+
    formats.map(([id,type,description])=>`##FORMAT=<ID=${id},Number=1,Type=${type},Description="${description}">\n`).join('')+
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample1\n'+
    variants.map(v=>`${v.chrom}\t${v.pos}\t.\t${v.ref}\t${v.alt}\t.\tPASS\tADP=${v.dp}\t${formats.map(f=>f[0]).join(':')}\t${[v.gt,Math.min(255,Math.trunc(-10*Math.log10(v.p))),v.rawDepth,v.dp,v.refCount,v.altCount,(v.freq*100).toFixed(2)+'%',v.p,v.refQual,v.altQual,v.rdf,v.rdr,v.adf,v.adr].join(':')}\n`).join('');
}
