import { ConsensusTools } from '../../get-consensus/tool-client.mjs';
import { defaults, validateOptions, parseTable, parseBlast, HitPool, filterHits, annotate, taxTable, UPSTREAM_COMMIT, MAX_TARGETS } from './core.mjs';
import { inspectFasta, fastaShards, readTaxonomy, validateManifest, referenceBytes, referenceFile } from './reference.mjs';
import { annotationWorkbook } from './workbook.mjs';
import { annotationResultPage } from './result-page.mjs';
import { queryGroups, parallelPlan, sharedReference } from './parallel.mjs';
import { mapParallel } from '../../get-consensus/app/parallel.mjs';
import { isMemoryAllocationError } from '../../get-consensus/app/memory.mjs';
import { outputBlob } from '../../shared/output-blob.mjs';
export { defaults };
export async function runAnnotation(input, { tools = new ConsensusTools({ compiledModules: true }), onProgress = () => {}, signal, environment = globalThis.navigator || {} } = {}) {
  const started = performance.now(), o = validateOptions(input.options), files = new Map(), logs = [], warnings = [];
  const save = (name, text, type = 'text/plain;charset=utf-8') => files.set(name, text instanceof Blob || text?.napOutput === 'byte-parts' ? text : outputBlob([text], { type }));
  const progress = (fraction, phase, detail) => { signal?.throwIfAborted(); onProgress({ fraction: Math.min(.99, fraction), phase, detail }); };
  async function run(tool, args, settings, jobSignal = signal) {
    jobSignal?.throwIfAborted(); logs.push(`$ ${tool} ${args.join(' ')}`);
    const result = await tools.run(tool, args, { ...settings, signal: jobSignal });
    logs.push(result.stdout, result.stderr);
    if (result.exitCode !== 0) throw Error(`${tool}: ${result.stderr || result.stdout || '実行に失敗しました。'}`);
    return result.files;
  }
  progress(0, '入力を読み込み', input.tableFile.name);
  const sourceText = await input.tableFile.text(), table = parseTable(sourceText), pool = new HitPool();
  const initialPlan = parallelPlan(o, { inputBytes: input.tableFile.size, retainedBytes: input.retainedBytes, groups: table.rows.length }, environment);
  const initialWidth = initialPlan.limit, requested = initialPlan.requested;
  const batches = queryGroups(table.rows, o.batchSize, initialWidth), totalQueryBases = batches.reduce((sum, batch) => sum + batch.bases, 0);
  const budget = { limit: requested, memoryRetries: 0 };
  const concurrency = { requested, parallelMode: initialPlan.parallelMode, cores: initialPlan.cores, processorSource: initialPlan.processorSource, peak: 0, finalLimit: 1, memoryRetries: 0, sharedReference: false };
  let completedBases = 0;
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
  const searchFraction = () => .02 + .91 * completedBases / (info.volumes * totalQueryBases);
  async function search(db, name, args, consume, phase, detail, subjects) {
    const dbBytes = Object.values(db).reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const plan = parallelPlan(o, { referenceBytes: dbBytes, inputBytes: input.tableFile.size, retainedBytes: input.retainedBytes, maxQueryBases: batches.reduce((max, batch) => Math.max(max, batch.bases), 0), groups: batches.length }, environment);
    const limit = Math.min(plan.limit, budget.limit);
    Object.assign(concurrency, { finalLimit: limit, memoryMode: plan.mode, budgetSource: plan.source, deviceMemoryGB: plan.deviceMemoryGB, memoryBudgetMB: plan.budgetMB,
      retainedResultMB: plan.retainedResultMB, estimatedWorkerMB: Math.max(concurrency.estimatedWorkerMB || 0, plan.estimatedWorkerMB), reservedMB: Math.max(concurrency.reservedMB || 0, plan.reservedMB) });
    let completedRows = 0;
    if (limit > 1) {
      try { const shared = sharedReference(db); db = shared.files; concurrency.sharedReference ||= shared.shared; }
      catch (error) {
        if (!isMemoryAllocationError(error) && !(error instanceof RangeError)) throw error;
        budget.limit = 1; warnings.push('参照DBの共有メモリーを確保できなかったため、逐次検索に切り替えました。');
      }
    }
    await mapParallel(batches, Math.min(limit, budget.limit), async (batch, index, jobSignal) => {
      const output = await run('blastn', ['-db',name,'-query','query.fa',...args,'-outfmt','6','-out','hits.tsv'], { files: { ...db, 'query.fa': batch.query }, outputs: ['hits.tsv'] }, jobSignal);
      consume(parseBlast(new TextDecoder().decode(output['hits.tsv']), phase === 'BLAST検索' ? shardIndex : 0, subjects));
      completedRows += batch.count;
      if (phase === 'BLAST検索') { completed++; completedBases += batch.bases; }
    }, { signal, budget, onState: state => {
      concurrency.peak = Math.max(concurrency.peak, state.active.length); concurrency.finalLimit = state.limit;
      progress(phase === 'BLAST検索' ? searchFraction() : .96 + .01 * completedRows / table.rows.length, phase,
        `${detail} · ${completedRows}/${table.rows.length} 配列完了 · 同時 ${state.active.length}/${state.limit} グループ（${initialPlan.parallelMode === 'auto' ? 'CPUから自動' : '指定'} ${requested}）`);
    }, onMemoryPressure: state => {
      concurrency.memoryRetries = budget.memoryRetries;
      warnings.push(`メモリー不足のため並列検索を${state.previous}から${state.limit}グループへ減らし、失敗したグループを再試行しました。`);
    } });
  }
  let shardIndex = 0;
  for await (const shard of shards) {
    let db, name;
    progress(searchFraction(), '参照DBを読み込み', `分割 ${shardIndex + 1}`);
    if (input.mode === 'fasta') {
      name = 'reference';
      db = await run('makeblastdb', ['-in','reference.fa','-out',name,'-dbtype','nucl','-blastdb_version','4'], { files: { 'reference.fa': shard.fasta }, outputs: ['reference.nhr','reference.nin','reference.nsq'] });
    } else {
      name = shard.name; db = {};
      for (const spec of shard.files) db[spec.name] = await referenceBytes(spec, source, signal);
    }
    await search(db, name, ['-dbsize',String(info.totalBases),'-max_target_seqs',String(MAX_TARGETS)], hits => pool.add(hits), 'BLAST検索', `参照DB ${shardIndex + 1}/${info.volumes}`, shard.subjects);
    shardIndex++;
  }
  const hits = pool.hits().sort((a,b) => Number(a.query.slice(1)) - Number(b.query.slice(1))), filtered = filterHits(hits, table.rows, o);
  progress(.94, '分類名とLCAを計算', `${filtered.length.toLocaleString()} 件のヒット`);
  if (manifest) taxonomyFile = await referenceFile(manifest.taxonomy, source, signal);
  const needed = new Set(filtered.map(hit => hit.subject)), taxonomy = await readTaxonomy(taxonomyFile, needed, signal);
  const missing = [...needed].filter(id => !taxonomy.has(id));
  if (missing.length) warnings.push(`${missing.length} 参照IDの分類パスがありません。元スクリプトと同じく空欄としてLCAを計算しました（例: ${missing.slice(0, 3).join(', ')}）。`);
  let controls = [];
  if (o.internalControl) {
    progress(.96, '内部コントロールを検索', '一致率80%以上・アラインメント長60 bp以上');
    const db = await run('makeblastdb', ['-in','control.fa','-out','control','-dbtype','nucl','-blastdb_version','4'], { files: { 'control.fa': `>internalcontrol\n${o.internalControl}\n` }, outputs: ['control.nhr','control.nin','control.nsq'] });
    await search(db, 'control', [], hits => { for (const hit of hits) controls.push(hit); }, '内部コントロールを検索', '一致率80%以上・アラインメント長60 bp以上');
    controls.sort((a,b) => Number(a.query.slice(1)) - Number(b.query.slice(1)));
  }
  const result = annotate(table, filtered, taxonomy, controls);
  const renderedHits = rows => rows.map(hit => { const fields = [...hit.fields]; fields[0] = table.rows[Number(hit.query.slice(1))].id; return fields.join('\t'); }).join('\n') + (rows.length ? '\n' : '');
  const manifestOut = { application: 'NAP', stage: 'annotation~rRNA-for-metabarcoding', upstreamCommit: UPSTREAM_COMMIT, blastVersion: '2.16.0+', options: o, input: { name: input.tableFile.name, size: input.tableFile.size }, reference: info,
    execution: { referenceVolumes: shardIndex, blastBatches: completed, referenceDbsize: info.totalBases, maxTargetSequences: MAX_TARGETS, task: 'megablast', threadsPerWorker: 1, queryGroups: batches.length, concurrency },
    summary: { representatives: result.rows.length, annotated: result.rows.filter(row => row.annotation.lca).length, internalControls: result.rows.filter(row => row.annotation.lca === 'internal_control').length, groups: result.species.length, samples: result.names.length }, warnings,
    elapsedMs: performance.now() - started, ...(input.provenance ? { nap: input.provenance } : {}) };
  save('all.cnt.seq.qual.txt', sourceText); save('queries.fasta', outputBlob(batches.map(batch => batch.query.replace(/^>q(\d+)$/gm, (_, index) => '>' + table.rows[Number(index)].id)), { type: 'text/plain;charset=utf-8' }));
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
