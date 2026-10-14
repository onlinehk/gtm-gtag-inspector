/* global GA4_LABELS, decodeGA4Item, decodeGcs */
const $ = (s) => document.querySelector(s);
const main = $('#main');

let tabId = null;
let state = null;
let view = 'overview';
let filter = '';
const expanded = new Set();
const searchCache = new Map();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s).replace(/\s+/g, '-');
const badge = (type, text = type) => `<span class="badge b-${esc(cls(type))}">${esc(text)}</span>`;

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function jsonHTML(v) {
  return esc(JSON.stringify(v, null, 2)).replace(
    /(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,
    (m, str, colon, lit, num) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (lit) return `<span class="j-lit">${lit}</span>`;
      return `<span class="j-num">${num}</span>`;
    }
  );
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed'); }
}

// ---- Data ------------------------------------------------------------------

async function refresh() {
  if (tabId == null) return;
  state = await chrome.runtime.sendMessage({ kind: 'getState', tabId });
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 250);
}

function matches(e) {
  if (!filter) return true;
  let s = searchCache.get(e.id);
  if (!s) {
    s = JSON.stringify(e).toLowerCase();
    searchCache.set(e.id, s);
  }
  return filter.split(/\s+/).every((t) => s.includes(t));
}

// ---- Rendering -------------------------------------------------------------

function render() {
  if (!state) return;
  const ev = state.events;
  $('#url').textContent = state.url || '';
  $('#url').title = state.url || '';
  $('#c-hits').textContent = ev.filter((e) => e.kind === 'hit').length || '';
  $('#c-dl').textContent = ev.filter((e) => e.kind === 'dataLayer').length || '';
  $('#c-all').textContent = ev.length || '';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const scroll = main.scrollTop;
  if (view === 'overview') main.innerHTML = renderOverview();
  else {
    const kinds = { hits: ['hit'], datalayer: ['dataLayer'], timeline: ['hit', 'dataLayer', 'load', 'nav'] }[view];
    const list = ev.filter((e) => kinds.includes(e.kind) && (e.kind === 'nav' ? view === 'timeline' && !filter : matches(e)))
      .sort((a, b) => b.ts - a.ts || b.id - a.id);
    main.innerHTML = list.length ? list.map(rowHTML).join('') : emptyHTML();
  }
  main.scrollTop = scroll;
}

function emptyHTML() {
  if (filter) return `<div class="empty"><b>No matches</b>Nothing matches “${esc(filter)}”.</div>`;
  return `<div class="empty"><b>Nothing captured yet</b>Interact with the page or reload it — events appear here live.</div>`;
}

const TYPE_ORDER = ['GTM', 'Google Tag', 'GA4', 'Google Ads', 'Floodlight', 'Universal Analytics'];

function renderOverview() {
  const cs = Object.values(state.containers).sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a.type), ib = TYPE_ORDER.indexOf(b.type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.id.localeCompare(b.id);
  });
  const ev = state.events;
  const hits = ev.filter((e) => e.kind === 'hit');
  const count = (pred) => hits.filter(pred).length;

  let html = '<div class="section"><h3>Detected tags</h3>';
  if (!cs.length) {
    html += `<div class="empty" style="padding:24px"><b>No GTM or gtag found</b>No container or Google tag detected on this page yet. Try reloading the page.</div>`;
  } else {
    html += '<div class="cards">' + cs.map((c) => `
      <div class="card" data-filter="${esc(c.id)}" title="Click to show hits for ${esc(c.id)}">
        <div class="id"><span>${esc(c.id)}</span>${badge(c.type)}</div>
        <div class="meta">
          <span>Library loaded: <b>${c.loaded ? '✓ yes' : '—'}</b>${c.firstParty ? ' <span class="tag">first-party</span>' : ''}</span>
          <span>Hits: <b>${c.hits}</b>${c.dataLayer ? ` · dataLayer: <b>${esc(c.dataLayer)}</b>` : ''}</span>
          <span>Found via: ${esc(c.sources.join(', '))}</span>
        </div>
      </div>`).join('') + '</div>';
  }
  html += '</div>';

  html += `<div class="section"><h3>Summary</h3><div class="stats">
    ${stat(count((e) => e.type === 'GA4'), 'GA4 events')}
    ${stat(count((e) => e.type.startsWith('Ads')), 'Google Ads hits')}
    ${stat(count((e) => e.type === 'Floodlight'), 'Floodlight hits')}
    ${stat(count((e) => e.type === 'UA'), 'UA hits')}
    ${stat(ev.filter((e) => e.kind === 'dataLayer').length, 'dataLayer pushes')}
    ${stat(state.hasGtag ? '✓' : '—', 'gtag() defined')}
  </div></div>`;

  // Consent: from gtag('consent', ...) commands and the latest GA4 gcs value
  const keys = [...new Set([...Object.keys(state.consent.default || {}), ...Object.keys(state.consent.update || {})])];
  const lastGcs = [...hits].reverse().find((e) => e.params && e.params.gcs);
  if (keys.length || lastGcs) {
    html += '<div class="section"><h3>Consent mode</h3>';
    if (keys.length) {
      html += '<table><tr><th>Type</th><th>default</th><th>update</th></tr>' + keys.map((k) => `<tr>
        <td class="k">${esc(k)}</td>
        <td class="v">${consentVal(state.consent.default?.[k])}</td>
        <td class="v">${consentVal(state.consent.update?.[k])}</td></tr>`).join('') + '</table>';
    }
    if (lastGcs) {
      const g = decodeGcs(lastGcs.params.gcs);
      html += `<p class="muted">Latest hit gcs=<b>${esc(lastGcs.params.gcs)}</b>${g ? ` → ad_storage ${consentVal(g.ad_storage)}, analytics_storage ${consentVal(g.analytics_storage)}` : ''}</p>`;
    }
    html += '</div>';
  }
  if (state.dlNames && state.dlNames.length) {
    html += `<div class="section"><h3>dataLayer arrays</h3>${state.dlNames.map((n) => `<code>${esc(n)}</code>`).join(', ')}</div>`;
  }
  return html;
}

const stat = (n, l) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
const consentVal = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="${v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : ''}">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`);

function rowHTML(e) {
  if (e.kind === 'nav') {
    return `<div class="nav-row">${e.navType === 'history' ? '↪ History change' : '⟳ Navigated'} <b>${esc(e.url)}</b> · ${fmtTime(e.ts)}</div>`;
  }
  const open = expanded.has(e.id);
  let b, title, sub = '', id = '';
  if (e.kind === 'hit') {
    b = badge(e.type, e.type);
    title = e.name;
    id = e.tid || '';
    if (e.type === 'GA4' && e.params?.dl) {
      try { sub = new URL(e.params.dl).pathname; } catch { sub = e.params.dl; }
    } else sub = e.host;
    if (e.firstParty) sub += ' · first-party';
  } else if (e.kind === 'load') {
    b = badge(e.type, `${e.type} load`);
    title = e.id;
    sub = e.host + (e.firstParty ? ' · first-party' : '');
  } else {
    b = badge('dataLayer', e.isGtag ? 'gtag()' : 'dataLayer');
    title = e.label;
    sub = `#${e.index}${e.name !== 'dataLayer' ? ' · ' + e.name : ''}`;
  }
  return `<div class="row ${open ? 'open' : ''}" data-id="${e.id}">
    <div class="sum"><span class="caret">${open ? '▾' : '▸'}</span><span class="time">${fmtTime(e.ts)}</span>${b}
      <span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span><span class="id">${esc(id)}</span></div>
    ${open ? `<div class="detail">${detailHTML(e)}</div>` : ''}
  </div>`;
}

function kvTable(obj, labels = GA4_LABELS) {
  const entries = Object.entries(obj);
  if (!entries.length) return '';
  return '<table>' + entries.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="lbl">${esc(labels[k] || '')}</td><td class="v">${esc(v)}</td></tr>`).join('') + '</table>';
}

function itemsTable(items) {
  const cols = [...new Set(items.flatMap((i) => Object.keys(i)))];
  return `<div class="items"><table><tr><th>#</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` +
    items.map((it, i) => `<tr><td>${i + 1}</td>${cols.map((c) => `<td>${esc(it[c] ?? '')}</td>`).join('')}</tr>`).join('') + '</table></div>';
}

function groupGA4(p) {
  const g = { event: {}, ep: {}, up: {}, items: [], consent: {}, other: {} };
  for (const [k, v] of Object.entries(p)) {
    if (['en', 'tid', 'dl', 'dt', 'dr', 'cu'].includes(k)) g.event[k] = v;
    else if (/^epn?\./.test(k)) g.ep[k.replace(/^epn?\./, '')] = v;
    else if (/^upn?\./.test(k)) g.up[k.replace(/^upn?\./, '')] = v;
    else if (/^pr\d+$/.test(k)) g.items.push(decodeGA4Item(v));
    else if (['gcs', 'gcd', 'dma', 'dma_cps', 'npa'].includes(k)) g.consent[k] = v;
    else g.other[k] = v;
  }
  return g;
}

function detailHTML(e) {
  const tools = (payload) => `<div class="tools">
    <button data-copy="${esc(JSON.stringify(payload))}">Copy JSON</button>
    ${e.url ? `<button data-copy="${esc(e.url)}">Copy URL</button>` : ''}</div>`;

  if (e.kind === 'dataLayer') {
    return tools(e.data) + `<pre class="json">${jsonHTML(e.data)}</pre>`;
  }
  if (e.kind === 'load') {
    return tools({ id: e.id, url: e.url }) + kvTable({ id: e.id, dataLayer: e.dataLayer, host: e.host, url: e.url }, {});
  }

  let html = tools(e.params);
  if (e.type === 'GA4') {
    const g = groupGA4(e.params);
    html += `<h4>Event</h4>${kvTable(g.event)}`;
    if (Object.keys(g.ep).length) html += `<h4>Event parameters</h4>${kvTable(g.ep, {})}`;
    if (g.items.length) html += `<h4>Items (${g.items.length})</h4>${itemsTable(g.items)}`;
    if (Object.keys(g.up).length) html += `<h4>User properties</h4>${kvTable(g.up, {})}`;
    if (Object.keys(g.consent).length) {
      const d = decodeGcs(g.consent.gcs);
      html += `<h4>Consent</h4>${kvTable(g.consent)}`;
      if (d) html += `<p class="muted">ad_storage ${consentVal(d.ad_storage)} · analytics_storage ${consentVal(d.analytics_storage)}</p>`;
    }
    html += `<h4>Other / system</h4>${kvTable(g.other)}`;
  } else {
    html += `<h4>Parameters</h4>${kvTable(e.params)}`;
  }
  html += `<h4>Request</h4>${kvTable({ method: e.method, type: e.reqType, host: e.host, url: e.url }, {})}`;
  return html;
}

// ---- Events ----------------------------------------------------------------

main.addEventListener('click', (ev) => {
  const copyBtn = ev.target.closest('[data-copy]');
  if (copyBtn) { copy(copyBtn.dataset.copy); return; }

  const card = ev.target.closest('.card[data-filter]');
  if (card) {
    filter = card.dataset.filter.toLowerCase();
    $('#filter').value = card.dataset.filter;
    view = 'hits';
    render();
    return;
  }

  const sum = ev.target.closest('.sum');
  if (sum) {
    const id = Number(sum.parentElement.dataset.id);
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  }
});

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-view]');
  if (!b) return;
  view = b.dataset.view;
  main.scrollTop = 0;
  render();
});

$('#filter').addEventListener('input', (ev) => {
  filter = ev.target.value.trim().toLowerCase();
  if (view === 'overview' && filter) view = 'timeline';
  render();
});

$('#preserve').addEventListener('change', (ev) => {
  chrome.storage.local.set({ preserveLog: ev.target.checked });
});

$('#clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'clear', tabId });
  expanded.clear();
  searchCache.clear();
  refresh();
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  let host = 'page';
  try { host = new URL(state.url).hostname; } catch {}
  a.download = `gtm-inspector-${host}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.kind === 'update' && m.tabId === tabId) scheduleRefresh();
});

(async function init() {
  const inDevtools = !!(chrome.devtools && chrome.devtools.inspectedWindow);
  document.body.classList.toggle('devtools', inDevtools);
  if (inDevtools) tabId = chrome.devtools.inspectedWindow.tabId;
  else {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t?.id ?? null;
  }
  const { preserveLog = false } = await chrome.storage.local.get('preserveLog');
  $('#preserve').checked = preserveLog;
  await refresh();
})();
