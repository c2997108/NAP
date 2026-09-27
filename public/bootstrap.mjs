import { ensureCrossOriginIsolation } from './isolation.mjs';

// Keep input controls and iframes inactive until the initial reload is over.
const blocked = [...document.body.children].map(element => [element, element.inert]);
for (const [element] of blocked) element.inert = true;
const notice = document.createElement('p');
notice.textContent = 'ブラウザの解析環境を準備しています…';
notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
notice.style.cssText = 'margin:16px auto;padding:16px 24px;max-width:1100px;background:#edf5ef;color:#183e32;border:1px solid #a9c7b4;border-radius:8px;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere';
document.body.prepend(notice);
document.documentElement.dataset.napIsolation = 'preparing';
let ready = false;
try { ready = await ensureCrossOriginIsolation(); }
catch (error) {
  document.documentElement.dataset.napIsolation = 'failed';
  notice.textContent = error.message; notice.setAttribute('role', 'alert');
  notice.style.background = '#fff0ed'; notice.style.color = '#842b20';
  console.error('NAP startup:', error.message);
}
if (ready) {
  const entry = document.querySelector('script[data-nap-app]');
  for (const frame of document.querySelectorAll('iframe[data-src]')) frame.src = frame.dataset.src;
  await import(new URL(entry.dataset.napApp, document.baseURI).href);
  for (const [element, inert] of blocked) element.inert = inert;
  notice.remove(); document.documentElement.dataset.napIsolation = 'ready';
  window.dispatchEvent(new Event('nap:ready'));
}
