import { defaults, validateOptions } from './core.mjs';
import { makeZip } from '../../get-consensus/app/zip.mjs';
const $ = id => document.getElementById(id);
let tableFile, referenceFile, pathFile, dbFiles = [], provenance = null, worker, result, busy = false, generation = 0, timer, started;
const notify = () => window.dispatchEvent(new Event('nap:annotation-state'));
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function controls() {
  $('start').disabled = busy || !tableFile || !crossOriginIsolated;
  $('cancel').disabled = !busy;
  for (const input of document.querySelectorAll('#options input,#options textarea,#reference-mode,input[type=file],#demo')) input.disabled = busy;
  $('input-summary').textContent = tableFile ? `${tableFile.name} · ${(tableFile.size / 1024).toFixed(1)} KB${provenance ? ' · get-consensusから受け取り' : ''}` : 'id・seq・qual・サンプル別カウントのタブ区切り表を指定してください。';
  notify();
}
function busyState(value) { busy = value; controls(); clearInterval(timer); if (value) { started = Date.now(); timer = setInterval(() => $('elapsed').textContent = `${Math.floor((Date.now() - started) / 1000)} 秒`, 1000); } else $('elapsed').textContent = started ? `${((Date.now() - started) / 1000).toFixed(1)} 秒` : ''; }
function clearResult() { generation++; result = null; $('results').hidden = true; $('progress-panel').hidden = true; $('progress').value = 0; $('log').textContent = ''; }
function setTable(file, inputProvenance = null) {
  if (busy) throw Error('分類解析中です。終了または中止してから入力を変更してください。');
  if (!file || typeof file.text !== 'function') throw Error('コンセンサス集計表のFileが必要です。');
  tableFile = file; provenance = inputProvenance ? structuredClone(inputProvenance) : null;
  clearResult(); controls(); status('コンセンサス集計表を読み込みました。参照DBと条件を確認して「分類解析を開始」を押してください。');
}
function referenceMode() {
  for (const mode of ['local','folder','fasta']) $(`${mode}-reference`).hidden = $('reference-mode').value !== mode;
  $('reference-summary').textContent = $('reference-mode').value === 'fasta' ? [referenceFile?.name,pathFile?.name].filter(Boolean).join(' · ') : $('reference-mode').value === 'folder' ? `${dbFiles.length} ファイルを選択` : '';
}
$('table-file').onchange = () => { if ($('table-file').files[0]) setTable($('table-file').files[0]); };
$('reference-mode').onchange = referenceMode;
$('reference-file').onchange = () => { referenceFile = $('reference-file').files[0]; referenceMode(); };
$('taxonomy-file').onchange = () => { pathFile = $('taxonomy-file').files[0]; referenceMode(); };
$('db-folder').onchange = () => { dbFiles = [...$('db-folder').files]; referenceMode(); };
function table(id, headers, rows) {
  const element = $(id); element.replaceChildren();
  const head = document.createElement('thead'), tr = document.createElement('tr');
  for (const label of headers) { const th = document.createElement('th'); th.textContent = label; tr.append(th); }
  head.append(tr); element.append(head);
  const body = document.createElement('tbody');
  for (const cells of rows) { const row = document.createElement('tr'); for (const value of cells) { const td = document.createElement('td'); td.textContent = typeof value === 'number' ? value.toLocaleString('ja-JP',{maximumFractionDigits:5}) : value; row.append(td); } body.append(row); }
  element.append(body);
}
function download(name, blob) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
function finish(data) {
  result = data; $('results').hidden = false;
  const s = result.manifest.summary;
  $('metrics').textContent = `${s.representatives} 代表配列 / ${s.annotated} 配列に分類情報 / ${s.internalControls} 内部コントロール / ${s.groups} 分類グループ`;
  $('warnings').textContent = result.manifest.warnings.join('\n');
  table('annotation-results',['ID','長さ (bp)','LCA','最上位ヒットの分類','アラインメント長','一致率 (%)',...result.names,'合計'],result.rows.map(row => [row.id,row.seq.length,row.annotation.lca || 'No Hit',row.annotation.topTaxpath,row.annotation.length,row.annotation.identity,...row.counts,row.total]));
  table('species-results',['代表ID','LCA','最上位ヒットの分類',...result.names,'合計'],result.species.map(row => [row.id,row.annotation.lca || 'No Hit',row.annotation.topTaxpath,...row.counts,row.total]));
  $('outputs').replaceChildren();
  for (const [name, blob] of result.files) { const button = document.createElement('button'); button.className = 'file-button'; button.textContent = name; button.onclick = () => download(name, blob); $('outputs').append(button); }
  $('progress').value = 1; $('progress-value').textContent = '100% · 完了';
  status(`分類解析が完了しました。${result.files.size} ファイルを保存できます。`); worker?.terminate(); worker = null; busyState(false);
}
$('start').onclick = () => {
  if (busy || !tableFile) return;
  try {
    const values = new FormData($('options')), options = validateOptions(Object.fromEntries(Object.entries(defaults).map(([key,value]) => [key,typeof value === 'number' ? Number(values.get(key)) : values.get(key)])));
    const mode = $('reference-mode').value;
    if (mode === 'fasta' && (!referenceFile || !pathFile)) throw Error('参照FASTAと分類対応表を選択してください。');
    if (mode === 'folder' && !dbFiles.length) throw Error('参照DBフォルダーを選択してください。');
    clearResult(); const token = generation; busyState(true); $('progress-panel').hidden = false; status('分類解析を開始しています…');
    worker = new Worker(new URL('./pipeline-worker.mjs', import.meta.url), { type: 'module' });
    const fail = error => { if (token !== generation) return; worker?.terminate(); worker = null; busyState(false); status(error.name === 'AbortError' ? '分類解析を中止しました。' : error.message,error.name !== 'AbortError'); };
    worker.onerror = event => fail(new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (token !== generation) return;
      if (data.error) fail(data.error);
      else if (data.result) finish(data.result);
      else if (data.progress) {
        const p = data.progress; $('progress').value = Math.max($('progress').value,p.fraction); $('progress-value').textContent = `${Math.floor($('progress').value * 100)}% · ${p.phase}`; $('progress-detail').textContent = p.detail;
        const line = `${p.phase}: ${p.detail}`; status(line); $('log').textContent += line + '\n';
      }
    };
    worker.postMessage({ tableFile, mode, referenceFile, pathFile, dbFiles, options, provenance });
  } catch (error) { status(error.message,true); }
};
$('cancel').onclick = () => { $('cancel').disabled = true; status('分類解析を中止しています…'); worker?.postMessage({cancel:true}); };
$('save-xlsx').onclick = () => {
  const name = 'all.cnt.seq.qual.tax.sp.xlsx', blob = result?.files.get(name);
  if (blob) download(name, blob);
};
$('zip').onclick = async () => {
  $('zip').disabled = true;
  try { download('annotation-results.zip', await makeZip([...result.files].map(([name,blob]) => ({ name,blob })))); }
  catch (error) { status(error.message,true); }
  finally { $('zip').disabled = false; }
};
$('demo').onclick = async () => {
  try {
    const response = await fetch('../examples/expected.json'); if (!response.ok) throw Error('デモを読み込めません。');
    const demo = await response.json(), samples = demo.samples;
    setTable(new File(['id\tseq\tqual\tsample_A\tsample_B\n' + samples.map((sample,index) => [`demo_${index+1}`,sample.sequence,'I'.repeat(sample.sequence.length),index ? 0 : 6,index ? 6 : 0].join('\t')).join('\n') + '\n'],'demo.seq.qual.txt'));
    referenceFile = new File([samples.map((sample,index)=>`>demo_ref_${index+1}\n${sample.sequence}\n`).join('')],'demo-reference.fa');
    pathFile = new File([samples.map((sample,index)=>`demo_ref_${index+1}\tDemo;Group_${index+1}\n`).join('')],'demo-reference.path');
    $('reference-mode').value = 'fasta'; referenceMode(); status('合成デモを読み込みました。Demo分類の動作確認用データです。');
  } catch (error) { status(error.message,true); }
};
window.napAnnotation = { setTable, get result() { return result; }, get state() { return { busy, revision:generation, input:tableFile ? {name:tableFile.name,size:tableFile.size} : null, result:result?.manifest.summary }; } };
referenceMode(); controls();
