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

export function startMemoryMonitor({ elements = [], getResults, getWorkers = () => ({ bytes: 0, instances: 0, workers: 0 }), environment = window }) {
  const panels = new Set();
  const time = date => date.toLocaleTimeString('ja-JP', { hour12: false });
  let measured = null, measurementError = '', measuring = false, stopped = false;
  let stateKey, generation = 0, busy = false, needsMeasurement = false, measurementTimer;

  const watching = () => busy && environment.document.visibilityState !== 'hidden' && [...panels].some(panel => panel.isConnected && panel.open);
  function scheduleMeasurement() {
    if (stopped || measuring || measurementTimer !== undefined || !browserMemory(environment).canMeasure) return;
    if ((busy && !watching()) || (!needsMeasurement && !watching()) || (measurementError && !needsMeasurement)) return;
    // Give final result rendering and the completed worker's message handler
    // a task boundary before sampling. Measurement never blocks the next run.
    // While monitoring a run, leave at least 30 seconds between requests.
    // The browser may itself delay a sample until garbage collection.
    measurementTimer = environment.setTimeout(() => { measurementTimer = undefined; void measure(); }, needsMeasurement ? 1000 : 30000);
  }

  function updateActivity(results) {
    const key = JSON.stringify(results.map(stage => [stage.bytes, !!stage.busy, stage.revision || 0]));
    busy = results.some(stage => stage.busy);
    if (key === stateKey) return;
    const initial = stateKey === undefined;
    stateKey = key;
    if (initial) return;
    generation++; measurementError = '';
    environment.clearTimeout(measurementTimer); measurementTimer = undefined;
    needsMeasurement = true;
    scheduleMeasurement();
  }

  function refresh() {
    if (stopped) return;
    const { heap, budget, canMeasure } = browserMemory(environment);
    const results = getResults(), workers = getWorkers(), updated = `ヒープ・WASM情報は2秒ごとに更新 · ${time(new Date())}`;
    updateActivity(results);
    const stale = measured && measured.generation !== generation;
    for (const element of panels) {
      if (!element.isConnected) { panels.delete(element); continue; }
      const $ = id => element.querySelector(`#${id}`);
      const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
      const previous = measured ? `${time(measured.at)}の測定値。` : '';
      const automatic = busy ? '見出しを開いている間は解析中も30秒以上あけて再測定します。' : '解析終了後・結果変更後に自動で再測定します。';
      text('memory-app-label', stale ? 'NAPの使用量（前回の測定）' : 'NAPの使用量（ブラウザー推定）');
      text('memory-app-used', measured ? formatMemory(measured.bytes) : canMeasure ? '未測定' : '取得できません');
      text('memory-app-detail', !canMeasure ? 'このブラウザー・実行環境ではNAP全体の測定を利用できません。'
        : `${previous}${measuring ? '測定中です。ブラウザーのメモリー回収を待つため、数十秒かかる場合があります。'
          : measurementError || (stale ? '解析状態が変わったため、再測定待ちです。' : measured ? '画面・Workerを含む推定値で、瞬間的な実使用量とは異なります。' : '「NAPの使用量を測定」でフレーム・Workerを含む推定値を取得します。')}${automatic}`);
      $('memory-measure').disabled = !canMeasure || measuring;
      $('memory-measure').title = canMeasure ? '画面内のフレーム・Workerを含む使用量を手動で測定します。' : 'このブラウザー・実行環境ではNAP全体の測定を利用できません。';
      text('memory-heap-used', formatMemory(heap?.used));
      text('memory-live-detail', heap ? '即時に読める参考値です。別のWorker・WASMなどを含まない場合があります。' : 'このブラウザーはJavaScriptヒープ情報の取得に対応していません。');
      text('memory-wasm-used', formatMemory(workers.bytes));
      text('memory-wasm-detail', `稼働Worker：${workers.workers} / 実行中のWASM：${workers.instances}。計算用メモリー領域のサイズです。使用済みRAMやNAP全体の使用量ではありません。`);
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
    scheduleMeasurement();
  }

  async function measure() {
    if (stopped || measuring || !browserMemory(environment).canMeasure) return;
    environment.clearTimeout(measurementTimer); measurementTimer = undefined;
    const startedGeneration = generation;
    needsMeasurement = false;
    measuring = true; measurementError = ''; refresh();
    try {
      const result = await environment.performance.measureUserAgentSpecificMemory();
      if (!validBytes(result.bytes)) throw Error('Invalid measurement');
      if (!stopped && startedGeneration === generation) measured = { bytes: result.bytes, at: new Date(), generation };
    } catch { if (startedGeneration === generation) measurementError = 'NAPの使用量を測定できませんでした。'; }
    finally { measuring = false; refresh(); scheduleMeasurement(); }
  }

  function tick() {
    if (environment.document.visibilityState === 'hidden') {
      environment.clearTimeout(measurementTimer); measurementTimer = undefined; return;
    }
    refresh();
  }
  function stop() {
    stopped = true; environment.clearInterval(interval);
    environment.clearTimeout(measurementTimer);
    environment.document.removeEventListener('visibilitychange', tick);
    environment.removeEventListener('pagehide', pagehide);
  }
  const pagehide = event => { if (!event.persisted) stop(); };
  function addPanel(element) {
    if (stopped || panels.has(element)) return;
    panels.add(element);
    element.querySelector('#memory-refresh').onclick = refresh;
    element.querySelector('#memory-refresh').title = 'JSヒープ・実行中のWASM確保量・保持ファイルサイズを更新します。NAP全体の再測定は行いません。';
    element.querySelector('#memory-measure').onclick = measure;
    element.ontoggle = () => {
      environment.clearTimeout(measurementTimer); measurementTimer = undefined; refresh();
    };
    refresh();
  }
  const interval = environment.setInterval(tick, 2000);
  environment.document.addEventListener('visibilitychange', tick);
  environment.addEventListener('pagehide', pagehide);
  for (const element of elements) addPanel(element);
  return { refresh, stop, addPanel };
}
