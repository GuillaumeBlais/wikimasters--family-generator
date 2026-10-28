// WikiMasters – Générateur de familles : outils partagés par content.js et prices.js
(() => {
  if (globalThis.WMFG) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pageFetch = (typeof content !== 'undefined' && content?.fetch) ? content.fetch.bind(content) : fetch;

  // Rythme "humain" : pause variable entre deux requêtes, hésitations occasionnelles,
  // et une vraie pause toutes les 18 à 32 requêtes.
  let count = 0;
  let nextBreak = 18 + Math.floor(Math.random() * 15);
  function humanDelay() {
    count += 1;
    let ms = 900 + Math.random() * 1700;                              // 0,9 – 2,6 s
    if (Math.random() < 0.12) ms += 2000 + Math.random() * 4000;      // hésitation 2 – 6 s
    if (count >= nextBreak) {                                         // pause 8 – 20 s
      ms += 8000 + Math.random() * 12000;
      count = 0;
      nextBreak = 18 + Math.floor(Math.random() * 15);
    }
    return sleep(ms);
  }
  const AVG_DELAY_MS = 2600; // moyenne approximative, pour les estimations de durée

  // ----- Supabase du jeu -----
  const SB_URL = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
  // Clé publique "anon" du site (présente dans toutes ses requêtes, ce n'est pas un secret)
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Session de la page (cookie sb-…-auth-token, éventuellement découpé en .0, .1…).
  // Relue à chaque appel : le site renouvelle le jeton toutes les heures.
  function readSession() {
    const chunks = new Map();
    for (const part of document.cookie.split(';')) {
      const entry = part.trim();
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const m = entry.slice(0, eq).match(/^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/i);
      if (m) chunks.set(m[1] === undefined ? 0 : Number(m[1]), entry.slice(eq + 1));
    }
    if (!chunks.size) return null;
    let raw = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join('');
    try { raw = decodeURIComponent(raw); } catch (_) {}
    try {
      let json = raw;
      if (raw.startsWith('base64-')) {
        const b64 = raw.slice(7).replace(/-/g, '+').replace(/_/g, '/');
        json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      }
      const s = JSON.parse(json);
      const userId = s?.user?.id;
      if (!s?.access_token || !UUID.test(userId || '')) return null;
      return { token: s.access_token, userId, expiresAt: Number(s.expires_at) * 1000 || 0 };
    } catch (_) {
      return null;
    }
  }

  function sbHeaders(session, extra = {}) {
    return { apikey: SB_ANON, authorization: `Bearer ${session.token}`, accept: 'application/json', ...extra };
  }

  // Cache de prix de kzfamily : son préfixe change selon sa version (wm_avg_v3_, wm_avg_v4_…).
  // Le préfixe actif est celui qui contient l'entrée la plus récente (kzfamily y écrit en continu).
  const PRICE_PREFIXES = ['wm_avg_v4_', 'wm_avg_v3_'];
  let activePrefix = null;
  let activePrefixAt = 0;
  function pricePrefix() {
    if (activePrefix && Date.now() - activePrefixAt < 60000) return activePrefix;
    const newest = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) || '';
      const prefix = PRICE_PREFIXES.find((p) => k.startsWith(p));
      if (!prefix) continue;
      let at = 0;
      try { at = JSON.parse(localStorage.getItem(k) || 'null')?.fetchedAt || 0; } catch (_) {}
      if (at > (newest[prefix] || 0)) newest[prefix] = at;
    }
    activePrefix = PRICE_PREFIXES.reduce((best, p) => ((newest[p] || 0) > (newest[best] || 0) ? p : best), PRICE_PREFIXES[0]);
    if (!newest[activePrefix]) activePrefix = PRICE_PREFIXES.find((p) => newest[p] !== undefined) || PRICE_PREFIXES[0];
    activePrefixAt = Date.now();
    return activePrefix;
  }

  // ----- Liste de souhaits : retirer les cartes déjà possédées -----
  async function sbCall(method, path, extra = {}) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const session = readSession();
      if (!session) throw new Error('session introuvable');
      const res = await pageFetch(`${SB_URL}/rest/v1/${path}`, { method, credentials: 'omit', headers: sbHeaders(session, extra) });
      if (res.ok) return res.status === 204 ? [] : res.json().catch(() => []);
      if (res.status === 401) { await sleep(5000); continue; }
      if (res.status === 429 || res.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error('Supabase ne répond pas');
  }
  // cardIds : limiter aux cartes données (ex. cartes d'un paquet) ; sans argument = toute la liste.
  async function pruneWishlist(cardIds = null) {
    const session = readSession();
    if (!session) throw new Error('session introuvable');
    const uid = session.userId;
    const wish = new Set((await sbCall('GET', `wishlist_items?select=card_id&user_id=eq.${uid}&limit=10000`)).map((r) => r.card_id));
    const candidates = [...wish].filter((id) => UUID.test(id) && (!cardIds || cardIds.includes(id)));
    const owned = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const chunk = candidates.slice(i, i + 100);
      const rows = await sbCall('GET', `user_cards?select=card_id&user_id=eq.${uid}&card_id=in.(${chunk.join(',')})&limit=10000`);
      for (const r of rows) if (!owned.includes(r.card_id)) owned.push(r.card_id);
      if (i + 100 < candidates.length) await humanDelay();
    }
    const removed = [];
    for (let i = 0; i < owned.length; i += 100) {
      const chunk = owned.slice(i, i + 100);
      const rows = await sbCall('DELETE', `wishlist_items?user_id=eq.${uid}&card_id=in.(${chunk.join(',')})&select=card_id`, { prefer: 'return=representation' });
      removed.push(...(Array.isArray(rows) ? rows.map((r) => r.card_id) : []));
      if (i + 100 < owned.length) await humanDelay();
    }
    if (removed.length) window.dispatchEvent(new CustomEvent('wmfg-wishlist-changed'));
    return { wishlist: wish.size, owned: owned.length, removed };
  }
  const WP_KEY = 'wmfg_wishprune';
  const wishPruneAuto = () => { try { return JSON.parse(localStorage.getItem(WP_KEY) || '{"enabled":true}').enabled !== false; } catch (_) { return true; } };
  const setWishPruneAuto = (on) => { try { localStorage.setItem(WP_KEY, JSON.stringify({ enabled: Boolean(on) })); } catch (_) {} };

  globalThis.WMFG = { pruneWishlist, wishPruneAuto, setWishPruneAuto, sleep, PRICE_PREFIXES, pricePrefix, pageFetch, humanDelay, AVG_DELAY_MS, SB_URL, SB_ANON, UUID, readSession, sbHeaders };
})();
