import { escapeHtml, scriptJson, fileHref, resultTable, settingsSection, filesSection, resultPage } from '../../shared/result-page.mjs';
import { distributionChartSource } from './distribution-chart.mjs';

export const SPLIT_RESULT_PAGE = 'split-barcode-results.html';
const format = value => Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
const optionLabels = { task: 'BLAST 検索モード', word_size: 'word_size', primerCoverage: 'プライマー被覆率', primerIdentity: 'プライマー一致率 (%)', barcodeCoverage: 'バーコード被覆率', barcodeIdentity: 'バーコード一致率 (%)', batchSize: '1バッチのリード数', concurrency: '同時処理ファイル数', expand: '縮重塩基を展開', suppressChimeras: 'キメラを抑制', diagnostics: 'BLAST 判定根拠を保存' };

export function splitResultPage({ summary, options, fastqFiles, primerText = '', sampleText = '', diagnostics = false, execution, files, fastqOnly = false }) {
  const metrics = [['入力リード', summary.totalReads], ['分類済みリード', summary.assignedReads], ['未分類リード', summary.unassignedReads], ['出力配列', summary.segments], ['出力サンプル', summary.samples.length]];
  const rows = summary.samples.map((sample, index) => {
    const name = `${fastqOnly ? '' : 'output/'}${sample.sample}.fq`;
    return `<tr><td>${escapeHtml(sample.sample)}</td><td>${format(sample.segments)}</td><td>${format(sample.bases)}</td><td><dl class="length-statistics"><dt>最短 / 最長</dt><dd>${format(sample.minLength)} / ${format(sample.maxLength)}</dd><dt>平均長</dt><dd data-statistic="mean">${format(sample.meanLength)}</dd><dt>中央値</dt><dd data-statistic="median">${format(sample.medianLength)}</dd></dl></td><td><a href="${escapeHtml(fileHref(name))}" download>FASTQ</a></td><td class="distribution-cell"><div data-chart="length" data-sample-index="${index}"></div></td><td class="distribution-cell">${sample.qualityReads ? `<div data-chart="quality" data-sample-index="${index}"></div><p class="hint quality-coverage">品質情報あり ${format(sample.qualityReads)} / ${format(sample.segments)} 配列</p>` : '<p class="hint quality-coverage">ヘッダーに有効な品質情報なし</p>'}</td></tr>`;
  }).join('');
  const body = `<section><h2>分割結果</h2><div class="summary">${metrics.map(([label, value]) => `<div class="metric"><strong>${format(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}</div><p class="hint">${format(summary.completedFiles ?? fastqFiles.length)} 入力ファイル · ${format(summary.elapsedMs / 1000)} 秒</p><div class="table-scroll"><table id="sample-results"><thead><tr>${['サンプル', '出力配列数', '塩基数', 'リード長 (bp)', 'FASTQ', 'リード長分布', 'クオリティ分布'].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p class="hint">長さはプライマー除去後の配列です。長さ分布の縦軸は各区間の総塩基数（bp）、割合は全出力塩基数に対する割合です。品質分布は元リードのヘッダーQスコア（qs:f:など）だけを使用し、品質情報のない配列は除外します。棒にカーソルを重ねると区間・塩基数（長さ分布）・配列数・割合を表示します。</p>${summary.segments ? '' : '<p class="warning">条件を満たすプライマー対がありませんでした。</p>'}</section>
    <section><h2>入力 FASTQ</h2>${resultTable(['ファイル名', 'サイズ (B)'], fastqFiles.map(file => [file.name, format(file.size)]))}</section>
    ${settingsSection({ ...options, word_size: 4, diagnostics }, optionLabels)}
    <section><h2>解析に使用したプライマー・サンプル定義</h2><h3><a href="./primer.fa" download>primer.fa</a></h3><pre id="saved-primer">${escapeHtml(primerText)}</pre><h3><a href="./sample.txt" download>sample.txt</a></h3><pre id="saved-sample">${escapeHtml(sampleText)}</pre></section>
    ${execution?.files ? `<section><h2>入力ファイル別の実行結果</h2>${resultTable(['入力ファイル', '状態', '入力リード', '分類済みリード'], execution.files.map(file => [file.name, file.state === 'complete' ? '完了' : file.state, format(file.totalReads), format(file.assignedReads)]))}</section>` : ''}
    ${filesSection(files)}`;
  const script = `${distributionChartSource()}const samples=${scriptJson(summary.samples)};for(const node of document.querySelectorAll('[data-chart]'))node.append(distributionChart(samples[Number(node.dataset.sampleIndex)],node.dataset.chart));`;
  return resultPage({ title: 'NAP · split-barcode 結果', body, script });
}

export function inputDefinitionFiles({ primerText, sampleText }) {
  return [['primer.fa', primerText], ['sample.txt', sampleText]].filter(([, text]) => typeof text === 'string').map(([name, text]) => ({ name, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }));
}

export function splitFastqArchiveFiles(files) {
  return [
    ...files.filter(file => file.name.startsWith('output/') && file.name.endsWith('.fq')).map(file => ({ ...file, name: file.name.slice('output/'.length) })),
    ...files.filter(file => file.name === 'primer.fa' || file.name === 'sample.txt'),
  ];
}
