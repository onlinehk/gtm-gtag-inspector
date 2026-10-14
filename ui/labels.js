// Human-readable labels for common Google tag hit parameters.
const GA4_LABELS = {
  v: 'Protocol version', tid: 'Measurement ID', gtm: 'GTM / gtag build hash', _p: 'Page load ID',
  cid: 'Client ID', uid: 'User ID', sid: 'Session ID', sct: 'Session count', seg: 'Session engaged',
  _s: 'Hit sequence', _et: 'Engagement time (ms)', _ss: 'Session start', _fv: 'First visit', _nsi: 'New session ID',
  _dbg: 'Debug mode', dl: 'Page location', dr: 'Referrer', dt: 'Page title', ul: 'Language',
  sr: 'Screen resolution', en: 'Event name', cu: 'Currency', gcs: 'Consent state', gcd: 'Consent default/update',
  dma: 'DMA flag', dma_cps: 'DMA consent purposes', npa: 'Non-personalized ads', tfd: 'Time to first dispatch',
  frm: 'In iframe', pscdl: 'Privacy sandbox CDL', _eu: 'Event usage flags', are: 'Ads remarketing',
  uaa: 'UA arch', uab: 'UA bitness', uafvl: 'UA full version list', uamb: 'UA mobile', uam: 'UA model',
  uap: 'UA platform', uapv: 'UA platform version', uaw: 'UA wow64', tag_exp: 'Tag experiments',
  ecid: 'Enhanced conversions ID', em: 'Hashed user data', _gaz: 'GA cookie flag', _uip: 'User IP override',
  // UA
  t: 'Hit type', ec: 'Event category', ea: 'Event action', el: 'Event label', ev: 'Event value', ni: 'Non-interaction',
  dp: 'Document path', dh: 'Document host', je: 'Java enabled', sd: 'Screen colors', vp: 'Viewport size', de: 'Encoding',
  // Ads
  label: 'Conversion label', value: 'Conversion value', currency_code: 'Currency', oid: 'Order / transaction ID',
  url: 'Page URL', ref: 'Referrer', data: 'Event data', random: 'Cache buster', cv: 'Container version',
  fst: 'First seen time', fmt: 'Format', gclaw: 'GCLID (aw cookie)', gclid: 'GCLID', auid: 'Ads user ID', endpoint: 'Endpoint',
  // Floodlight
  src: 'Advertiser ID', type: 'Activity group', cat: 'Activity tag', ord: 'Order / cache buster', num: 'Number', qty: 'Quantity', cost: 'Revenue',
};

const ITEM_KEYS = {
  id: 'item_id', nm: 'item_name', br: 'item_brand', ca: 'item_category', c2: 'item_category2', c3: 'item_category3',
  c4: 'item_category4', c5: 'item_category5', va: 'item_variant', pr: 'price', qt: 'quantity', cp: 'coupon',
  ln: 'item_list_name', li: 'item_list_id', lp: 'index', af: 'affiliation', ds: 'discount', lo: 'location_id', ps: 'promotion_id',
  pn: 'promotion_name', cn: 'creative_name', cs: 'creative_slot',
};

// GA4 items are encoded like "idSKU1~nmT-Shirt~pr9.99~qt1" (custom params as k0/v0 pairs).
function decodeGA4Item(str) {
  const out = {};
  const custom = {};
  for (const part of String(str).split('~')) {
    const key = part.slice(0, 2), val = part.slice(2);
    const km = key.match(/^([kv])(\d)$/);
    if (km) { (custom[km[2]] ||= {})[km[1]] = val; continue; }
    out[ITEM_KEYS[key] || key] = val;
  }
  for (const c of Object.values(custom)) if (c.k) out[c.k] = c.v ?? '';
  return out;
}

// gcs = "G1" + ad_storage + analytics_storage (1 granted, 0 denied, - unset)
function decodeGcs(gcs) {
  if (!gcs || !/^G1/.test(gcs)) return null;
  const s = (c) => (c === '1' ? 'granted' : c === '0' ? 'denied' : 'not set');
  return { ad_storage: s(gcs[2]), analytics_storage: s(gcs[3]) };
}
