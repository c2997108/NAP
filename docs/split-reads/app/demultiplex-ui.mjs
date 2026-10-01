import { DemultiplexClient } from './demultiplex-client.mjs';
import { DEFAULT_OPTIONS, prepareInputs } from './demultiplex-core.mjs';
import { createDefinitionEditor } from './definition-editor.mjs';
import { distributionChart } from './distribution-chart.mjs';
const $ = id => document.getElementById(id);
$('concurrency').value = DEFAULT_OPTIONS.concurrency;
let fastqFiles = [], primerFile, sampleFile, busy = false, generation = 0, latest;
let definitionEditor;
let resultRevision = 0;
const notifyState = () => window.dispatchEvent(new Event('nap:split-state'));
const controls = [...document.querySelectorAll('input, select'), $('load-test'), $('test-settings'), $('split')];
const format = value => value.toLocaleString('ja-JP');
const percent = fraction => `${(fraction * 100).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`;
function setProgress(fraction) { $('progress').value = fraction; $('progress').setAttribute('aria-valuetext', percent(fraction)); }
const size = value => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
function log(text) { $('log').textContent += `${text}\n`; if ($('log').textContent.length > 60000) $('log').textContent = $('log').textContent.slice(-60000); $('log').scrollTop = $('log').scrollHeight; }
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function syncControls() { for (const control of controls) control.disabled = busy || Boolean(definitionEditor?.loading); }
function setBusy(value) {
  busy = value;
  syncControls(); definitionEditor?.setBusy(value);
  $('download-zip').disabled = value || !latest;
  $('download-fastq-zip').disabled = value || !latest?.summary.samples.length;
  notifyState();
}
const client = new DemultiplexClient({ onLog: log, onProgress: progress => {
  const fraction = Math.min(0.99, progress.fraction || 0);
  setProgress(fraction);
  $('progress-label').textContent = `${percent(fraction)} · ${progress.stage} · 同時処理 ${progress.activeFiles || 0} ファイル / 完了 ${progress.completedFiles || 0} / ${progress.fileCount || fastqFiles.length} ファイル · 処理済み ${format(progress.totalReads)} リード / 分類 ${format(progress.assignedReads)} リード / 出力 ${format(progress.segments)} 配列`;
  if (progress.files) showFileProgress(progress.files);
} });
window.demultiplexer = client;
const progressRows = new Map();
function showFileProgress(files) {
  $('file-progress').hidden = false;
  const labels = { queued: '待機中', running: '処理中', complete: '完了', error: 'エラー' };
  for (const file of files) {
    let cells = progressRows.get(file.index);
    if (!cells) {
      const row = document.createElement('tr'); cells = Array.from({ length: 5 }, () => document.createElement('td'));
      const meter = document.createElement('div'); meter.className = 'file-progress-meter';
      cells.bar = document.createElement('progress'); cells.bar.max = 1;
      cells.bar.setAttribute('aria-label', `${file.name} の分割進捗`);
      cells.percent = document.createElement('span'); meter.append(cells.bar, cells.percent);
      cells.stage = document.createElement('small'); cells.stage.className = 'file-stage';
      cells[2].append(meter, cells.stage);
      row.append(...cells); $('file-progress').querySelector('tbody').append(row); progressRows.set(file.index, cells);
    }
    cells[0].textContent = file.name; cells[1].textContent = labels[file.state];
    cells[1].classList.toggle('error', file.state === 'error');
    const fraction = file.fraction || 0;
    cells.bar.value = fraction;
    cells.percent.textContent = file.state === 'running' && file.inputReads === null ? '確認中' : percent(fraction);
    cells.bar.setAttribute('aria-valuetext', cells.percent.textContent);
    cells.stage.textContent = file.phase === 'counting' ? `${file.stage}（${format(file.countedReads || 0)} リード確認済み）` : file.stage || labels[file.state];
    cells[3].textContent = file.inputReads === null ? format(file.totalReads) : `${format(file.totalReads)} / ${format(file.inputReads)}`;
    cells[4].textContent = format(file.assignedReads);
  }
}
function inputInfo() {
  $('fastq-info').textContent = fastqFiles.length ? fastqFiles.map(file => `${file.name} (${size(file.size)})`).join(' / ') : 'ファイルを選択してください。';
  $('primer-info').textContent = primerFile ? `${primerFile.name} (${size(primerFile.size)})` : 'primer.fa';
  $('sample-info').textContent = sampleFile ? `${sampleFile.name} (${size(sampleFile.size)})` : '名前 / Forward primer / Reverse primer / 最小アンプリコン長 / 最大長';
}
$('fastq-files').onchange = event => { fastqFiles = [...event.target.files]; inputInfo(); };
async function openDefinitionFiles() {
  if (!primerFile || !sampleFile || busy) return;
  const result = await definitionEditor.importFiles({ openTable: true });
  if (result?.success) status('プライマーとサンプル表を読み込みました');
  else if (result?.error) status(result.error, true);
  notifyState();
}
$('primer-file').onchange = event => { definitionEditor.cancelImport(); primerFile = event.target.files[0]; inputInfo(); void openDefinitionFiles(); };
$('sample-file').onchange = event => { definitionEditor.cancelImport(); sampleFile = event.target.files[0]; inputInfo(); void openDefinitionFiles(); };
function getOptions() { return { task: $('task').value, primerCoverage: +$('primer-coverage').value, primerIdentity: +$('primer-identity').value, barcodeCoverage: +$('barcode-coverage').value, barcodeIdentity: +$('barcode-identity').value, batchSize: +$('batch-size').value, concurrency: +$('concurrency').value, expand: $('expand').checked, suppressChimeras: $('suppress-chimeras').checked }; }
async function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function saveButton(name, label = '保存') {
  const button = document.createElement('button'); button.className = 'secondary'; button.textContent = label;
  button.onclick = async () => { try { await saveBlob(await client.readFile(name), name.split('/').at(-1)); } catch (error) { status(error.message, true); } };
  return button;
}
function clearResults() { latest = null; resultRevision++; $('summary').replaceChildren(); $('files').replaceChildren(); $('sample-results').querySelector('tbody').replaceChildren(); $('file-progress').querySelector('tbody').replaceChildren(); $('file-progress').hidden = true; progressRows.clear(); $('result-note').textContent = ''; setProgress(0); $('download-zip').disabled = true; $('download-fastq-zip').disabled = true; notifyState(); }
function showResult(result) {
  latest = result; const s = result.summary; $('summary').replaceChildren();
  setProgress(1);
  $('progress-label').textContent = `100% · 分割・集計が完了 · ${s.completedFiles} ファイル / 処理済み ${format(s.totalReads)} リード / 分類 ${format(s.assignedReads)} リード / 出力 ${format(s.segments)} 配列`;
  for (const [label, value] of [['入力リード', s.totalReads], ['分類済みリード', s.assignedReads], ['未分類リード', s.unassignedReads], ['出力配列', s.segments], ['出力サンプル', s.samples.length]]) {
    const metric = document.createElement('div'); metric.className = 'metric'; const strong = document.createElement('strong'), span = document.createElement('span'); strong.textContent = format(value); span.textContent = label; metric.append(strong, span); $('summary').append(metric);
  }
  const tbody = $('sample-results').querySelector('tbody'); tbody.replaceChildren();
  for (const row of s.samples) {
    const tr = document.createElement('tr'); for (const value of [row.sample, format(row.segments), format(row.bases)]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    const lengths = document.createElement('td'), stats = document.createElement('dl'); stats.className = 'length-statistics';
    for (const [label, value, key] of [['最短 / 最長', `${format(row.minLength)} / ${format(row.maxLength)}`, 'range'], ['平均長', row.meanLength.toLocaleString('ja-JP', { maximumFractionDigits: 2 }), 'mean'], ['中央値', row.medianLength.toLocaleString('ja-JP', { maximumFractionDigits: 2 }), 'median']]) {
      const name = document.createElement('dt'), number = document.createElement('dd'); name.textContent = label; number.textContent = value; number.dataset.statistic = key; stats.append(name, number);
    }
    lengths.append(stats); tr.append(lengths);
    const td = document.createElement('td'); td.append(saveButton(`output/${row.sample}.fq`)); tr.append(td);
    const lengthChart = document.createElement('td'); lengthChart.className = 'distribution-cell'; lengthChart.append(distributionChart(row, 'length')); tr.append(lengthChart);
    const qualityChart = document.createElement('td'), coverage = document.createElement('p'); qualityChart.className = 'distribution-cell'; coverage.className = 'hint quality-coverage';
    if (row.qualityReads) {
      qualityChart.append(distributionChart(row, 'quality'));
      coverage.textContent = `品質情報あり ${format(row.qualityReads)} / ${format(row.segments)} 配列`;
    } else coverage.textContent = 'ヘッダーに有効な品質情報なし';
    qualityChart.append(coverage); tr.append(qualityChart);
    tbody.append(tr);
  }
  $('result-note').textContent = s.segments ? '長さはプライマー除去後の出力配列を集計し、長さ分布の縦軸は各区間の総塩基数（bp）を表示します。品質分布は元リードのヘッダーにあるQスコア（qs:f: など）を使用し、品質情報のない配列は除外します。FASTQの品質文字列からの計算は行いません。1リードから複数配列が得られる場合は、各配列に同じ元リードのQスコアを対応付けます。棒にカーソルを重ねると区間・塩基数（長さ分布）・配列数・割合を表示します。長さ分布の割合は全出力塩基数に対する割合です。' : '条件を満たすプライマー対がありませんでした。入力リードは unassigned.fq に保存されています。判定条件と BLAST 判定根拠を確認してください。';
  $('files').replaceChildren();
  for (const file of result.files) { const li = document.createElement('li'), name = document.createElement('span'), bytes = document.createElement('small'); name.textContent = file.name; bytes.textContent = size(file.size); li.append(name, bytes, saveButton(file.name)); $('files').append(li); }
  log(`完了: ${s.completedFiles} ファイル / 最大 ${s.concurrency} ファイル同時処理 / ${s.totalReads} 入力リード → ${s.segments} 配列 / ${s.samples.length} サンプル (${(s.elapsedMs / 1000).toFixed(1)} 秒)`);
  notifyState();
}
$('split').onclick = async () => {
  const token = generation; clearResults(); $('log').textContent = ''; setBusy(true); status('処理中');
  try {
    if (!fastqFiles.length) throw new Error('FASTQ ファイルを選択してください。');
    let primerText, sampleText;
    if (definitionEditor.mode === 'table') {
      ({ primerText, sampleText } = definitionEditor.export());
      log('入力表から primer.fasta と sample.txt を生成しました。');
    } else {
      if (!primerFile || !sampleFile) throw new Error('プライマー FASTA とサンプル表を選択してください。');
      [primerText, sampleText] = await Promise.all([primerFile.text(), sampleFile.text()]);
    }
    if (token !== generation) return;
    const prepared = prepareInputs(primerText, sampleText, getOptions());
    log(`入力: ${fastqFiles.length} ファイル / ${prepared.primers.length} プライマー / ${prepared.samples.length} サンプル定義`);
    const result = await client.run({ fastqFiles, primerText, sampleText, options: prepared.options, diagnostics: $('diagnostics').checked });
    if (token !== generation) return;
    showResult(result); status('完了');
  } catch (error) { if (token === generation) { status('エラー', true); log(error.message); } }
  finally { if (token === generation) setBusy(false); }
};
$('cancel').onclick = () => { generation++; definitionEditor.cancelImport(); client.cancel(); clearResults(); setBusy(false); $('progress-label').textContent = '処理を中止し、出力をリセットしました。'; status('入力待ち'); log('処理を中止し、出力をリセットしました。'); };
async function downloadZip(fastqOnly) {
  const token = generation; setBusy(true); status('ZIP 作成中');
  try { const blob = await client.zip({ fastqOnly }); if (token !== generation) return; await saveBlob(blob, fastqOnly ? 'nanopore-split-fastq.zip' : 'nanopore-split.zip'); status('完了'); }
  catch (error) { if (token === generation) { status('エラー', true); log(error.message); } }
  finally { if (token === generation) setBusy(false); }
}
$('download-zip').onclick = () => downloadZip(false);
$('download-fastq-zip').onclick = () => downloadZip(true);
$('load-test').onclick = async () => {
  const token = generation; setBusy(true); status('テスト入力を読込み');
  try {
    const names = ['raw-A.fastq.gz', 'raw-B.fastq.gz', 'primer.fa', 'sample.txt'];
    const files = await Promise.all(names.map(async name => { const response = await fetch(`../examples/${name}`); if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`); return new File([await response.blob()], name); }));
    if (token !== generation) return;
    [fastqFiles, primerFile, sampleFile] = [files.slice(0,2), files[2], files[3]]; definitionEditor.setMode('files'); inputInfo();
    setBusy(false); await openDefinitionFiles();
    if (token !== generation) return;
    status('デモ入力を読込み済み'); log('合成デモ: 2 FASTQ・12リード。既定条件で2サンプルに分割できます。');
  } catch (error) { if (token === generation) { status('エラー', true); log(error.message); } }
  finally { if (token === generation) setBusy(false); }
};
$('test-settings').onclick = () => { $('task').value = 'blastn'; $('barcode-identity').value = '80'; $('barcode-coverage').value = '0.9'; status('テスト用設定'); log('テスト用設定: -task blastn / バーコード一致率80% / 被覆率90%。入力に応じて条件を確認してください。'); };

definitionEditor = createDefinitionEditor({ getFiles: () => ({ primerFile, sampleFile }), saveBlob, onAvailabilityChanged: syncControls });
window.napDefinitions = definitionEditor;
window.napSplit = {
  get state() {
    return {busy,inputMode:definitionEditor.mode,revision:resultRevision,files:(latest?.summary.samples || []).map(sample=>({
      name:`output/${sample.sample}.fq`,sample:sample.sample,reads:sample.segments,
      size:latest.files.find(file=>file.name===`output/${sample.sample}.fq`)?.size || 0,
    }))};
  },
  setInputs({fastqFiles:inputs,primerFile:primer,sampleFile:sample}) {
    if(busy)throw Error('split-readsは処理中です。');
    if(!inputs?.length || !primer || !sample)throw Error('FASTQ、primer.fa、sample.txtが必要です。');
    definitionEditor.cancelImport();clearResults();fastqFiles=[...inputs];primerFile=primer;sampleFile=sample;
    definitionEditor.setMode('files');
    for(const id of ['fastq-files','primer-file','sample-file'])$(id).value='';
    inputInfo();status('入力を読み込みました');notifyState();void openDefinitionFiles();
  },
  async exportFastq(names,revision) {
    if(busy || !latest)throw Error('分割を完了してからFASTQを選択してください。');
    if(revision!==resultRevision)throw Error('分割結果が更新されました。選択し直してください。');
    const snapshot=latest,available=new Set(this.state.files.map(file=>file.name));
    if(!names?.length || new Set(names).size!==names.length || names.some(name=>!available.has(name)))throw Error('分割済みFASTQを選択してください。');
    const [blobs,runBlob]=await Promise.all([Promise.all(names.map(name=>client.readFile(name))),client.readFile('run.json')]);
    const run=JSON.parse(await runBlob.text());
    if(busy || latest!==snapshot || revision!==resultRevision)throw Error('分割結果が更新されたため、受け渡しを中止しました。');
    return {files:blobs.map((blob,index)=>new File([blob],names[index].split('/').at(-1),{type:'text/plain'})),
      provenance:{inputStage:'split-reads',splitRevision:revision,split:run,selectedFiles:names.map(name=>name.split('/').at(-1))}};
  },
};
notifyState();
