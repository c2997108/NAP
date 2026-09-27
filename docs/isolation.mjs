// Use the bundled coi-serviceworker only as a worker. Its page-side automatic
// update/reload code is intentionally not loaded, so running analyses keep their state.
const workerURL = new URL('./coi-serviceworker.js', import.meta.url);
const reloadKey = 'napIsolationReload';

function clearReloadMarker() {
  if (history.state?.[reloadKey] !== workerURL.href) return;
  const state = { ...history.state }; delete state[reloadKey];
  history.replaceState(Object.keys(state).length ? state : null, '');
}

function waitForActivation(registration) {
  return new Promise((resolve, reject) => {
    const watched = new Set();
    const finish = error => {
      clearTimeout(timer); registration.removeEventListener('updatefound', check);
      for (const worker of watched) worker.removeEventListener('statechange', check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (registration.active?.state === 'activated') { finish(); return; }
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener('statechange', check); }
      }
    };
    const timer = setTimeout(() => finish(new Error('解析環境の準備が完了しませんでした。ページを再読み込みしてください。')), 15000);
    registration.addEventListener('updatefound', check); check();
  });
}

export async function ensureCrossOriginIsolation() {
  if (globalThis.crossOriginIsolated) { clearReloadMarker(); return true; }
  if (window.top !== window) throw Error('NAPのトップページを直接開いて、解析環境を準備してください。');
  if (!isSecureContext) throw Error('このページを HTTPS または localhost で開いてください。');
  if (!navigator.serviceWorker) throw Error('Service Workerを利用できません。対応ブラウザの通常のウィンドウで開いてください。');
  // At most one automatic reload per startup, even when isolation is blocked.
  // History state also works when sessionStorage is unavailable.
  if (history.state?.[reloadKey] === workerURL.href) {
    clearReloadMarker();
    throw Error('解析環境を準備できませんでした。ブラウザでService Workerを許可してから再読み込みしてください。');
  }
  let registration;
  try {
    registration = await navigator.serviceWorker.register(workerURL.href, {
      scope: new URL('./', import.meta.url).href, updateViaCache: 'none',
    });
  } catch (error) {
    throw Error(`解析環境の補助ファイルを読み込めませんでした。公開ファイルとブラウザの設定を確認してください。 (${error.message})`);
  }
  await waitForActivation(registration);
  history.replaceState({ ...history.state, [reloadKey]: workerURL.href }, '');
  location.reload();
  return false;
}
