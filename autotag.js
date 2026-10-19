// WikiMasters – Générateur de familles : étiquette automatique "à vendre" à l'ouverture des paquets.
// S'appuie sur les événements de kzfamily (wm-average-pack-opened / open-all-packs-progress)
// et sur son cache de prix moyens. Ne touche qu'aux exemplaires qui n'ont encore aucune étiquette.
(() => {
  if (window.__wmfgAutoTagLoaded) return;
  window.__wmfgAutoTagLoaded = true;

  const { sleep, pageFetch, humanDelay, SB_URL, UUID, readSession, sbHeaders } = globalThis.WMFG;
  const SETTINGS_KEY = 'wmfg_autotag';
  const PRICE_PREFIXES = ['wm_avg_v4_', 'wm_avg_v3_'];
  const DEFAULTS = { enabled: true, threshold: 20, tagName: 'à vendre', color: '#22c55e' };
  const PRICE_WAIT_MS = 20000;   // attente des prix chargés par kzfamily avant de les demander nous-mêmes
  const DEBOUNCE_MS = 2500;

  const log = (...a) => console.log('[WM familles] tag auto :', ...a);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

  function settings() {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) }; } catch (_) { return { ...DEFAULTS }; }
  }

  // ---------- Prix ----------
  function cachedEntry(id) {
    let best = null;
    for (const prefix of PRICE_PREFIXES) {
      let e = null;
      try { e = JSON.parse(localStorage.getItem(prefix + id) || 'null'); } catch (_) {}
      if (e && e.ok === true && e.averages && (!best || (e.fetchedAt || 0) > (best.fetchedAt || 0))) best = e;
    }
    return best;
  }

  function priceFor(card) {
    const e = cachedEntry(card.id);
    if (!e) return undefined;                                   // pas encore chargé
    const v = e.averages[card.rarity];
    return v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null; // null = pas de vente
  }

  async function fetchPrice(card) {
    const url = new URL(`/api/marketplace/cards/${encodeURIComponent(card.id)}/sales?scope=summary`, location.origin).href;
    const res = await pageFetch(url, { credentials: 'include', headers: { accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const averages = {};
    for (const [r, v] of Object.entries(json?.summary || {})) {
      if (v?.average !== null && v?.average !== '' && Number.isFinite(Number(v?.average))) averages[r] = Number(v.average);
    }
    let prefix = PRICE_PREFIXES[0];
    for (let i = 0; i < localStorage.length; i += 1) if (localStorage.key(i)?.startsWith('wm_avg_v3_')) { prefix = 'wm_avg_v3_'; break; }
    try {
      localStorage.setItem(prefix + card.id, JSON.stringify({ ok: true, fetchedAt: Date.now(), averages, title: json?.wikipedia_title || null, retryAfterMs: null }));
    } catch (_) {}
    const v = averages[card.rarity];
    return Number.isFinite(v) ? v : null;
  }

  async function resolvePrices(cards) {
    const started = Date.now();
    const prices = new Map();
    while (Date.now() - started < PRICE_WAIT_MS) {
      for (const c of cards) if (!prices.has(c.id) && priceFor(c) !== undefined) prices.set(c.id, priceFor(c));
      if (prices.size === cards.length) return prices;
      await sleep(1500);
    }
    for (const c of cards) {
      if (prices.has(c.id)) continue;
      try { prices.set(c.id, await fetchPrice(c)); } catch (_) { prices.set(c.id, null); }
      await humanDelay();
    }
    return prices;
  }

  // ---------- Supabase ----------
  async function sb(method, path, body, extra = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = readSession();
      if (!session) throw new Error('session introuvable');
      const init = { method, credentials: 'omit', headers: sbHeaders(session, extra) };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.headers['content-profile'] = 'public';
        init.body = JSON.stringify(body);
      }
      const res = await pageFetch(`${SB_URL}/rest/v1/${path}`, init);
      if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
      if (res.status === 409) return { conflict: true };
      if (res.status === 401) { await sleep(5000); continue; }
      if (res.status === 429 || res.status >= 500) { await sleep(20000); continue; }
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    throw new Error('refusé (session expirée ?)');
  }

  async function ensureTag(cfg) {
    const session = readSession();
    const tags = await sb('GET', `tags?select=id,name,color&user_id=eq.${session.userId}`);
    const found = (Array.isArray(tags) ? tags : []).find((t) => norm(t.name) === norm(cfg.tagName));
    if (found) return found;
    const created = await sb('POST', 'tags?select=*', { user_id: session.userId, name: cfg.tagName, color: cfg.color },
      { prefer: 'return=representation', accept: 'application/vnd.pgrst.object+json' });
    const tag = Array.isArray(created) ? created[0] : created;
    if (!tag?.id) throw new Error('étiquette non créée');
    return tag;
  }

  // Exemplaires possédés de ces cartes ; on garde le plus récent par carte (celui qui vient d'être tiré)
  async function newestInstances(cardIds) {
    const session = readSession();
    let rows = [];
    try {
      rows = await sb('GET', `user_cards?select=*&user_id=eq.${session.userId}&card_id=in.(${cardIds.join(',')})&limit=1000`);
    } catch (e) {
      log('table user_cards indisponible', e.message);
      return [];
    }
    const byCard = new Map();
    const stamp = (r) => Date.parse(r.created_at || r.obtained_at || r.acquired_at || r.pulled_at || '') || 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.id || !r?.card_id) continue;
      const prev = byCard.get(r.card_id);
      if (!prev || stamp(r) > stamp(prev)) byCard.set(r.card_id, r);
    }
    return [...byCard.values()].map((r) => ({ userCardId: r.id, cardId: r.card_id }));
  }

  async function taggedInstances(userCardIds) {
    const rows = await sb('GET', `user_card_tags?select=user_card_id,tag_id&user_card_id=in.(${userCardIds.join(',')})&limit=5000`);
    return new Set((Array.isArray(rows) ? rows : []).map((r) => r.user_card_id));
  }

  // ---------- Traitement d'un lot de cartes tirées ----------
  const pending = new Map();      // card.id -> card
  const recentPacks = new Map();  // signature du paquet -> horodatage (même paquet vu par 2 sources)
  let timer = null;
  let running = false;

  function enqueue(cards, source = '?') {
    const cfg = settings();
    if (!cfg.enabled) return;
    const list = cards.filter((c) => c?.id && UUID.test(c.id));
    if (!list.length) return;
    const now = Date.now();
    const sig = list.map((c) => c.id).sort().join(',');
    for (const [k, t] of recentPacks) if (now - t > 60000) recentPacks.delete(k);
    if (recentPacks.has(sig)) return;
    recentPacks.set(sig, now);
    log(`paquet détecté (${source}) : ${list.length} carte(s)`);
    for (const c of list) {
      pending.set(c.id, { id: c.id, title: c.title || c.wikipedia_title || c.id, rarity: c.rarity || null });
    }
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function flush() {
    if (running || !pending.size) return;
    running = true;
    const cards = [...pending.values()];
    pending.clear();
    const cfg = settings();

    try {
      if (!readSession()) throw new Error('session introuvable');
      const prices = await resolvePrices(cards);
      const valuable = cards.filter((c) => (prices.get(c.id) ?? 0) > cfg.threshold);
      log(`${valuable.length}/${cards.length} carte(s) au-dessus de ${cfg.threshold} wb`);
      if (!valuable.length) { toast(`Tag auto : aucune carte au-dessus de ${cfg.threshold} wb (${cards.length} tirée${cards.length > 1 ? 's' : ''}).`, false, 3500); return; }

      const instances = await newestInstances(valuable.map((c) => c.id));
      if (!instances.length) { toast('Tag auto : exemplaires introuvables (voir la console).', true); return; }
      const already = await taggedInstances(instances.map((i) => i.userCardId));
      const targets = instances.filter((i) => !already.has(i.userCardId));
      if (!targets.length) { toast(`Tag auto : ${valuable.length} carte(s) au-dessus de ${cfg.threshold} wb, mais déjà étiquetée(s).`, false, 3500); return; }

      const tag = await ensureTag(cfg);
      const done = [];
      for (const t of targets) {
        try {
          await sb('POST', 'user_card_tags', { user_card_id: t.userCardId, tag_id: tag.id }, { prefer: 'return=minimal' });
          const card = valuable.find((c) => c.id === t.cardId);
          done.push(`${card?.title} (${Math.round(prices.get(t.cardId))} wb)`);
        } catch (e) {
          log('échec sur', t, e.message);
        }
        await humanDelay();
      }
      if (done.length) toast(`🏷 ${done.length} carte${done.length > 1 ? 's' : ''} → « ${tag.name} » : ${done.join(', ')}`);
    } catch (e) {
      log('erreur', e);
      toast(`Tag auto impossible : ${e.message || e}`, true);
    } finally {
      running = false;
      if (pending.size) { clearTimeout(timer); timer = setTimeout(flush, DEBOUNCE_MS); }
    }
  }

  // ---------- Notification ----------
  function toast(text, isError = false, duration = 9000) {
    const box = document.createElement('div');
    const css = {
      position: 'fixed', left: '18px', bottom: '18px', 'z-index': '2147483000', 'max-width': 'min(420px, calc(100vw - 36px))',
      padding: '10px 14px', 'border-radius': '12px', background: isError ? '#3b1d1d' : '#15171a', color: '#eee',
      border: `1px solid ${isError ? '#f87171' : '#22c55e'}`, 'box-shadow': '0 10px 30px rgba(0,0,0,.5)',
      font: '600 12.5px/1.45 system-ui, sans-serif', cursor: 'pointer',
    };
    Object.entries(css).forEach(([k, v]) => box.style.setProperty(k, v, 'important'));
    box.textContent = text;
    box.addEventListener('click', () => box.remove());
    (document.body || document.documentElement).append(box);
    setTimeout(() => box.remove(), duration);
  }

  // ---------- Écoute des ouvertures (événements émis par kzfamily) ----------
  // 1) Interception directe de l'ouverture d'un paquet par le site (Firefox : exportFunction)
  function onPackText(text) {
    try {
      const json = JSON.parse(text);
      const cards = (Array.isArray(json?.cards) ? json.cards : []).map((c) => ({ id: c?.id, title: c?.wikipedia_title, rarity: c?.rarity }));
      if (cards.length) enqueue(cards, 'site');
    } catch (_) {}
  }

  function hookFetch() {
    const pw = window.wrappedJSObject;
    if (!pw || typeof exportFunction !== 'function' || typeof pw.fetch !== 'function') return false;
    const orig = pw.fetch;
    const isPackUrl = (input) => {
      let url = '';
      try { url = typeof input === 'string' ? input : String(input?.url || input || ''); } catch (_) {}
      return /\/api\/packs\/open(?:[?#]|$)/.test(url);
    };
    const hooked = function (input, init) {
      const promise = orig.call(pw, input, init);
      try {
        if (isPackUrl(input)) {
          promise.then(exportFunction((res) => {
            try { res.clone().text().then(exportFunction((t) => onPackText(String(t)), pw)); } catch (_) {}
          }, pw));
        }
      } catch (_) {}
      return promise;
    };
    pw.fetch = exportFunction(hooked, pw);
    return true;
  }

  // 2) Événements de kzfamily (utile pour son ouverture automatique en lot)
  const detailOf = (event) => {
    let d = null;
    try { d = event.detail; } catch (_) {}
    if (d == null) { try { d = event.wrappedJSObject?.detail; } catch (_) {} }
    try { return JSON.parse(JSON.stringify(d ?? null)); } catch (_) { return null; }
  };
  let batchSeen = false;
  window.addEventListener('wm-average-pack-opened', (event) => {
    const d = detailOf(event);
    if (Array.isArray(d?.cards)) enqueue(d.cards, 'kzfamily');
  });
  window.addEventListener('wm-average-open-all-packs-progress', (event) => {
    const d = detailOf(event);
    if (Array.isArray(d?.cards) && d.cards.length) { batchSeen = true; enqueue(d.cards, 'kzfamily lot'); }
  });
  window.addEventListener('wm-average-open-all-packs-result', (event) => {
    const d = detailOf(event);
    if (!batchSeen && Array.isArray(d?.cards) && d.cards.length) enqueue(d.cards, 'kzfamily fin de lot');
    batchSeen = false;
  });

  let hooked = false;
  try { hooked = hookFetch(); } catch (e) { console.warn('[WM familles] tag auto : interception impossible', e); }
  log(`prêt (${settings().enabled ? `activé, seuil ${settings().threshold} wb, « ${settings().tagName} »` : 'désactivé'}) • interception du site : ${hooked ? 'oui' : 'non'}`);

  window.__wmfgAutoTag = { enqueue, flush, settings, onPackText, SETTINGS_KEY, DEFAULTS };
})();
