// Service worker: collects network hits + page-reported data per tab.

const MAX_EVENTS = 600;
const ID_RE = /^(GTM|G|AW|DC|GT|UA|MC)-[A-Za-z0-9-]+$/;

const states = new Map(); // tabId -> Promise<state>
const saveTimers = new Map();
const notifyTimers = new Map();

let preserveLogP = chrome.storage.local.get({ preserveLog: false }).then((r) => !!r.preserveLog);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && 'preserveLog' in c) preserveLogP = Promise.resolve(!!c.preserveLog.newValue);
});

const storageKey = (tabId) => `tab_${tabId}`;
const newState = (url = '') => ({ url, containers: {}, consent: {}, events: [], seq: 0, hitCount: 0, hasGtag: false, dlNames: [] });

function getState(tabId) {
  if (!states.has(tabId)) {
    const k = storageKey(tabId);
    states.set(tabId, chrome.storage.session.get(k).then((r) => r[k] || newState()).catch(() => newState()));
  }
  return states.get(tabId);
}

async function mutate(tabId, fn) {
  const s = await getState(tabId);
  fn(s);
  schedule(tabId);
}

function reset(tabId, url) {
  states.set(tabId, Promise.resolve(newState(url)));
}

function schedule(tabId) {
  if (!saveTimers.has(tabId)) {
    saveTimers.set(tabId, setTimeout(async () => {
      saveTimers.delete(tabId);
      const s = await getState(tabId);
      chrome.storage.session.set({ [storageKey(tabId)]: s }).catch(() => {});
    }, 300));
  }
  if (!notifyTimers.has(tabId)) {
    notifyTimers.set(tabId, setTimeout(async () => {
      notifyTimers.delete(tabId);
      const s = await getState(tabId);
      chrome.runtime.sendMessage({ kind: 'update', tabId }).catch(() => {});
      updateBadge(tabId, s);
    }, 120));
  }
}

function updateBadge(tabId, s) {
  const n = s.hitCount;
  const text = n ? (n > 999 ? '999+' : String(n)) : (Object.keys(s.containers).length ? '•' : '');
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' }).catch(() => {});
}

function containerType(id) {
  const p = id.split('-')[0].toUpperCase();
  return { GTM: 'GTM', G: 'GA4', AW: 'Google Ads', DC: 'Floodlight', GT: 'Google Tag', UA: 'Universal Analytics', MC: 'Merchant Center' }[p] || p;
}

function touchContainer(s, id, source, extra) {
  if (!id || !ID_RE.test(id)) return null;
  const c = (s.containers[id] ||= { id, type: containerType(id), sources: [], loaded: false, hits: 0 });
  if (source && !c.sources.includes(source)) c.sources.push(source);
  if (extra) Object.assign(c, extra);
  return c;
}

function addEvent(s, e) {
  e.id = ++s.seq;
  e.ts ||= Date.now();
  s.events.push(e);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
}

// ---- Network parsing -------------------------------------------------------

const qsToObj = (sp) => {
  const o = {};
  for (const [k, v] of sp) o[k] = v;
  return o;
};

function bodyText(rb) {
  if (!rb) return '';
  if (rb.raw) {
    const dec = new TextDecoder();
    return rb.raw.map((p) => (p.bytes ? dec.decode(p.bytes) : '')).join('');
  }
  if (rb.formData) {
    const sp = new URLSearchParams();
    for (const [k, vals] of Object.entries(rb.formData)) vals.forEach((v) => sp.append(k, v));
    return sp.toString();
  }
  return '';
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function parseRequest(d) {
  const url = d.url;
  if (!/collect|gtm\.js|gtag\/js|pagead|activity|ccm/.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname, path = u.pathname, q = u.searchParams;
  const base = { url, method: d.method, host, reqType: d.type, ts: Math.round(d.timeStamp) };

  // Container library loads (also catches first-party / server-side GTM hosts)
  if (/\/gtm\.js$/.test(path) && q.get('id')) {
    return [{ ...base, kind: 'load', type: 'GTM', id: q.get('id'), dataLayer: q.get('l') || 'dataLayer', firstParty: !host.endsWith('googletagmanager.com') }];
  }
  if (/\/gtag\/js$/.test(path) && q.get('id')) {
    return [{ ...base, kind: 'load', type: 'gtag', id: q.get('id'), dataLayer: q.get('l') || 'dataLayer', firstParty: !host.endsWith('googletagmanager.com') }];
  }

  // GA4 — URL holds shared params, each body line is one batched event
  if (/\/g\/collect$/.test(path)) {
    const shared = qsToObj(q);
    if (shared.v && shared.v !== '2') return null;
    const lines = bodyText(d.requestBody).split(/\r?\n/).filter(Boolean);
    const list = lines.length ? lines.map((l) => ({ ...shared, ...qsToObj(new URLSearchParams(l)) })) : [shared];
    return list.map((p) => ({ ...base, kind: 'hit', type: 'GA4', tid: p.tid, name: p.en || '(no event name)', params: p, firstParty: !/google-analytics\.com$/.test(host) }));
  }

  // Universal Analytics (legacy)
  if (/\/(r\/|j\/)?collect$/.test(path) && (host.includes('google-analytics.com') || q.get('v') === '1')) {
    const p = { ...qsToObj(q), ...qsToObj(new URLSearchParams(bodyText(d.requestBody))) };
    if (p.v !== '1') return null;
    const name = p.t === 'event' ? `event: ${p.ec || ''} / ${p.ea || ''}` : (p.t || 'hit');
    return [{ ...base, kind: 'hit', type: 'UA', tid: p.tid, name, params: p }];
  }

  // Google Ads conversion / remarketing
  const m = path.match(/\/pagead\/(conversion|viewthroughconversion|1p-conversion|1p-user-list)\/(\d+)\/?/);
  if (m && /(googleadservices\.com|google\.[a-z.]+|doubleclick\.net)$/.test(host)) {
    const p = qsToObj(q);
    const ev = ((p.data || '').match(/(?:^|;)event=([^;]+)/) || [])[1];
    const type = /conversion$/.test(m[1]) && m[1] !== 'viewthroughconversion' ? 'Ads Conversion' : 'Ads Remarketing';
    const name = [ev || p.en, p.label && `label=${p.label}`].filter(Boolean).join(' · ') || m[1];
    return [{ ...base, kind: 'hit', type, tid: `AW-${m[2]}`, name, endpoint: m[1], params: { endpoint: m[1], ...p } }];
  }

  // Floodlight (params live in the path: /activity;src=1;type=x;cat=y)
  if (/doubleclick\.net$/.test(host) && /\/activity/.test(path)) {
    const p = {};
    path.split(';').slice(1).forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) p[kv.slice(0, i)] = safeDecode(kv.slice(i + 1));
    });
    Object.assign(p, qsToObj(q));
    if (!p.src) return null;
    return [{ ...base, kind: 'hit', type: 'Floodlight', tid: `DC-${p.src}`, name: `${p.type || '?'} / ${p.cat || '?'}`, params: p }];
  }

  // Google tag first-party collection
  if (/\/ccm\/(collect|form-data)$/.test(path)) {
    const p = qsToObj(q);
    return [{ ...base, kind: 'hit', type: 'Google Tag', tid: p.tid, name: p.en || 'ccm/collect', params: p }];
  }

  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    let parsed;
    try { parsed = parseRequest(d); } catch { return; }
    if (!parsed || !parsed.length) return;
    mutate(d.tabId, (s) => {
      for (const e of parsed) {
        if (e.kind === 'load') {
          touchContainer(s, e.id, e.type === 'GTM' ? 'gtm.js request' : 'gtag.js request', { loaded: true, firstParty: e.firstParty, dataLayer: e.dataLayer });
        } else {
          const c = touchContainer(s, e.tid, 'network hit');
          if (c) c.hits++;
          s.hitCount++;
        }
        addEvent(s, e);
      }
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ---- Navigation ------------------------------------------------------------

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const preserve = await preserveLogP;
  if (!preserve) reset(d.tabId, d.url);
  mutate(d.tabId, (s) => {
    s.url = d.url;
    if (preserve) s.hitCount = 0;
    addEvent(s, { kind: 'nav', url: d.url, navType: d.transitionType });
  });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  mutate(d.tabId, (s) => {
    s.url = d.url;
    addEvent(s, { kind: 'nav', url: d.url, navType: 'history' });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  states.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
});

// ---- Messages --------------------------------------------------------------

function handlePage(tabId, type, p) {
  mutate(tabId, (s) => {
    if (type === 'dataLayer') {
      for (const item of p.items || []) {
        const e = { kind: 'dataLayer', ts: item.ts, name: item.name, index: item.index, data: item.data, isGtag: item.isGtag };
        if (item.isGtag && Array.isArray(item.data)) {
          const [cmd, a, b] = item.data;
          e.label = `gtag('${cmd}'${typeof a === 'string' ? `, '${a}'` : ''})`;
          if (cmd === 'event') e.event = a;
          if (cmd === 'config' && typeof a === 'string') touchContainer(s, a, "gtag('config')");
          if (cmd === 'consent' && b && typeof b === 'object' && (a === 'default' || a === 'update')) {
            s.consent[a] = { ...(s.consent[a] || {}), ...b };
          }
        } else if (item.data && typeof item.data === 'object' && !Array.isArray(item.data)) {
          e.event = item.data.event;
          e.label = item.data.event || '(push without event)';
        } else {
          e.label = String(item.data);
        }
        addEvent(s, e);
      }
    } else if (type === 'containers') {
      for (const c of p.ids || []) touchContainer(s, c.id, c.source, c.dataLayer ? { dataLayer: c.dataLayer } : null);
      s.hasGtag = !!p.hasGtag;
      s.dlNames = p.dlNames || [];
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'page') {
    if (sender.tab && sender.frameId === 0) handlePage(sender.tab.id, msg.type, msg.payload || {});
    return;
  }
  if (msg.kind === 'getState') {
    getState(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.kind === 'clear') {
    // Keep detected containers/consent; drop the event log.
    mutate(msg.tabId, (s) => {
      s.events = [];
      s.hitCount = 0;
      Object.values(s.containers).forEach((c) => { c.hits = 0; });
    }).then(() => {
      sendResponse(true);
    });
    return true;
  }
});
