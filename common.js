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

  globalThis.WMFG = { sleep, pageFetch, humanDelay, AVG_DELAY_MS, SB_URL, SB_ANON, UUID, readSession, sbHeaders };
})();
