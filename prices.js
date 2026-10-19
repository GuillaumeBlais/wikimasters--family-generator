// WikiMasters – Générateur de familles : tuile de prix sur la page "Familles" de WikiMastersTools-kzfamily.
// Lit les familles (localStorage wm_families_v1) et le cache de prix moyens de kzfamily (wm_avg_v3_/v4_<id>).
// Le bouton "Charger les prix manquants" remplit ce même cache via /api/marketplace/cards/<id>/sales.
(() => {
  if (window.__wmfgPricesLoaded) return;
  window.__wmfgPricesLoaded = true;

  const FAMILIES_KEY = 'wm_families_v1';
  // Le préfixe du cache de prix dépend de la version de kzfamily installée (v3, v4…)
  const PRICE_PREFIXES = ['wm_avg_v4_', 'wm_avg_v3_'];
  function writePrefix() {
    for (const prefix of PRICE_PREFIXES) {
      for (let i = 0; i < localStorage.length; i += 1) {
        if (localStorage.key(i)?.startsWith(prefix)) return prefix;
      }
    }
    return PRICE_PREFIXES[0];
  }
  const { humanDelay, SB_URL, UUID, readSession, sbHeaders } = globalThis.WMFG;
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
  const { pageFetch, sleep } = globalThis.WMFG;
  const wb = (n) => `${Math.round(n).toLocaleString('fr-FR')} wb`;

  const onFamiliesPage = () => new URLSearchParams(location.search).get('wm') === 'themes';

  function readFamilies() {
    try {
      const v = JSON.parse(localStorage.getItem(FAMILIES_KEY) || '[]');
      return Array.isArray(v) ? v.filter((f) => f?.id && f?.name && Array.isArray(f.cards)) : [];
    } catch (_) {
      return [];
    }
  }

  function renameFamily(familyId, name) {
    try {
      const fams = JSON.parse(localStorage.getItem(FAMILIES_KEY) || '[]');
      const fam = Array.isArray(fams) ? fams.find((f) => f?.id === familyId) : null;
      if (!fam) return false;
      fam.name = String(name).trim().slice(0, 120);
      fam.updatedAt = Date.now();
      localStorage.setItem(FAMILIES_KEY, JSON.stringify(fams));
      return true;
    } catch (e) {
      console.warn('[WM familles] renommage impossible', e);
      return false;
    }
  }

  function priceOf(card) {
    let entry = null;
    for (const prefix of PRICE_PREFIXES) {
      let e = null;
      try { e = JSON.parse(localStorage.getItem(prefix + card.id) || 'null'); } catch (_) {}
      if (e && e.ok === true && (!entry || (e.fetchedAt || 0) > (entry.fetchedAt || 0))) entry = e;
    }
    if (!entry || entry.ok !== true || !entry.averages || typeof entry.averages !== 'object') return { state: 'unknown' };
    const v = entry.averages[card.rarity];
    if (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0) {
      return { state: 'ok', value: Number(v) };
    }
    return { state: 'nosale' };
  }

  function familyPriceStats(family) {
    const ownershipKnown = Boolean(family.ownershipUpdatedAt);
    const s = {
      total: family.cards.length, priced: 0, noSale: 0, unknown: 0, sum: 0,
      ownershipKnown, missing: 0, missingPriced: 0, missingSum: 0, unknownIds: [],
    };
    for (const card of family.cards) {
      const p = priceOf(card);
      const isMissing = ownershipKnown && card.owned !== true;
      if (isMissing) s.missing += 1;
      if (p.state === 'ok') {
        s.priced += 1;
        s.sum += p.value;
        if (isMissing) { s.missingPriced += 1; s.missingSum += p.value; }
      } else if (p.state === 'nosale') {
        s.noSale += 1;
      } else {
        s.unknown += 1;
        s.unknownIds.push(card.id);
      }
    }
    s.avg = s.priced ? s.sum / s.priced : null;
    return s;
  }

  // ---------- Chargement des prix manquants ----------
  let loading = null; // { familyId, done, total, cancelled }

  async function fetchSummary(id) {
    const url = new URL(`/api/marketplace/cards/${encodeURIComponent(id)}/sales?scope=summary`, location.origin).href;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await pageFetch(url, { credentials: 'include', headers: { accept: '*/*' } });
      if (res.status === 429 || res.status >= 500) { await sleep(60000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
    throw new Error('serveur indisponible');
  }

  async function loadMissingPrices(family) {
    const ids = familyPriceStats(family).unknownIds;
    loading = { familyId: family.id, done: 0, total: ids.length, cancelled: false };
    render();
    for (const id of ids) {
      if (loading.cancelled) break;
      try {
        const json = await fetchSummary(id);
        const averages = {};
        for (const [rarity, value] of Object.entries(json?.summary || {})) {
          const avg = value?.average;
          if (RARITIES.includes(rarity) && avg !== null && avg !== '' && Number.isFinite(Number(avg)) && Number(avg) >= 0) {
            averages[rarity] = Number(avg);
          }
        }
        // Même format que le cache de kzfamily, qui en profitera aussi
        localStorage.setItem(writePrefix() + id, JSON.stringify({
          ok: true, fetchedAt: Date.now(), averages, title: json?.wikipedia_title || null, retryAfterMs: null,
        }));
      } catch (e) {
        console.warn('[WM familles] prix indisponible pour', id, e);
      }
      loading.done += 1;
      render();
      await humanDelay();
    }
    loading = null;
    render();
  }

  // ---------- Liste de souhaits du jeu (Supabase wishlist_items) ----------
  async function currentWishlist(session) {
    const url = `${SB_URL}/rest/v1/wishlist_items?select=card_id&user_id=eq.${session.userId}&limit=10000`;
    const res = await pageFetch(url, { method: 'GET', credentials: 'omit', headers: sbHeaders(session) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return new Set((Array.isArray(rows) ? rows : []).map((r) => r.card_id));
  }

  async function postWish(cardId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = readSession();
      if (!session) throw new Error('session introuvable');
      const res = await pageFetch(`${SB_URL}/rest/v1/wishlist_items`, {
        method: 'POST',
        credentials: 'omit',
        headers: sbHeaders(session, {
          'content-type': 'application/json',
          'content-profile': 'public',
          prefer: 'return=minimal',
        }),
        body: JSON.stringify({ user_id: session.userId, card_id: cardId }),
      });
      if (res.ok) return 'added';
      if (res.status === 409) return 'already';           // déjà dans la liste
      if (res.status === 401) { await sleep(5000); continue; } // jeton en cours de renouvellement
      if (res.status === 429 || res.status >= 500) { await sleep(30000); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error('refusé (session expirée ? recharge la page)');
  }

  let wishing = null; // { familyId, done, total, added, already, failed, cancelled, message }

  // Liste de souhaits en mémoire : sert au décompte "à ajouter" (rechargée toutes les 5 min ou sur ↻)
  let wishSet = null;        // Set(card_id) | null = pas encore chargé | false = illisible
  let wishLoadedAt = 0;
  let wishLoading = false;
  const WISH_TTL = 5 * 60 * 1000;

  async function loadWishlist(force = false) {
    if (wishLoading) return;
    if (!force && wishSet !== null && Date.now() - wishLoadedAt < WISH_TTL) return;
    const session = readSession();
    if (!session) return;
    wishLoading = true;
    try {
      wishSet = await currentWishlist(session);
    } catch (e) {
      console.warn('[WM familles] lecture liste de souhaits impossible', e);
      if (wishSet === null) wishSet = false;
    }
    wishLoadedAt = Date.now();
    wishLoading = false;
    render();
  }

  async function addFamilyToWishlist(family, onlyMissing) {
    const session = readSession();
    if (!session) {
      wishing = { familyId: family.id, message: 'Session introuvable : reconnecte-toi puis recharge la page.' };
      render();
      return;
    }
    const cards = family.cards.filter((c) => UUID.test(c.id) && (!onlyMissing || c.owned !== true));
    wishing = { familyId: family.id, done: 0, total: cards.length, added: 0, already: 0, failed: 0, cancelled: false, running: true };
    render();

    let existing = new Set();
    try {
      existing = await currentWishlist(session);
      wishSet = new Set(existing);
      wishLoadedAt = Date.now();
    } catch (e) { console.warn('[WM familles] lecture liste de souhaits impossible', e); }
    if (!(wishSet instanceof Set)) wishSet = new Set(existing);

    for (const card of cards) {
      if (wishing.cancelled) break;
      if (existing.has(card.id)) {
        wishing.already += 1;
      } else {
        try {
          const r = await postWish(card.id);
          wishing[r] += 1;
          wishSet.add(card.id);
          await humanDelay();
        } catch (e) {
          wishing.failed += 1;
          console.warn('[WM familles] souhait refusé pour', card.title, e);
          if (/session/.test(String(e.message))) { wishing.message = String(e.message); break; }
        }
      }
      wishing.done += 1;
      render();
    }
    wishing.running = false;
    wishing.message = wishing.message || `${wishing.added} ajoutée${wishing.added > 1 ? 's' : ''}, ${wishing.already} déjà dans ta liste${wishing.failed ? `, ${wishing.failed} échec${wishing.failed > 1 ? 's' : ''}` : ''}${wishing.cancelled ? ' (arrêté)' : ''}.`;
    render();
  }

  // ---------- Étiquettes du jeu (Supabase tags / user_card_tags) ----------
  let tagCache = null;      // [{ id, name, color }] ou null tant que non chargé
  let tagLoading = false;
  let tagging = null;       // { familyId, done, total, added, already, notOwned, failed, cancelled, running, message }

  async function sbGet(path) {
    const session = readSession();
    if (!session) throw new Error('session introuvable');
    const res = await pageFetch(`${SB_URL}/rest/v1/${path}`, { method: 'GET', credentials: 'omit', headers: sbHeaders(session) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function sbPost(path, body, extraHeaders = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = readSession();
      if (!session) throw new Error('session introuvable');
      const res = await pageFetch(`${SB_URL}/rest/v1/${path}`, {
        method: 'POST',
        credentials: 'omit',
        headers: sbHeaders(session, { 'content-type': 'application/json', 'content-profile': 'public', ...extraHeaders }),
        body: JSON.stringify(body),
      });
      if (res.ok) return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) };
      if (res.status === 409) return { status: 409, json: null };
      if (res.status === 401) { await sleep(5000); continue; }
      if (res.status === 429 || res.status >= 500) { await sleep(30000); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error('refusé (session expirée ? recharge la page)');
  }

  async function loadTags() {
    if (tagLoading) return;
    tagLoading = true;
    try {
      const session = readSession();
      const rows = await sbGet(`tags?select=id,name,color&user_id=eq.${session?.userId}&order=name.asc`);
      tagCache = Array.isArray(rows) ? rows.filter((t) => t?.id && t?.name) : [];
    } catch (e) {
      console.warn('[WM familles] lecture des étiquettes impossible', e);
      tagCache = [];
    }
    tagLoading = false;
    render();
  }

  async function createTag(name, color) {
    const session = readSession();
    if (!session) throw new Error('session introuvable');
    const r = await sbPost('tags?select=*', { user_id: session.userId, name, color }, {
      prefer: 'return=representation', accept: 'application/vnd.pgrst.object+json',
    });
    const tag = Array.isArray(r.json) ? r.json[0] : r.json;
    if (!tag?.id) throw new Error('étiquette non créée');
    tagCache = [...(tagCache || []), tag].sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
    return tag;
  }

  // Exemplaires possédés (user_cards) des cartes de la famille : catalogue direct, sinon page "Ma collection"
  async function ownedInstances(family) {
    const session = readSession();
    const ids = family.cards.map((c) => c.id).filter((id) => UUID.test(id));
    const out = [];
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const part = ids.slice(i, i + 40);
        const rows = await sbGet(`user_cards?select=id,card_id&user_id=eq.${session?.userId}&card_id=in.(${part.join(',')})&limit=1000`);
        for (const r of Array.isArray(rows) ? rows : []) if (r?.id && r?.card_id) out.push({ userCardId: r.id, cardId: r.card_id });
        if (i + 40 < ids.length) await humanDelay();
      }
      return out;
    } catch (e) {
      console.warn('[WM familles] table user_cards indisponible, passage par Ma collection', e);
    }
    // Secours : recherche dans "Ma collection", titre par titre
    const wanted = new Set(ids);
    for (const card of family.cards) {
      if (tagging?.cancelled) break;
      if (!wanted.has(card.id) || card.owned === false) continue;
      try {
        const url = new URL(`/api/my-collection?sort=rarity&q=${encodeURIComponent(card.title)}&page=0&stats=0`, location.origin).href;
        const res = await pageFetch(url, { credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const list = Array.isArray(json?.collection) ? json.collection : Array.isArray(json?.cards) ? json.cards : [];
          for (const entry of list) {
            const cardId = entry?.card_id || entry?.card?.id;
            if (cardId === card.id && entry?.id) out.push({ userCardId: entry.id, cardId });
          }
        }
      } catch (_) {}
      await humanDelay();
    }
    return out;
  }

  async function tagFamily(family, tagChoice) {
    tagging = { familyId: family.id, done: 0, total: 0, added: 0, already: 0, notOwned: 0, failed: 0, cancelled: false, running: true, message: 'Préparation…' };
    render();
    try {
      if (!readSession()) throw new Error('session introuvable : reconnecte-toi puis recharge la page');
      const tag = tagChoice.id ? tagChoice : await createTag(tagChoice.name, tagChoice.color);

      tagging.message = 'Recherche de tes exemplaires…';
      render();
      const instances = await ownedInstances(family);
      const ownedCards = new Set(instances.map((x) => x.cardId));
      tagging.notOwned = family.cards.filter((c) => !ownedCards.has(c.id)).length;

      let existing = new Set();
      try {
        const rows = await sbGet(`user_card_tags?select=user_card_id&tag_id=eq.${tag.id}&limit=10000`);
        existing = new Set((Array.isArray(rows) ? rows : []).map((r) => r.user_card_id));
      } catch (e) { console.warn('[WM familles] lecture des étiquettes posées impossible', e); }

      tagging.total = instances.length;
      tagging.message = null;
      render();
      for (const inst of instances) {
        if (tagging.cancelled) break;
        if (existing.has(inst.userCardId)) {
          tagging.already += 1;
        } else {
          try {
            const r = await sbPost('user_card_tags', { user_card_id: inst.userCardId, tag_id: tag.id }, { prefer: 'return=minimal' });
            if (r.status === 409) tagging.already += 1; else tagging.added += 1;
          } catch (e) {
            tagging.failed += 1;
            console.warn('[WM familles] étiquette refusée', inst, e);
            if (/session/.test(String(e.message))) { tagging.message = String(e.message); break; }
          }
          await humanDelay();
        }
        tagging.done += 1;
        render();
      }
      tagging.message = tagging.message || `« ${tag.name} » : ${tagging.added} exemplaire${tagging.added > 1 ? 's' : ''} étiqueté${tagging.added > 1 ? 's' : ''}, ${tagging.already} déjà, ${tagging.notOwned} carte${tagging.notOwned > 1 ? 's' : ''} non possédée${tagging.notOwned > 1 ? 's' : ''}${tagging.failed ? `, ${tagging.failed} échec(s)` : ''}${tagging.cancelled ? ' (arrêté)' : ''}.`;
    } catch (e) {
      tagging.message = `Erreur : ${e.message || e}`;
    }
    tagging.running = false;
    render();
  }

  // ---------- Rendu ----------
  const css = (node, props) => { Object.entries(props).forEach(([k, v]) => node.style.setProperty(k, v)); return node; };
  const make = (tag, props = {}, text) => { const n = css(document.createElement(tag), props); if (text != null) n.textContent = text; return n; };

  function tileLine(stats) {
    if (!stats.priced) return stats.unknown ? 'Prix non chargés' : 'Aucune vente connue';
    const parts = [`Moy. ${wb(stats.avg)}`, `Total ${wb(stats.sum)}`];
    if (stats.ownershipKnown) parts.push(`Manquantes ${wb(stats.missingSum)}`);
    return parts.join(' · ');
  }

  // Associe chaque tuile/titre affiché à une famille (par nom, dans l'ordre)
  function matcher(families) {
    const used = new Set();
    return (name) => {
      const f = families.find((x) => x.name === name && !used.has(x.id));
      if (f) used.add(f.id);
      return f || null;
    };
  }

  const SORT_KEY = 'wmfg_family_sort';
  const SORTS = [
    ['none', 'Ordre d\'origine'],
    ['name-asc', 'Nom A → Z', (x) => x.f.name.toLocaleLowerCase('fr'), 1],
    ['name-desc', 'Nom Z → A', (x) => x.f.name.toLocaleLowerCase('fr'), -1],
    ['size-desc', 'Taille ↓', (x) => x.s.total, -1],
    ['size-asc', 'Taille ↑', (x) => x.s.total, 1],
    ['value-desc', 'Valeur totale ↓', (x) => (x.s.priced ? x.s.sum : null), -1],
    ['missingvalue-desc', 'Valeur restante ↓', (x) => (x.s.ownershipKnown ? x.s.missingSum : null), -1],
    ['missingvalue-asc', 'Valeur restante ↑', (x) => (x.s.ownershipKnown ? x.s.missingSum : null), 1],
    ['owned-desc', 'Cartes possédées ↓', (x) => (x.s.ownershipKnown ? x.s.total - x.s.missing : null), -1],
    ['missing-asc', 'Cartes restantes ↑', (x) => (x.s.ownershipKnown ? x.s.missing : null), 1],
    ['missing-desc', 'Cartes restantes ↓', (x) => (x.s.ownershipKnown ? x.s.missing : null), -1],
    ['completion-desc', 'Complétude ↓', (x) => (x.s.ownershipKnown && x.s.total ? (x.s.total - x.s.missing) / x.s.total : null), -1],
    ['completion-asc', 'Complétude ↑', (x) => (x.s.ownershipKnown && x.s.total ? (x.s.total - x.s.missing) / x.s.total : null), 1],
  ];
  const currentSort = () => { try { return localStorage.getItem(SORT_KEY) || 'none'; } catch (_) { return 'none'; } };

  function renderSortBar(grid) {
    let bar = document.querySelector('.wmfg-sort-bar');
    if (bar && bar.nextElementSibling === grid) {
      const sel = bar.querySelector('select');
      if (sel.value !== currentSort()) sel.value = currentSort();
      return;
    }
    bar?.remove();
    bar = make('div', { display: 'flex', gap: '8px', 'align-items': 'center', margin: '0 0 10px', 'font-size': '12px', color: '#9aa0a8' });
    bar.className = 'wmfg-sort-bar';
    const sel = make('select', {
      padding: '6px 9px', 'border-radius': '8px', border: '1px solid #3a3f46', background: '#0d0e10', color: '#eee', 'font-size': '12px',
    });
    for (const [key, label] of SORTS) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = label;
      sel.append(o);
    }
    sel.value = currentSort();
    sel.addEventListener('change', () => {
      try { localStorage.setItem(SORT_KEY, sel.value); } catch (_) {}
      render();
    });
    bar.append(make('span', {}, 'Trier les familles :'), sel);
    grid.insertAdjacentElement('beforebegin', bar);
  }

  function applySort(items) {
    const def = SORTS.find(([key]) => key === currentSort()) || SORTS[0];
    const [, , valueOf, dir] = def;
    const ranked = items.map((x, i) => ({ ...x, i, v: valueOf ? valueOf(x) : null }));
    if (valueOf) {
      ranked.sort((a, b) => {
        // Valeurs inconnues (prix ou collection non chargés) toujours en fin de liste
        if (a.v == null && b.v == null) return a.i - b.i;
        if (a.v == null) return 1;
        if (b.v == null) return -1;
        const cmp = typeof a.v === 'string' ? a.v.localeCompare(b.v, 'fr') : a.v - b.v;
        return cmp * dir || a.i - b.i;
      });
    }
    ranked.forEach((x, rank) => {
      const order = valueOf ? String(rank) : '';
      if (x.tile.style.order !== order) x.tile.style.order = order;
    });
  }

  function renderHomeTiles(families) {
    const pick = matcher(families);
    const items = [];
    for (const tile of document.querySelectorAll('.wm-family-card')) {
      const name = tile.querySelector('strong')?.textContent?.trim();
      const family = name ? pick(name) : null;
      if (!family) continue;
      const st = familyPriceStats(family);
      items.push({ tile, f: family, s: st });
      const text = tileLine(st);
      let line = tile.querySelector('.wmfg-price-line');
      if (!line) {
        line = make('span', {
          display: 'block', 'margin-top': '4px', 'font-size': '11.5px', 'font-weight': '600',
          color: '#f5b544', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis',
        });
        line.className = 'wmfg-price-line';
        (tile.querySelector('.wm-family-card-body') || tile).append(line);
      }
      if (line.textContent !== text) line.textContent = text;
    }
    const grid = document.querySelector('.wm-family-grid');
    if (grid && items.length) {
      renderSortBar(grid);
      applySort(items);
    }
  }

  function stat(label, value, sub) {
    const box = make('div', {
      flex: '1 1 0', 'min-width': '120px', padding: '10px 12px', 'border-radius': '10px',
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
    });
    box.append(
      make('div', { 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '.04em', color: '#9aa0a8' }, label),
      make('div', { 'font-size': '18px', 'font-weight': '700', color: '#f5b544', 'margin-top': '2px' }, value),
    );
    if (sub) box.append(make('div', { 'font-size': '11px', color: '#9aa0a8', 'margin-top': '2px' }, sub));
    return box;
  }

  function renderDetailTile(families) {
    const head = document.querySelector('.wm-family-detail-head');
    const old = document.querySelector('.wmfg-price-tile');
    if (!head) { old?.remove(); return; }
    const name = head.querySelector('h1')?.textContent?.trim();
    const family = families.find((f) => f.name === name);
    if (!family) { old?.remove(); return; }

    const s = familyPriceStats(family);
    const busy = loading && loading.familyId === family.id;
    const wish = wishing && wishing.familyId === family.id ? wishing : null;
    const tagJob = tagging && tagging.familyId === family.id ? tagging : null;
    if (tagCache === null && !tagLoading) loadTags();
    loadWishlist();
    const signature = JSON.stringify([family.id, family.name, s.priced, s.noSale, s.unknown, Math.round(s.sum), Math.round(s.missingSum), s.missing, busy ? loading.done : -1,
      wish ? [wish.done, wish.running, wish.message] : null,
      tagJob ? [tagJob.done, tagJob.total, tagJob.running, tagJob.message] : null,
      tagCache ? tagCache.map((t) => t.id).join(',') : 'loading',
      wishSet instanceof Set ? family.cards.filter((c) => wishSet.has(c.id)).length : String(wishSet), wishLoadedAt]);
    if (old && old.dataset.sig === signature && old.previousElementSibling === head) return;

    const tile = make('div', {
      margin: '14px 0', padding: '12px', 'border-radius': '14px',
      background: 'rgba(245,181,68,0.06)', border: '1px solid rgba(245,181,68,0.25)',
    });
    tile.className = 'wmfg-price-tile';
    tile.dataset.sig = signature;

    const row = make('div', { display: 'flex', gap: '10px', 'flex-wrap': 'wrap' });
    row.append(
      stat('Prix moyen', s.avg == null ? '—' : wb(s.avg), `${s.priced} carte${s.priced > 1 ? 's' : ''} avec prix`),
      stat('Valeur totale', s.priced ? wb(s.sum) : '—', `${s.total} carte${s.total > 1 ? 's' : ''} dans la famille`),
      stat('Cartes manquantes', s.ownershipKnown ? wb(s.missingSum) : '—',
        s.ownershipKnown ? `${s.missing} manquante${s.missing > 1 ? 's' : ''}, ${s.missingPriced} avec prix` : 'charge ta collection d\'abord'),
    );
    tile.append(row);

    const foot = make('div', { display: 'flex', gap: '10px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-top': '10px', 'font-size': '12px', color: '#9aa0a8' });
    const info = [];
    if (s.noSale) info.push(`${s.noSale} sans vente connue`);
    if (s.unknown) info.push(`${s.unknown} prix non chargé${s.unknown > 1 ? 's' : ''}`);
    foot.append(make('span', {}, info.join(' · ') || 'Tous les prix sont chargés.'));

    if (s.unknown || busy) {
      const btn = make('button', {
        'margin-left': 'auto', padding: '7px 12px', 'border-radius': '8px', border: '0', cursor: 'pointer',
        background: busy ? '#3a3f46' : '#f5b544', color: busy ? '#eee' : '#111', 'font-weight': '700', 'font-size': '12px',
      }, busy ? `Arrêter (${loading.done}/${loading.total})` : `Charger les prix manquants (${s.unknown})`);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (busy) { loading.cancelled = true; return; }
        if (!loading) loadMissingPrices(family);
      });
      foot.append(btn);
    }
    tile.append(foot);

    // Liste de souhaits du jeu
    const wishRow = make('div', {
      display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-top': '10px',
      'padding-top': '10px', 'border-top': '1px solid rgba(255,255,255,0.08)', 'font-size': '12px', color: '#9aa0a8',
    });
    wishRow.append(make('span', { 'margin-right': 'auto' }, 'Liste de souhaits du jeu'));
    const wishBtn = (label, onClick, primary = false) => {
      const b = make('button', {
        padding: '7px 12px', 'border-radius': '8px', border: '0', cursor: 'pointer', 'font-weight': '700', 'font-size': '12px',
        background: primary ? '#f5b544' : '#2b3036', color: primary ? '#111' : '#eee',
      }, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };
    if (wish?.running) {
      wishRow.append(make('span', {}, `${wish.done}/${wish.total} • ${wish.added} ajoutée(s)`),
        wishBtn('Arrêter', () => { wishing.cancelled = true; }));
    } else {
      const free = !wishing?.running && !loading;
      const known = wishSet instanceof Set;
      const inList = (c) => known && wishSet.has(c.id);
      const missingCards = s.ownershipKnown ? family.cards.filter((c) => c.owned !== true) : [];
      const toAddMissing = missingCards.filter((c) => !inList(c)).length;
      const toAddAll = family.cards.filter((c) => !inList(c)).length;
      const already = family.cards.filter(inList).length;

      if (known) {
        wishRow.append(make('span', { color: '#c9ccd2' },
          `${already}/${family.cards.length} dans ta liste${s.ownershipKnown ? ` • ${toAddMissing} manquante${toAddMissing > 1 ? 's' : ''} à ajouter` : ''}`));
      } else if (wishSet === null) {
        wishRow.append(make('span', {}, 'Lecture de ta liste…'));
      }
      const refresh = wishBtn('↻', () => loadWishlist(true));
      refresh.title = 'Relire ta liste de souhaits';

      if (s.ownershipKnown && s.missing) {
        if (known && toAddMissing === 0) {
          wishRow.append(make('span', { color: '#4ade80', 'font-weight': '700' }, '✓ Toutes les manquantes sont dans ta liste'));
        } else {
          wishRow.append(wishBtn(`Ajouter les manquantes (${known ? toAddMissing : s.missing})`, () => free && addFamilyToWishlist(family, true), true));
        }
      }
      if (known && toAddAll === 0) {
        wishRow.append(make('span', { color: '#4ade80', 'font-weight': '700' }, '✓ Toute la famille est dans ta liste'));
      } else {
        wishRow.append(wishBtn(`Ajouter toute la famille (${known ? toAddAll : s.total})`, () => free && addFamilyToWishlist(family, false), !(s.ownershipKnown && s.missing)));
      }
      wishRow.append(refresh);
    }
    tile.append(wishRow);

    // Étiquettes du jeu
    const tagRow = make('div', {
      display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-top': '10px',
      'padding-top': '10px', 'border-top': '1px solid rgba(255,255,255,0.08)', 'font-size': '12px', color: '#9aa0a8',
    });
    tagRow.append(make('span', {}, 'Étiquette'));
    const fieldCss = { padding: '7px 9px', 'border-radius': '8px', border: '1px solid #3a3f46', background: '#0d0e10', color: '#eee', 'font-size': '12px' };
    if (tagJob?.running) {
      tagRow.append(make('span', { 'margin-right': 'auto' }, tagJob.message || `${tagJob.done}/${tagJob.total} exemplaires • ${tagJob.added} étiqueté(s)`),
        wishBtn('Arrêter', () => { tagging.cancelled = true; }));
    } else {
      const sel = make('select', { ...fieldCss, flex: '1 1 160px' });
      const NEW = '__new__';
      for (const t of tagCache || []) {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = t.name;
        sel.append(o);
      }
      const oNew = document.createElement('option');
      oNew.value = NEW;
      oNew.textContent = tagCache === null ? 'Chargement…' : '+ Nouvelle étiquette…';
      sel.append(oNew);
      if (!tagCache?.length) sel.value = NEW;

      const nameIn = make('input', { ...fieldCss, flex: '1 1 140px' });
      nameIn.placeholder = 'Nom de l\'étiquette';
      nameIn.maxLength = 40;
      nameIn.value = family.name.slice(0, 40);
      const colorIn = make('input', { width: '36px', height: '30px', padding: '0', border: '0', background: 'transparent', cursor: 'pointer' });
      colorIn.type = 'color';
      colorIn.value = '#f472b6';
      const toggleNew = () => { const isNew = sel.value === NEW; nameIn.style.display = isNew ? '' : 'none'; colorIn.style.display = isNew ? '' : 'none'; };
      sel.addEventListener('change', toggleNew);
      toggleNew();

      const go = wishBtn('Étiqueter mes cartes de la famille', () => {
        if (tagging?.running || wishing?.running || loading) return;
        if (sel.value === NEW) {
          const name = nameIn.value.trim();
          if (!name) { nameIn.focus(); return; }
          tagFamily(family, { name, color: colorIn.value });
        } else {
          const t = (tagCache || []).find((x) => x.id === sel.value);
          if (t) tagFamily(family, t);
        }
      }, true);
      tagRow.append(sel, nameIn, colorIn, go);
    }
    tile.append(tagRow);
    if (tagJob?.message && !tagJob.running) tile.append(make('div', { 'margin-top': '6px', 'font-size': '12px', color: '#c9ccd2' }, tagJob.message));

    // Renommer la famille
    const renameRow = make('div', {
      display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-top': '10px',
      'padding-top': '10px', 'border-top': '1px solid rgba(255,255,255,0.08)', 'font-size': '12px', color: '#9aa0a8',
    });
    const input = make('input', {
      flex: '1 1 200px', padding: '7px 9px', 'border-radius': '8px', border: '1px solid #3a3f46',
      background: '#0d0e10', color: '#eee', 'font-size': '12px',
    });
    input.value = family.name;
    input.maxLength = 120;
    const save = wishBtn('Renommer', () => {
      const next = input.value.trim();
      if (!next || next === family.name) return;
      if (renameFamily(family.id, next)) {
        const h1 = head.querySelector('h1');
        if (h1) h1.textContent = next; // affichage immédiat ; kzfamily le reprendra au prochain rechargement
        tile.dataset.sig = '';
        render();
      }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    renameRow.append(make('span', {}, 'Nom'), input, save);
    tile.append(renameRow);
    if (wish?.message) tile.append(make('div', { 'margin-top': '6px', 'font-size': '12px', color: '#c9ccd2' }, wish.message));

    old?.remove();
    head.insertAdjacentElement('afterend', tile);
  }

  function render() {
    if (!onFamiliesPage()) return;
    const families = readFamilies();
    if (!families.length) return;
    renderHomeTiles(families);
    renderDetailTile(families);
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(render, 3000); // prix/collection mis à jour par kzfamily sans changement de DOM
  render();

  window.__wmfgPrices = { familyPriceStats, render };
})();
