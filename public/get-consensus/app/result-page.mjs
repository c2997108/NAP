import { escapeHtml, scriptJson, resultTable, settingsSection, filesSection, resultPage } from '../../shared/result-page.mjs';
import { alignmentViewer } from './viewer.mjs';

export const CONSENSUS_RESULT_PAGE = 'get-consensus-results.html';
const format = value => Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 });
const optionLabels = { firstIdentity: '初回クラスタリングの同一率', minReads: 'クラスターの最小リード数', maxReads: 'コンセンサスに用いる最大リード数', secondIdentity: '2回目クラスタリングの同一率', allIdentity: '全サンプル統合の同一率', minDepth: 'ハプロタイプの最小深度', parallelSamples: '同時に処理するサンプル数', strand: 'VSEARCH の鎖方向', adjustDirection: 'MAFFT で配列の向きをそろえる', haplotypes: 'ハプロタイプを分離', blastIdentity: 'BLAST 最小同一率', minBitscore: 'BLAST 最小 bitscore', batchSize: 'BLAST 1バッチのリード数' };

export function consensusResultPage(result, logText = '') {
  const { manifest, samples, rows } = result;
  const alignments = [{ id: '全代表配列', alignment: result.alignment }, ...result.entries.map(entry => ({ id: entry.id, alignment: entry.alignment }))];
  const warnings = [...manifest.warnings, ...(rows.length ? [] : ['BLAST の閾値を満たすヒットがありません。コンセンサス配列は保存できます。'])];
  const body = `<section><h2>解析結果</h2><p id="metrics">${format(samples.length)} サンプル / ${format(manifest.consensuses)} コンセンサス / ${format(manifest.representatives)} 代表配列</p><p id="warnings" class="warning">${escapeHtml(warnings.join('\n'))}</p>
    ${resultTable(['代表配列', '長さ', ...result.names, '合計'], rows.map(row => [row.id, format(row.seq.length), ...row.counts.map(format), format(row.total)]), 'counts')}</section>
    <section><h2>入力サンプル別の結果</h2>${resultTable(['FASTQ', '入力リード', '初回クラスター', '統合', 'ハプロタイプ', '割当リード'], samples.map(sample => [sample.filename, ...[sample.reads, sample.round1, sample.round2, sample.haplotypes, sample.assigned].map(format)]))}</section>
    ${settingsSection(manifest.options, optionLabels)}
    <section id="saved-alignment"><h2>アラインメント</h2><div id="alignment"></div><p class="hint">代表配列の名前を押すと対応するアラインメントを表示します。選択・拡大・差分の強調を保存後も使用できます。</p></section>
    ${manifest.nap ? `<section><h2>split-reads からの受け渡し情報</h2><details><summary>分割の条件・選択ファイルを確認</summary><pre>${escapeHtml(JSON.stringify(manifest.nap, null, 2))}</pre></details></section>` : ''}
    <section><h2>実行情報</h2>${resultTable(['項目', '値'], [['解析開始', manifest.started], ['解析終了', manifest.finished], ...Object.entries(manifest.versions || {}).map(([name, version]) => [name, version])])}<details><summary>処理ログ</summary><pre id="saved-log">${escapeHtml(logText)}</pre></details></section>
    ${filesSection([...result.files].map(([name, blob]) => ({ name, size: blob.size })))}`;
  const script = `const savedViewer=(${alignmentViewer.toString()})(document.getElementById('alignment'),${scriptJson(alignments)});const sequenceIds=${scriptJson(rows.map(row => row.id))};document.querySelectorAll('#counts tbody tr').forEach((row,index)=>{const button=document.createElement('button');button.className='sequence-link';button.textContent=sequenceIds[index];button.onclick=()=>{savedViewer.select(sequenceIds[index]);document.getElementById('saved-alignment').scrollIntoView({behavior:'smooth'});};row.cells[0].replaceChildren(button);});`;
  return resultPage({ title: 'NAP · get-consensus 結果', body, script });
}
