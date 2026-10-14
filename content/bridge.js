// Isolated-world relay: forwards messages from inject.js (page world) to the service worker.
(() => {
  const SRC = '__gtm_gtag_inspector__';
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== SRC) return;
    try {
      chrome.runtime.sendMessage({ kind: 'page', type: d.type, payload: d.payload }).catch(() => {});
    } catch {
      // Extension was reloaded; this content script is orphaned.
    }
  });
})();
