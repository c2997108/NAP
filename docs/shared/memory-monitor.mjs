import { memoryBudget } from './parallel-settings.mjs';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const validBytes = value => Number.isFinite(value) && value >= 0;
export function formatMemory(bytes) {
  if (!validBytes(bytes)) return '取得できません';
  if (bytes === 0) return '0 MiB';
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KiB`;
  return bytes < GiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${(bytes / GiB).toFixed(2)} GiB`;
}

export function browserMemory(environment = globalThis) {
  const memory = environment.performance?.memory;
  const heap = memory && [memory.usedJSHeapSize, memory.totalJSHeapSize, memory.jsHeapSizeLimit].every(validBytes) && memory.jsHeapSizeLimit > 0
    ? { used: memory.usedJSHeapSize, allocated: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit,
      headroom: Math.max(0, memory.jsHeapSizeLimit - memory.usedJSHeapSize) } : null;
  return { heap, budget: memoryBudget({}, environment.navigator || {}),
    canMeasure: environment.crossOriginIsolated === true && typeof environment.performance?.measureUserAgentSpecificMemory === 'function' };
}

export function startMemoryMonitor({ elements = [], getResults, environment = window }) {
  const panels = new Set();
  const time = date => date.toLocaleTimeString('ja-JP', { hour12: false });
  let measured = null, measurementError = '', measuring = false, stopped = false;

  function refresh() {
    if (stopped) return;
    const { heap, budget, canMeasure } = browserMemory(environment);
    const results = getResults(), updated = `簡易情報は5秒ごとに更新 · ${time(new Date())}`;
    for (const element of panels) {
      if (!element.isConnected) { panels.delete(element); continue; }
      const $ = id => element.querySelector(`#${id}`);
      const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
      text('memory-app-label', measured ? 'NAPの使用量（ブラウザー推定）' : 'JavaScriptヒープ使用量（参考）');
      text('memory-app-used', formatMemory(measured?.bytes ?? heap?.used));
      text('memory-app-detail', measuring ? 'NAPの使用量を測定中です。完了まで時間がかかる場合があります。'
        : measurementError ? `${measurementError}${measured ? ` ${time(measured.at)}の測定値を表示しています。` : ' 簡易使用量を表示しています。'}`
          : (measured ? `${time(measured.at)} 測定。画面・解析処理を含む推定値です。`
          : heap ? '計算用Workerなどを含まない場合があります。NAP全体の使用量とは異なります。'
            : 'このブラウザーは簡易使用量の取得に対応していません。'));
      $('memory-measure').disabled = !canMeasure || measuring;
      $('memory-measure').title = canMeasure ? '画面内のフレーム・Workerを含む使用量を手動で測定します。' : 'このブラウザー・実行環境ではNAP全体の測定を利用できません。';
      text('memory-heap-limit', formatMemory(heap?.limit));
      text('memory-headroom', formatMemory(heap?.headroom));
      text('memory-device', formatMemory(budget.deviceMemoryGB === null ? null : budget.deviceMemoryGB * GiB));
      text('memory-heap-detail', heap ? `現在の使用量：${formatMemory(heap.used)}。上限までの差：${formatMemory(heap.headroom)}。確保済み：${formatMemory(heap.allocated)}。実際に確保できる量の保証ではありません。`
        : 'JavaScriptヒープの情報を取得できません。');
      text('memory-auto-budget', formatMemory(budget.budgetMB * MiB));
      text('memory-budget-detail', budget.deviceMemoryGB === null ? '端末RAMの概算が取得できない場合の既定値です。'
        : `ブラウザーのRAM概算 ${formatMemory(budget.deviceMemoryGB * GiB)} の25%。空きRAMの実測値ではありません。`);
      text('memory-results', formatMemory(results.reduce((sum, stage) => sum + stage.bytes, 0)));
      text('memory-results-detail', results.map(stage => `${stage.name}：${formatMemory(stage.bytes)}`).join(' / '));
      text('memory-updated', updated);
    }
  }

  async function measure() {
    if (stopped || measuring || !browserMemory(environment).canMeasure) return;
    measuring = true; measurementError = ''; refresh();
    try {
      const result = await environment.performance.measureUserAgentSpecificMemory();
      if (!validBytes(result.bytes)) throw Error('Invalid measurement');
      measured = { bytes: result.bytes, at: new Date() };
    } catch { measurementError = 'NAPの使用量を測定できませんでした。'; }
    finally { measuring = false; refresh(); }
  }

  function tick() {
    if (environment.document.visibilityState === 'hidden') return;
    refresh();
  }
  function stop() {
    stopped = true; environment.clearInterval(interval);
    environment.document.removeEventListener('visibilitychange', tick);
    environment.removeEventListener('pagehide', pagehide);
  }
  const pagehide = event => { if (!event.persisted) stop(); };
  function addPanel(element) {
    if (stopped || panels.has(element)) return;
    panels.add(element);
    element.querySelector('#memory-refresh').onclick = refresh;
    element.querySelector('#memory-measure').onclick = measure;
    refresh();
  }
  const interval = environment.setInterval(tick, 5000);
  environment.document.addEventListener('visibilitychange', tick);
  environment.addEventListener('pagehide', pagehide);
  for (const element of elements) addPanel(element);
  return { refresh, stop, addPanel };
}
