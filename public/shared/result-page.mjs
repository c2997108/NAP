export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const fileHref = name => './' + name.split('/').map(encodeURIComponent).join('/');

export function resultTable(headers, rows, id = '') {
  return `<div class="table-scroll"><table${id ? ` id="${escapeHtml(id)}"` : ''}><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function settingsSection(options, labels = {}) {
  const rows = Object.entries(options).map(([key, value]) => [labels[key] || key, typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : value]);
  return `<section><h2>実行条件</h2>${resultTable(['条件', '値'], rows, 'saved-options')}</section>`;
}

export function filesSection(files) {
  return `<section><h2>出力ファイル</h2><p class="hint">ZIPを展開したフォルダー内のファイルを開きます。</p><ul class="output-files">${files.map(file => `<li><a href="${escapeHtml(fileHref(file.name))}" download>${escapeHtml(file.name)}</a><span>${Number(file.size ?? file.blob?.size ?? 0).toLocaleString('ja-JP')} B</span></li>`).join('')}</ul></section>`;
}

export function resultPage({ title, body, script = '', savedAt = new Date().toISOString() }) {
  const date = new Date(savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f7f5;color:#203b33;font:14px system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:25px;margin:0 0 8px}h2{font-size:18px;margin:0 0 16px}h3{font-size:14px}section{background:white;border:1px solid #d8e2db;border-radius:8px;padding:22px;margin:20px 0}.hint,small{color:#627580;font-size:12px;line-height:1.7}a{color:#24777c;text-underline-offset:3px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:12px;border-bottom:1px solid #e7edef;white-space:nowrap;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#f4f7f8;color:#627580;font-weight:500}.summary{display:flex;flex-wrap:wrap;gap:28px}.metric strong{display:block;font-size:30px}.metric span{font-size:12px;color:#627580}.length-statistics{display:grid;grid-template-columns:auto auto;gap:8px 12px;margin:0;font-variant-numeric:tabular-nums}.length-statistics dt{text-align:left;color:#627580}.length-statistics dd{margin:0}#sample-results th:nth-last-child(-n+2){text-align:left}.distribution-cell{padding:8px;text-align:left}.distribution-chart{display:block;width:240px;height:auto}.chart-grid{stroke:#e7edef;stroke-width:1}.chart-axis{stroke:#8da0aa;stroke-width:1}.chart-tick,.chart-axis-label{fill:#627580;font-size:11px}.chart-bar{fill:#257b80}.quality-chart .chart-bar{fill:#8171ac}.chart-bar:hover{opacity:.7}.quality-coverage{text-align:center;white-space:normal;margin:4px 0}.output-files{list-style:none;padding:0}.output-files li{display:flex;justify-content:space-between;gap:20px;padding:7px 0}.output-files a{overflow-wrap:anywhere}.output-files span{white-space:nowrap;color:#627580}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f8;padding:14px;border-radius:5px;font:12px/1.7 ui-monospace,monospace}.warning{white-space:pre-wrap;color:#995146}.viewer-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.viewer-controls select{max-width:100%;padding:8px}.viewer-controls input,.viewer-controls select{margin:6px}.viewer-info{font-size:13px}.sequence-link{background:none;border:0;color:#24777c;text-decoration:underline;cursor:pointer;font:inherit}footer{color:#627580;font-size:12px}@media(max-width:600px){main{padding:12px}section{padding:14px}.summary{gap:18px}}@media print{body{background:white}main{padding:0}section{break-inside:avoid}.table-scroll{overflow:visible}.output-files{columns:2}}
</style></head><body><main><header><h1>${escapeHtml(title)}</h1><p class="hint">解析結果の保存ページ · 保存日時 ${escapeHtml(date)} JST<br>HTMLだけで結果を確認できます。追加のサーバーや解析環境は必要ありません。</p></header>${body}<footer>NAP · Nanopore Amplicon Pipeline</footer></main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
