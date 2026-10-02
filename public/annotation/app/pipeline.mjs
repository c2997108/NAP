import { ConsensusTools } from '../../get-consensus/tool-client.mjs';
import { defaults, validateOptions, parseTable, parseBlast, HitPool, filterHits, annotate, taxTable, UPSTREAM_COMMIT, MAX_TARGETS } from './core.mjs';
import { inspectFasta, fastaShards, readTaxonomy, validateManifest, referenceBytes, referenceFile } from './reference.mjs';
import { annotationWorkbook } from './workbook.mjs';
import { annotationResultPage } from './result-page.mjs';
export { defaults };
export async function runAnnotation(input, { tools = new ConsensusTools(), onProgress = () => {}, signal } = {}) {
  const started = performance.now(), o = validateOptions(input.options), files = new Map(), logs = [], warnings = [];
  const save = (name, text, type = 'text/plain;charset=utf-8') => files.set(name, text instanceof Blob ? text : new Blob([text], { type }));
  const progress = (fraction, phase, detail) => { signal?.throwIfAborted(); onProgress({ fraction: Math.min(.99, fraction), phase, detail }); };
  async function run(tool, args, settings) {
    signal?.throwIfAborted(); logs.push(`$ ${tool} ${args.join(' ')}`);
    const result = await tools.run(tool, args, { ...settings, signal });
    logs.push(result.stdout, result.stderr);
    if (result.exitCode !== 0) throw Error(`${tool}: ${result.stderr || result.stdout || '実行に失敗しました。'}`);
    return result.files;
  }
  progress(0, '入力を読み込み', input.tableFile.name);
  const sourceText = await input.tableFile.text(), table = parseTable(sourceText), pool = new HitPool();
  const batches = Array.from({ length: Math.ceil(table.rows.length / o.batchSize) }, (_, batch) => table.rows.slice(batch * o.batchSize, (batch + 1) * o.batchSize).map((row, index) => `>q${batch * o.batchSize + index}\n${row.seq}\n`).join(''));
  const allFasta = batches.join('');
  let info, manifest, taxonomyFile = input.pathFile, shards, source, completed = 0;
  if (input.mode === 'fasta') {
    if (!input.referenceFile || !taxonomyFile) throw Error('参照FASTAと分類対応表（.path）を選択してください。');
    progress(.01, '参照FASTAを集計', input.referenceFile.name);
    info = { ...await inspectFasta(input.referenceFile, signal, o.shardBases), name: input.referenceFile.name, mode: 'fasta', taxonomy: taxonomyFile.name };
    shards = fastaShards(input.referenceFile, o.shardBases, signal);
  } else {
    if (input.mode === 'folder') {
      const manifestFile = input.dbFiles.find(file => file.name === 'manifest.json');
      if (!manifestFile) throw Error('参照DBフォルダーにmanifest.jsonがありません。');
      manifest = validateManifest(JSON.parse(await manifestFile.text())); source = { files: input.dbFiles };
    } else {
      const url = new URL('../database/manifest.json', import.meta.url);
      const response = await fetch(url, { signal });
      if (!response.ok) throw Error('準備済みの統合DBを読み込めません。ローカルでは npm run prepare:annotation-db、GitHub Pages用には npm run prepare:pages:db でDBを用意するか、参照DBフォルダー / FASTAを指定してください。');
      manifest = validateManifest(await response.json()); source = { baseUrl: url.href };
    }
    info = { name: manifest.database, mode: input.mode, totalBases: manifest.totalBases, sequences: manifest.sequences, source: manifest.source, volumes: manifest.shards.length };
    shards = manifest.shards;
  }
  let shardIndex = 0;
  for await (const shard of shards) {
    let db, name;
    progress(.02 + .91 * completed / (info.volumes ? info.volumes * batches.length : Math.max(1, completed + batches.length)), '参照DBを読み込み', `分割 ${shardIndex + 1}`);
    if (input.mode === 'fasta') {
      name = 'reference';
      db = await run('makeblastdb', ['-in','reference.fa','-out',name,'-dbtype','nucl','-blastdb_version','4'], { files: { 'reference.fa': shard.fasta }, outputs: ['reference.nhr','reference.nin','reference.nsq'] });
    } else {
      name = shard.name; db = {};
      for (const spec of shard.files) db[spec.name] = await referenceBytes(spec, source, signal);
    }
    for (const [batch, query] of batches.entries()) {
      const output = await run('blastn', ['-db',name,'-query','query.fa','-dbsize',String(info.totalBases),'-max_target_seqs',String(MAX_TARGETS),'-outfmt','6','-out','hits.tsv'], { files: { ...db, 'query.fa': query }, outputs: ['hits.tsv'] });
      pool.add(parseBlast(new TextDecoder().decode(output['hits.tsv']), shardIndex, shard.subjects));
      completed++;
      const denominator = info.volumes ? info.volumes * batches.length : Math.max(completed, info.totalBases / o.shardBases * batches.length);
      progress(.02 + .91 * Math.min(1, completed / denominator), 'BLAST検索', `参照DB ${shardIndex + 1}${info.volumes ? '/' + info.volumes : ''} · 配列 ${Math.min(table.rows.length, (batch + 1) * o.batchSize)}/${table.rows.length}`);
    }
    shardIndex++;
  }
  const hits = pool.hits(), filtered = filterHits(hits, table.rows, o);
  progress(.94, '分類名とLCAを計算', `${filtered.length.toLocaleString()} 件のヒット`);
  if (manifest) taxonomyFile = await referenceFile(manifest.taxonomy, source, signal);
  const needed = new Set(filtered.map(hit => hit.subject)), taxonomy = await readTaxonomy(taxonomyFile, needed, signal);
  const missing = [...needed].filter(id => !taxonomy.has(id));
  if (missing.length) warnings.push(`${missing.length} 参照IDの分類パスがありません。元スクリプトと同じく空欄としてLCAを計算しました（例: ${missing.slice(0, 3).join(', ')}）。`);
  let controls = [];
  if (o.internalControl) {
    progress(.96, '内部コントロールを検索', '一致率80%以上・アラインメント長60 bp以上');
    const db = await run('makeblastdb', ['-in','control.fa','-out','control','-dbtype','nucl','-blastdb_version','4'], { files: { 'control.fa': `>internalcontrol\n${o.internalControl}\n` }, outputs: ['control.nhr','control.nin','control.nsq'] });
    const output = await run('blastn', ['-db','control','-query','query.fa','-outfmt','6','-out','hits.tsv'], { files: { ...db, 'query.fa': allFasta }, outputs: ['hits.tsv'] });
    controls = parseBlast(new TextDecoder().decode(output['hits.tsv']));
  }
  const result = annotate(table, filtered, taxonomy, controls);
  const renderedHits = rows => rows.map(hit => { const fields = [...hit.fields]; fields[0] = table.rows[Number(hit.query.slice(1))].id; return fields.join('\t'); }).join('\n') + (rows.length ? '\n' : '');
  const manifestOut = { application: 'NAP', stage: 'annotation~rRNA-for-metabarcoding', upstreamCommit: UPSTREAM_COMMIT, blastVersion: '2.16.0+', options: o, input: { name: input.tableFile.name, size: input.tableFile.size }, reference: info,
    execution: { referenceVolumes: shardIndex, blastBatches: completed, referenceDbsize: info.totalBases, maxTargetSequences: MAX_TARGETS, task: 'megablast', threadsPerWorker: 1 },
    summary: { representatives: result.rows.length, annotated: result.rows.filter(row => row.annotation.lca).length, internalControls: result.rows.filter(row => row.annotation.lca === 'internal_control').length, groups: result.species.length, samples: result.names.length }, warnings,
    elapsedMs: performance.now() - started, ...(input.provenance ? { nap: input.provenance } : {}) };
  save('all.cnt.seq.qual.txt', sourceText); save('queries.fasta', allFasta.replace(/^>q(\d+)$/gm, (_, index) => '>' + table.rows[Number(index)].id));
  save('blast.tsv', renderedHits(hits)); save('blast.filtered.tsv', renderedHits(filtered)); save('internalcontrol.blast.tsv', renderedHits(controls));
  save('all.cnt.seq.qual.tax.txt', taxTable(result)); save('all.cnt.seq.qual.tax.sp.txt', taxTable(result, result.species));
  save('annotations.tsv', ['id\tlca\ttop.taxpath\talign.len\tidentity', ...result.rows.map(row => [row.id, row.annotation.lca, row.annotation.topTaxpath, row.annotation.length, row.annotation.identity].join('\t'))].join('\n') + '\n');
  progress(.98, '結果ファイルを作成', '分類集計・Excel・HTML');
  save('all.cnt.seq.qual.tax.sp.xlsx', await annotationWorkbook(result, warnings));
  save('run.json', JSON.stringify(manifestOut, null, 2) + '\n', 'application/json'); save('pipeline.log', logs.filter(Boolean).join('\n') + '\n');
  result.files = files; result.manifest = manifestOut;
  save('annotation-results.html', annotationResultPage(result), 'text/html;charset=utf-8');
  return result;
}
