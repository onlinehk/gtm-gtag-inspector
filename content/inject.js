// Runs in the page's MAIN world at document_start.
// Watches dataLayer arrays and detects GTM / gtag containers, then posts to bridge.js.
(() => {
  if (window.__GTM_GTAG_INSPECTOR__) return;
  window.__GTM_GTAG_INSPECTOR__ = true;

  const SRC = '__gtm_gtag_inspector__';
  const ID_RE = /^(GTM|G|AW|DC|GT|UA|MC)-[A-Za-z0-9-]+$/;

  const post = (type, payload) => {
    try { window.postMessage({ source: SRC, type, payload }, '*'); } catch {}
  };

  const isArguments = (v) => Object.prototype.toString.call(v) === '[object Arguments]';

  function serialize(v, depth = 0, ancestors = new WeakSet()) {
    if (v === undefined) return '[undefined]';
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v);
    if (t === 'bigint' || t === 'symbol') return v.toString();
    if (t === 'function') return `[Function${v.name ? ' ' + v.name : ''}]`;
    if (depth > 8) return '[MaxDepth]';
    try {
      if (v === window) return '[Window]';
      if (typeof Document !== 'undefined' && v instanceof Document) return '[Document]';
      if (typeof Element !== 'undefined' && v instanceof Element) {
        const id = v.id ? '#' + v.id : '';
        const cls = typeof v.className === 'string' && v.className.trim()
          ? '.' + v.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        return `<${v.tagName.toLowerCase()}${id}${cls}>`;
      }
      if (v instanceof Date) return v.toISOString();
      if (v instanceof RegExp) return v.toString();
    } catch {}
    if (ancestors.has(v)) return '[Circular]';
    ancestors.add(v);
    let out;
    if (Array.isArray(v) || isArguments(v)) {
      out = Array.from(v).slice(0, 200).map((x) => serialize(x, depth + 1, ancestors));
    } else {
      out = {};
      let n = 0;
      for (const k in v) {
        if (n++ >= 200) { out['…'] = '[truncated]'; break; }
        try { out[k] = serialize(v[k], depth + 1, ancestors); } catch { out[k] = '[Unreadable]'; }
      }
    }
    ancestors.delete(v);
    return out;
  }

  // ---- dataLayer watching -------------------------------------------------
  const watched = new Map(); // name -> last processed index
  const watch = (name) => { if (name && !watched.has(name)) watched.set(name, 0); };
  watch('dataLayer');

  function hookPush(arr) {
    if (!arr.push || arr.push.__gti) return;
    const orig = arr.push;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(scan);
      return r;
    };
    wrapped.__gti = true;
    try { arr.push = wrapped; } catch {}
  }

  function scan() {
    const items = [];
    for (const [name, last] of watched) {
      const dl = window[name];
      if (!Array.isArray(dl)) continue;
      // GTM replaces push when it loads; re-wrap so new pushes are reported promptly.
      hookPush(dl);
      const start = last > dl.length ? 0 : last;
      for (let i = start; i < dl.length; i++) {
        const raw = dl[i];
        items.push({
          name,
          index: i,
          ts: Date.now(),
          isGtag: isArguments(raw),
          data: serialize(raw),
        });
      }
      watched.set(name, dl.length);
    }
    if (items.length) post('dataLayer', { items });
  }

  // ---- container detection -----------------------------------------------
  let lastContainers = '';
  function detect() {
    const ids = {};
    const add = (id, source, dataLayer) => {
      if (!id || !ID_RE.test(id)) return;
      ids[id] ||= { id, source };
      if (dataLayer) { ids[id].dataLayer = dataLayer; watch(dataLayer); }
    };

    const gtm = window.google_tag_manager;
    if (gtm && typeof gtm === 'object') {
      for (const k of Object.keys(gtm)) {
        let dlName;
        try { dlName = gtm[k] && gtm[k].dataLayer && gtm[k].dataLayer.name; } catch {}
        add(k, 'google_tag_manager', dlName);
      }
    }

    document.querySelectorAll('script[src]').forEach((s) => {
      let u;
      try { u = new URL(s.src, location.href); } catch { return; }
      if (/\/gtm\.js$/.test(u.pathname)) add(u.searchParams.get('id'), 'gtm.js <script>', u.searchParams.get('l'));
      else if (/\/gtag\/js$/.test(u.pathname)) add(u.searchParams.get('id'), 'gtag.js <script>', u.searchParams.get('l'));
    });

    // <noscript> iframe fallback snippet
    document.querySelectorAll('noscript').forEach((n) => {
      const m = (n.textContent || '').match(/googletagmanager\.com\/ns\.html\?id=(GTM-[A-Z0-9]+)/);
      if (m) add(m[1], 'noscript snippet');
    });

    const payload = {
      ids: Object.values(ids),
      hasGtag: typeof window.gtag === 'function',
      dlNames: [...watched.keys()].filter((n) => Array.isArray(window[n])),
    };
    const json = JSON.stringify(payload);
    if (json !== lastContainers) {
      lastContainers = json;
      post('containers', payload);
    }
    scan();
  }

  setInterval(scan, 500);
  document.addEventListener('DOMContentLoaded', detect);
  window.addEventListener('load', detect);
  [1000, 3000, 6000, 12000].forEach((t) => setTimeout(detect, t));
  queueMicrotask(scan);
})();
