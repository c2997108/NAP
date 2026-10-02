import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateOptions, parseTable, parseBlast, HitPool, filterHits, lowestCommonAncestor, annotate, taxTable } from '../public/annotation/app/core.mjs';
import { inspectFasta, fastaShards, readTaxonomy } from '../public/annotation/app/reference.mjs';
import { annotationResultPage } from '../public/annotation/app/result-page.mjs';
const blob = text => new Blob([text]);
const row = (id, counts) => ({ id,seq:'ACGT'.repeat(50),qual:'I'.repeat(200),counts,total:counts.reduce((a,b)=>a+b,0) });
const hit = (query, subject, bit=400, identity=100, length=200, start=1, end=200) => parseBlast(`${query}\t${subject}\t${identity}\t${length}\t0\t0\t${start}\t${end}\t1\t${length}\t1e-90\t${bit}\n`)[0];
test('annotation reads exact consensus table schema and preserves fractional sample counts and sequences', () => {
  const text = 'id\tseq\tqual\tA\tB\nq\tACGT\tI!I!\t0.5\t2\n';
  const table = parseTable(text);
  assert.deepEqual(table.names,['A','B']);assert.deepEqual(table.rows[0].counts,[.5,2]);assert.equal(table.rows[0].qual,'I!I!');
  for (const bad of [text.replace('id\tseq','name\tseq'),text.replace('0.5',''),text.replace('0.5','-1'),text.replace('I!I!','II'),text.replace('A\tB','A\tA'),text+text.split('\n')[1]+'\n']) assert.throws(()=>parseTable(bad));
});
test('default annotation filters use first qualifying hit and query-coordinate span, before top-score LCA selection', () => {
  const rows=[row('a',[1]),row('b',[1])], options=validateOptions();
  assert.deepEqual([options.topScore,options.minBitscore,options.minIdentity,options.minLength,options.minCoverage],[1,100,90,100,0]);
  const hits=[hit('q0','fails_identity',500,89),hit('q0','first_valid',400),hit('q0','near',399),hit('q0','span_short',400,100,150,1,99),hit('q1','bit_short',99)];
  assert.deepEqual(filterHits(hits,rows,options).map(hit=>hit.subject),['first_valid']);
  assert.deepEqual(filterHits(hits,rows,{...options,topScore:.95}).map(hit=>hit.subject),['first_valid','near']);
  assert.equal(filterHits([hit('q0','gapped',400,100,150,1,100)],rows,{...options,minCoverage:75}).length,0);
});
test('LCA finds the common prefix and preserves the script chloroplast preference only when roots conflict', () => {
  assert.equal(lowestCommonAncestor(['Eukaryota;Animal;A','Eukaryota;Animal;B']),'Eukaryota;Animal');
  assert.equal(lowestCommonAncestor(['Eukaryota;Plant','Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;X']),'Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;X');
  assert.equal(lowestCommonAncestor(['Eukaryota;Plant','Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;X','Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;Y']),'Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast');
  assert.equal(lowestCommonAncestor(['Bacteria;Other','Bacteria;Cyanobacteria;Cyanobacteriia;Chloroplast;X']),'Bacteria');
  assert.equal(lowestCommonAncestor(['Eukaryota','Bacteria']),'unknown');
  assert.equal(lowestCommonAncestor(['Eukaryota;;Leaf']),'Eukaryota');
  assert.equal(lowestCommonAncestor(['']),'unknown');
});
test('subject limit is enforced globally across DB volumes before downstream filters and retains multiple HSPs', () => {
  const pool=new HitPool();pool.add(Array.from({length:500},(_,i)=>hit('q0','old'+i,100+i)));
  pool.add([{...hit('q0','new',1000),shard:1},{...hit('q0','new',900),shard:1}]);
  assert.equal(pool.hits().length,501);assert.equal(pool.hits()[0].subject,'new');
  assert.ok(!pool.hits().some(hit=>hit.subject==='old0'));
});
test('control overrides taxonomy with its last qualifying HSP; grouping uses both LCA and top path, preserving No Hit counts', () => {
  const table={names:['A','B'],rows:[row('a',[2,.5]),row('b',[3,0]),row('c',[0,4]),row('d',[0,1]),row('e',[6,0])]};
  const hits=[hit('q0','r1'),hit('q1','r1'),hit('q2','r2'),hit('q4','r1')], taxonomy=new Map([['r1','Eukaryota;A'],['r2','Eukaryota;B']]);
  const controls=[hit('q4','internalcontrol',200,80,60),hit('q4','internalcontrol',190,79,70),hit('q4','internalcontrol',180,90,61)];
  const result=annotate(table,hits,taxonomy,controls);
  assert.equal(result.rows[4].annotation.lca,'internal_control');assert.equal(result.rows[4].annotation.length,61);
  assert.equal(result.species.length,4);assert.deepEqual(result.species.find(row=>row.id==='a').counts,[5,.5]);
  assert.match(taxTable(result),/d\t[ACGT]+\tI+\t\t\t\t\t0\t1\n/);
});
test('FASTA shards never split a reference record, use exact DB size, and stream only needed taxonomy IDs', async () => {
  const reference=blob('>a description\nACGT\nAC\n>b\nTGCA\n>c\nCCCCCCCC\n');
  assert.deepEqual(await inspectFasta(reference,null,8),{sequences:3,totalBases:18,volumes:3});
  const shards=[];for await(const shard of fastaShards(reference,8))shards.push(shard);
  assert.equal(shards.length,3);assert.deepEqual([...shards[1].subjects],[['r1','b']]);
  const taxonomy=await readTaxonomy(blob('a\tRoot;A\nb\tRoot;B\nc\tRoot;C\n'),new Set(['b']));assert.deepEqual([...taxonomy],[['b','Root;B']]);
});
test('saved annotation report escapes input identifiers and taxonomy and includes standalone result tables', () => {
  const result=annotate({names:['A'],rows:[row('</script>',[1])]},[hit('q0','r')],new Map([['r','Root;<img src=x>']]),[]);
  result.files=new Map();result.manifest={summary:{representatives:1,annotated:1,groups:1},options:defaults,reference:{name:'DB'},warnings:[]};
  const html=annotationResultPage(result);assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(html.includes('&lt;/script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('species-results'));
});
