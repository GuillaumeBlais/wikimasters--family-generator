// WikiMasters – Générateur de familles (content script)
// Thème -> articles Wikipédia FR -> cartes du jeu (/api/cards) -> code F1.… pour WikiMastersTools-kzfamily
(() => {
  if (window.__wmfgLoaded) return;
  window.__wmfgLoaded = true;

  const ext = globalThis.browser || globalThis.chrome;
  const { humanDelay, AVG_DELAY_MS, SB_URL, readSession, sbHeaders } = globalThis.WMFG;
  const MAX_PAGES = 5;            // pages de résultats examinées par titre (recherche de secours)
  const BATCH = 40;               // titres par requête au catalogue
  const FAMILIES_KEY = 'wm_families_v1';
  const LAST_KEY = 'wmfg_last_theme';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').normalize('NFC').replace(/_/g, ' ').trim().toLowerCase();
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const { pageFetch } = globalThis.WMFG;

  // ===================== Wikipédia =====================
  async function wiki(lang, params) {
    const res = await ext.runtime.sendMessage({ type: 'wmfg-wiki', lang, params });
    if (!res) throw new Error('Extension : pas de réponse du script de fond');
    if (res.error) throw new Error(res.error);
    return res.json;
  }

  async function searchListPages(lang, theme) {
    const prefix = lang === 'fr' ? 'Liste' : 'List';
    const json = await wiki(lang, {
      action: 'query', list: 'search', srnamespace: '0', srlimit: '6',
      srsearch: `intitle:${prefix} ${theme}`,
    });
    const words = norm(theme).split(/\s+/).filter((w) => w.length > 1);
    return (json?.query?.search || [])
      .map((r) => r.title)
      .filter((t) => words.every((w) => norm(t).includes(w)))
      .slice(0, 3);
  }

  // Découpe une page en "blocs" exploitables : chaque tableau wikitable, puis les listes à puces.
  // Ordre du document conservé (le 1er tableau est en général la liste principale).
  function extractGroups(html, column) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Titre d'article visé par un lien. Accepte les deux formats HTML de Wikipédia :
    // classique (/wiki/Titre, //fr.wikipedia.org/wiki/Titre) et Parsoid (./Titre).
    const titleOf = (a) => {
      const href = a.getAttribute('href') || '';
      let path = null;
      if (href.startsWith('./')) path = href.slice(2);
      else {
        const i = href.indexOf('/wiki/');
        if (i === 0 || (i > 0 && /^(https?:)?\/\/[a-z0-9.-]*wikipedia\.org$/i.test(href.slice(0, i)))) path = href.slice(i + 6);
      }
      if (!path) return null;
      path = path.split('#')[0].split('?')[0];
      try { path = decodeURIComponent(path); } catch (_) {}
      return path.replace(/_/g, ' ').trim() || null;
    };
    const isRed = (a) => a.classList.contains('new') || /redlink=1/.test(a.getAttribute('href') || '');
    const isArticle = (a) => {
      if (a.classList.contains('mw-file-description') || a.querySelector('img')) return false;
      if (a.closest('sup.reference, .reference, .mw-ref')) return false;
      const t = titleOf(a);
      return Boolean(t) && !t.includes(':') && !/^\d+$/.test(t);
    };
    // Premier lien d'article d'un bloc ; un lien rouge (article inexistant) arrête la recherche
    const firstLink = (node) => {
      for (const a of node.querySelectorAll('a')) {
        if (isRed(a)) return { stop: true };
        if (isArticle(a)) return { title: titleOf(a) };
      }
      return null;
    };

    const groups = [];
    const tables = [...doc.querySelectorAll('table.wikitable')];
    // "Signature" d'un tableau = texte de ses en-têtes de colonnes. Deux tableaux de même signature
    // sont la même liste découpée (ex. un tableau par lettre), pas deux listes différentes.
    const signatureOf = (table) => {
      const headRow = [...table.querySelectorAll('tr')].find((tr) => tr.closest('table') === table && tr.querySelector('th'));
      if (!headRow) return '';
      return [...headRow.children].map((c) => c.textContent.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()).join('|');
    };
    tables.forEach((table, index) => {
      const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.querySelector('td') && tr.closest('table') === table);
      const titles = [];
      for (const tr of rows) {
        const cells = [...tr.children].filter((c) => c.matches('th, td'));
        const scope = column ? [cells[column - 1]].filter(Boolean) : cells;
        for (const cell of scope) {
          const r = firstLink(cell);
          if (r?.title) titles.push(r.title);
          if (r) break;
        }
      }
      const uniq = [...new Set(titles)];
      if (uniq.length) groups.push({ kind: 'table', index: index + 1, sig: signatureOf(table), titles: uniq });
    });

    // Tableaux de même structure -> une source fusionnée, placée avant le premier d'entre eux
    const bySig = new Map();
    for (const g of groups) {
      if (!g.sig) continue;
      if (!bySig.has(g.sig)) bySig.set(g.sig, []);
      bySig.get(g.sig).push(g);
    }
    for (const list of bySig.values()) {
      if (list.length < 2) continue;
      const merged = {
        kind: 'merged',
        index: list[0].index,
        count: list.length,
        titles: [...new Set(list.flatMap((g) => g.titles))],
      };
      groups.splice(groups.indexOf(list[0]), 0, merged);
    }

    const SKIP = '.navbox, .reflist, .references, .mw-references-wrap, #toc, .toc, .infobox, .infobox_v2, .infobox_v3, .bandeau, .metadata, .noprint, .catlinks, table';
    const fromList = [];
    for (const li of doc.querySelectorAll('ul > li, ol > li')) {
      if (li.closest(SKIP)) continue;
      const r = firstLink(li);
      if (r?.title) fromList.push(r.title);
    }
    const uniqList = [...new Set(fromList)];
    if (uniqList.length) groups.push({ kind: 'list', titles: uniqList });

    // On écarte les blocs anecdotiques (< 3 liens) s'il existe mieux (les fusions sont toujours gardées)
    const solid = groups.filter((g) => g.kind === 'merged' || g.titles.length >= 3);
    return solid.length ? solid : groups;
  }

  async function groupsFromPage(lang, page, column) {
    const json = await wiki(lang, { action: 'parse', page, prop: 'text|links', redirects: '1' });
    if (json?.error) throw new Error(`${lang}:${page} : ${json.error.info}`);
    const text = json?.parse?.text;
    const html = typeof text === 'string' ? text : (text?.['*'] || '');
    const groups = extractGroups(html, column);
    if (groups.length) return groups;

    // Dernier recours : tous les liens d'articles existants de la page (sans structure)
    const links = (json?.parse?.links || [])
      .filter((l) => (l.ns === 0 || l.ns === '0') && l.exists !== false && !('missing' in l))
      .map((l) => l.title || l['*'])
      .filter(Boolean);
    console.warn('[WM familles] aucun tableau/liste reconnu sur', page, '— HTML reçu :', html.length, 'caractères ; liens API :', links.length);
    return links.length ? [{ kind: 'links', titles: [...new Set(links)] }] : [];
  }

  async function titlesFromCategory(lang, cat) {
    const out = [];
    let cont = {};
    do {
      const json = await wiki(lang, {
        action: 'query', list: 'categorymembers', cmtitle: cat,
        cmnamespace: '0', cmlimit: 'max', ...cont,
      });
      if (json?.error) throw new Error(json.error.info);
      out.push(...(json?.query?.categorymembers || []).map((m) => m.title));
      cont = json?.continue || null;
    } while (cont);
    return out;
  }

  const isCategory = (title) => /^(catégorie|category)\s*:/i.test(title);

  // https://fr.wikipedia.org/wiki/Titre (aussi fr.m.wikipedia.org et ?title=…)
  function parseWikiUrl(input) {
    let url;
    try { url = new URL(input.trim()); } catch (_) { return null; }
    const host = url.hostname.match(/^([a-z]{2,3})(?:\.m)?\.wikipedia\.org$/i);
    if (!host) return null;
    let title = url.pathname.startsWith('/wiki/') ? url.pathname.slice(6) : url.searchParams.get('title') || '';
    try { title = decodeURIComponent(title); } catch (_) {}
    title = title.replace(/_/g, ' ').trim();
    return title ? { lang: host[1].toLowerCase(), title } : null;
  }

  // Une page précise -> une source par tableau / liste (ou la catégorie entière)
  async function sourcesFromPage(lang, title, column) {
    if (isCategory(title)) {
      const raw = await titlesFromCategory(lang, title);
      return raw.length ? [{ lang, label: `${lang}:${title} (${raw.length})`, raw }] : [];
    }
    const groups = await groupsFromPage(lang, title, column);
    return groups.map((g) => ({
      lang,
      page: title,
      label: `${lang}:${title} · ${g.kind === 'merged' ? `${g.count} tableaux de même structure` : g.kind === 'table' ? `tableau ${g.index}` : g.kind === 'links' ? 'tous les liens de la page ⚠' : 'listes à puces'} (${g.titles.length})`,
      raw: g.titles,
    }));
  }

  // Le texte saisi est-il le titre exact d'une page existante ? Renvoie le titre résolu
  async function exactPage(lang, title) {
    const json = await wiki(lang, { action: 'query', redirects: '1', titles: title });
    const page = (json?.query?.pages || [])[0];
    return page && !page.missing && !page.invalid ? page.title : null;
  }

  async function enToFr(titles) {
    const map = new Map();
    for (const part of chunk(titles, 50)) {
      let cont = {};
      do {
        const json = await wiki('en', {
          action: 'query', prop: 'langlinks', lllang: 'fr', lllimit: 'max',
          redirects: '1', titles: part.join('|'), ...cont,
        });
        const q = json?.query || {};
        const back = new Map();
        for (const n of q.normalized || []) back.set(n.to, n.from);
        for (const r of q.redirects || []) back.set(r.to, back.get(r.from) || r.from);
        for (const p of q.pages || []) {
          const fr = p.langlinks?.[0]?.title;
          if (fr) map.set(back.get(p.title) || p.title, fr);
        }
        cont = json?.continue || null;
      } while (cont);
    }
    return titles.map((t) => map.get(t)).filter(Boolean);
  }

  async function canonicalFr(titles) {
    const out = [];
    for (const part of chunk(titles, 50)) {
      const json = await wiki('fr', { action: 'query', redirects: '1', titles: part.join('|') });
      const q = json?.query || {};
      const fwd = new Map();
      for (const n of q.normalized || []) fwd.set(n.from, n.to);
      for (const r of q.redirects || []) fwd.set(r.from, r.to);
      const exists = new Set((q.pages || []).filter((p) => !p.missing && !p.invalid).map((p) => p.title));
      for (const t of part) {
        let c = fwd.get(t) || t;
        c = fwd.get(c) || c;
        if (exists.has(c)) out.push(c);
      }
    }
    return [...new Set(out)];
  }

  // Renvoie la liste des sources possibles pour un thème, la meilleure en premier
  async function findSources(theme, column, onStatus) {
    // 1) Lien Wikipédia collé
    const link = parseWikiUrl(theme);
    if (link) {
      onStatus(`Lecture de ${link.lang}:${link.title}…`);
      return sourcesFromPage(link.lang, link.title, column);
    }

    // 2) Préfixes explicites
    const m = theme.match(/^(en|fr):(.+)$/i);
    if (m) {
      const lang = m[1].toLowerCase();
      onStatus(`Lecture de ${lang}:${m[2].trim()}…`);
      return sourcesFromPage(lang, m[2].trim(), column);
    }
    if (/^cat:/i.test(theme)) {
      let cat = theme.slice(4).trim();
      if (!isCategory(cat)) cat = `Catégorie:${cat}`;
      onStatus(`Lecture de ${cat}…`);
      return sourcesFromPage('fr', cat, column);
    }

    // 3) Automatique : page au titre exact + pages "Liste…" FR/EN + catégorie FR du même nom
    onStatus('Recherche des pages…');
    const candidates = [];
    const exactFr = await exactPage('fr', theme).catch(() => null);
    if (exactFr) candidates.push({ lang: 'fr', title: exactFr, exact: true });
    else {
      const exactEn = await exactPage('en', theme).catch(() => null);
      if (exactEn) candidates.push({ lang: 'en', title: exactEn, exact: true });
    }
    for (const lang of ['fr', 'en']) {
      for (const title of await searchListPages(lang, theme).catch(() => [])) {
        if (!candidates.some((c) => c.lang === lang && c.title === title)) candidates.push({ lang, title });
      }
    }
    candidates.push({ lang: 'fr', title: `Catégorie:${theme}` });

    const pages = [];
    for (const c of candidates) {
      try {
        onStatus(`Analyse de ${c.lang}:${c.title}…`);
        const list = await sourcesFromPage(c.lang, c.title, column);
        if (!list.length) continue;
        if (c.exact) list.forEach((s) => { s.label += ' ★'; });
        pages.push({ exact: Boolean(c.exact), best: Math.max(...list.map((s) => s.raw.length)), list });
      } catch (_) { /* source ignorée */ }
    }
    // Page au titre exact d'abord (si elle contient une vraie liste), puis les pages les plus fournies.
    // À l'intérieur d'une page, les tableaux restent dans l'ordre du document.
    pages.sort((a, b) => ((b.exact && b.best >= 5) - (a.exact && a.best >= 5)) || b.best - a.best);
    return pages.flatMap((pg) => pg.list);
  }

  async function finalTitles(source, extra, exclude, onStatus) {
    let titles = source ? source.raw : [];
    if (source?.lang === 'en') {
      onStatus('Conversion des titres anglais en titres français…');
      titles = await enToFr(titles);
    }
    onStatus('Vérification des titres français…');
    titles = await canonicalFr([...titles, ...extra]);
    const ex = new Set(exclude.map(norm));
    return titles.filter((t) => !ex.has(norm(t)));
  }

  // ===================== Jeu =====================
  async function searchGame(title, page) {
    const url = new URL(`/api/cards?page=${page}&q=${encodeURIComponent(title)}&sort=rarity`, location.origin).href;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await pageFetch(url, { credentials: 'include' });
      if (res.status === 429 || res.status >= 500) { await sleep(8000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
    throw new Error('serveur indisponible (trop de requêtes ?)');
  }

  const num = (v) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : '');
  const toRow = (id, title, c) => [
    String(id), String(title), c?.rarity || '', c?.category || '', c?.image_url || '', num(c?.atk), num(c?.def),
  ];

  // Catalogue du jeu (table "cards"), titre exact, 40 titres par requête : rapide et sans faux négatifs
  async function catalogBatch(titles) {
    const session = readSession();
    if (!session) throw new Error('session introuvable');
    const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const url = new URL(`${SB_URL}/rest/v1/cards`);
    url.searchParams.set('select', 'id,wikipedia_title,rarity,category,image_url,atk,def');
    url.searchParams.set('wikipedia_title', `in.(${titles.map(quote).join(',')})`);
    url.searchParams.set('limit', String(Math.max(50, titles.length * 3)));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await pageFetch(url.toString(), { method: 'GET', credentials: 'omit', headers: sbHeaders(readSession() || session) });
      if (res.status === 429 || res.status >= 500) { await WMFG.sleep(15000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
      const json = await res.json();
      return Array.isArray(json) ? json : [];
    }
    throw new Error('catalogue indisponible');
  }

  // Recherche du site (secours) : examine plusieurs pages de résultats
  async function searchOne(title) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const json = await searchGame(title, page);
      const list = Array.isArray(json?.cards) ? json.cards : [];
      for (const raw of list) {
        const c = raw?.card || raw;
        const t = c?.wikipedia_title || c?.title;
        if (norm(t) === norm(title)) return { id: raw?.card_id || c?.id, t, c: { ...raw, ...c } };
      }
      if (!list.length || json?.searchHasMore === false) break;
      await humanDelay();
    }
    return null;
  }

  async function lookupCards(titles, onProgress, isCancelled) {
    const rows = [];
    const missing = [];
    const seen = new Set();
    let done = 0;
    const push = (hit, title) => {
      if (hit?.id && !seen.has(hit.id)) { seen.add(hit.id); rows.push(toRow(hit.id, hit.t, hit.c)); }
      else if (!hit) missing.push(title);
    };

    for (const part of chunk(titles, BATCH)) {
      if (isCancelled()) break;
      let found = null;
      try {
        const list = await catalogBatch(part);
        found = new Map();
        for (const c of list) {
          const key = norm(c.wikipedia_title);
          if (c?.id && !found.has(key)) found.set(key, c);
        }
      } catch (e) {
        console.warn('[WM familles] catalogue indisponible, recherche de secours', e);
      }

      if (found) {
        for (const title of part) {
          const c = found.get(norm(title));
          push(c ? { id: c.id, t: c.wikipedia_title, c } : null, title);
        }
        done += part.length;
        onProgress(done, titles.length, rows.length);
      } else {
        for (const title of part) {
          if (isCancelled()) break;
          let hit = null;
          try { hit = await searchOne(title); } catch (e) { console.warn('[WM familles] erreur sur', title, e); }
          push(hit, title);
          done += 1;
          onProgress(done, titles.length, rows.length);
          await humanDelay();
        }
      }
      if (found) await humanDelay();
    }
    return { rows, missing };
  }

  // ===================== Code & stockage =====================
  function b64url(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function encodeFamily(name, rows) {
    const bytes = new TextEncoder().encode(JSON.stringify([name, -1, rows]));
    let code = `F0.${b64url(bytes)}`;
    if (typeof CompressionStream === 'function') {
      try {
        const gz = new Uint8Array(await new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
        ).arrayBuffer());
        const c1 = `F1.${b64url(gz)}`;
        if (c1.length < code.length) code = c1;
      } catch (_) { /* F0 conservé */ }
    }
    return code;
  }

  function readFamilies() {
    try {
      const v = JSON.parse(localStorage.getItem(FAMILIES_KEY) || '[]');
      return Array.isArray(v) ? v.filter((f) => f?.id && f?.name && Array.isArray(f.cards)) : [];
    } catch (_) {
      return [];
    }
  }

  const rowsToCards = (rows) => rows.map((r) => ({
      id: r[0],
      title: r[1],
      rarity: ['L', 'UR', 'SR', 'R', 'PC', 'C'].includes(r[2]) ? r[2] : 'C',
      category: r[3] || null,
      imageUrl: r[4] || null,
      wikipediaUrl: `https://fr.wikipedia.org/wiki/${encodeURIComponent(String(r[1]).replace(/ /g, '_'))}`,
      atk: r[5] === '' ? null : r[5],
      def: r[6] === '' ? null : r[6],
      owned: null,
      ownedCount: 0,
    }));

  // Ajoute les cartes à une famille existante (doublons ignorés). Renvoie le nombre de cartes ajoutées.
  function mergeIntoFamily(familyId, rows) {
    const fams = readFamilies();
    const fam = fams.find((f) => f.id === familyId);
    if (!fam) throw new Error('famille introuvable');
    const known = new Set(fam.cards.map((c) => c.id));
    const fresh = rowsToCards(rows).filter((c) => !known.has(c.id));
    fam.cards = [...fam.cards, ...fresh].sort((a, b) => String(a.title).localeCompare(String(b.title), 'fr'));
    fam.updatedAt = Date.now();
    localStorage.setItem(FAMILIES_KEY, JSON.stringify(fams));
    return fresh.length;
  }

  function addToFamilies(name, rows) {
    const fams = readFamilies();
    const now = Date.now();
    const cards = rowsToCards(rows).sort((a, b) => a.title.localeCompare(b.title, 'fr'));

    fams.unshift({
      id: `family-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      cards,
      coverCardId: null,
      createdAt: now,
      updatedAt: now,
      ownershipUpdatedAt: null,
      mode: 'manual',
    });
    localStorage.setItem(FAMILIES_KEY, JSON.stringify(fams));
  }

  // ===================== Interface =====================
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; border: 0; cursor: pointer;
      padding: 10px 16px; border-radius: 999px; background: #f59e0b; color: #111; font: 700 13px/1 system-ui;
      box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .fab:hover { background: #fbbf24; }
    .panel { position: fixed; right: 18px; bottom: 66px; z-index: 2147483000; width: min(380px, calc(100vw - 24px));
      max-height: calc(100vh - 90px); overflow: auto; background: #15171a; color: #e7e7e7;
      border: 1px solid #2b2f35; border-radius: 14px; padding: 14px; box-shadow: 0 14px 40px rgba(0,0,0,.55);
      font-size: 13px; line-height: 1.4; }
    .panel[hidden], [hidden] { display: none !important; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    header b { font-size: 14px; }
    .x { background: none; border: 0; color: #999; font-size: 20px; cursor: pointer; line-height: 1; }
    label { display: block; margin: 8px 0 3px; color: #aab; font-size: 12px; }
    input, textarea, select { width: 100%; background: #0d0e10; color: #eee; border: 1px solid #333a42;
      border-radius: 8px; padding: 8px 9px; font-size: 13px; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #f59e0b55; border-color: #f59e0b; }
    textarea { resize: vertical; min-height: 54px; }
    details { margin: 8px 0; } summary { cursor: pointer; color: #aab; font-size: 12px; }
    .hint { color: #8a8f98; font-size: 11.5px; margin: 6px 0 0; }
    button.btn { border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; font-weight: 650; font-size: 13px; }
    .primary { background: #f59e0b; color: #111; width: 100%; margin-top: 10px; }
    .primary:disabled { opacity: .5; cursor: default; }
    .ghost { background: #262a30; color: #ddd; }
    .row { display: flex; gap: 8px; margin-top: 8px; } .row > * { flex: 1; }
    .box { margin-top: 12px; padding-top: 10px; border-top: 1px solid #262a30; }
    .bar { height: 6px; background: #262a30; border-radius: 99px; overflow: hidden; margin: 6px 0; }
    .bar i { display: block; height: 100%; width: 0; background: #f59e0b; transition: width .3s; }
    .status { color: #c9ccd2; font-size: 12px; min-height: 16px; }
    .err { color: #f87171; }
    .ok { color: #4ade80; }
    #code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; min-height: 70px; }
    label.inline { display: flex; gap: 6px; align-items: center; color: #ddd; font-size: 13px; }
    label.inline input { width: auto; }
    #missing { max-height: 140px; overflow: auto; color: #aab; font-size: 12px; white-space: pre-wrap; }
  `;

  const host = document.createElement('div');
  host.id = 'wmfg-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <button class="fab" id="fab" title="Générer une famille depuis un thème">＋ Famille</button>
    <div class="panel" id="panel" hidden>
      <header><b>Générateur de famille</b><button class="x" id="close" aria-label="Fermer">×</button></header>

      <label for="theme">Thème</label>
      <input id="theme" placeholder="Thème, titre de page ou lien Wikipédia" autocomplete="off">
      <p class="hint">Un thème (<i>S&amp;P 500</i>), le titre exact d'une page (<i>Sommets de plus de 8 000 mètres d'altitude</i>), un lien Wikipédia, <i>en:List of…</i> ou <i>cat:Élément chimique</i>.</p>

      <details>
        <summary>Options</summary>
        <label for="name">Nom de la famille</label>
        <input id="name" placeholder="= thème">
        <label for="col">Colonne du tableau (si le 1er lien n'est pas le bon)</label>
        <input id="col" type="number" min="1" placeholder="auto">
        <label for="extra">Titres FR à ajouter (un par ligne)</label>
        <textarea id="extra"></textarea>
        <label for="exclude">Titres FR à exclure (un par ligne)</label>
        <textarea id="exclude"></textarea>
      </details>

      <button class="btn primary" id="find">Trouver les articles</button>
      <div class="status" id="status1"></div>

      <div class="box" id="step2" hidden>
        <label for="source">Source</label>
        <select id="source"></select>
        <div class="hint" id="preview"></div>
        <div class="status" id="count"></div>
        <button class="btn primary" id="run">Générer le code</button>
      </div>

      <div class="box" id="progress" hidden>
        <div class="bar"><i id="barfill"></i></div>
        <div class="status" id="status2"></div>
        <div class="row"><button class="btn ghost" id="cancel">Arrêter</button></div>
      </div>

      <div class="box" id="result" hidden>
        <div class="status ok" id="summary"></div>
        <label for="code">Code famille</label>
        <textarea id="code" readonly></textarea>
        <label for="dest">Destination</label>
        <select id="dest"></select>
        <div class="row">
          <button class="btn ghost" id="copy">Copier le code</button>
          <button class="btn ghost" id="add">Ajouter</button>
        </div>
        <details id="missingBox"><summary id="missingSum"></summary><div id="missing"></div></details>
      </div>

      <details class="box" id="autoBox">
        <summary>Étiquette automatique à l'ouverture des paquets</summary>
        <label class="inline"><input type="checkbox" id="atOn"> Activée</label>
        <label for="atMin">Prix moyen minimum (wb, strictement supérieur)</label>
        <input id="atMin" type="number" min="0" step="1">
        <label for="atName">Étiquette</label>
        <input id="atName" maxlength="40">
        <p class="hint">Après chaque paquet, les cartes au-dessus du seuil reçoivent cette étiquette, seulement si l'exemplaire n'en a encore aucune. Nécessite le récap des prix de kzfamily.</p>
      </details>
    </div>`;
  // Styles : feuille "constructible" (non bloquée par la CSP du site), sinon <style> classique
  let sheetOk = false;
  try {
    const Sheet = window.CSSStyleSheet;
    const sheet = new Sheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    sheetOk = true;
  } catch (_) { /* repli ci-dessous */ }
  if (!sheetOk) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.prepend(style);
  }

  // Positionnement de secours via CSSOM (fonctionne même si la CSP bloque les feuilles de style)
  const pin = (node, props) => Object.entries(props).forEach(([k, v]) => node.style.setProperty(k, v, 'important'));
  pin(host, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', 'z-index': '2147483000', overflow: 'visible' });

  // Le site (React/Next.js) peut réécrire le DOM : on remonte l'interface si elle disparaît
  const mount = () => {
    if (host.isConnected) return;
    (document.body || document.documentElement).append(host);
  };
  mount();
  setInterval(mount, 1000);
  console.log('[WM familles] chargé sur', location.href, sheetOk ? '(styles OK)' : '(styles de secours)');

  const $ = (id) => root.getElementById(id);
  const el = {
    fab: $('fab'), panel: $('panel'), close: $('close'), theme: $('theme'), name: $('name'), col: $('col'),
    extra: $('extra'), exclude: $('exclude'), find: $('find'), status1: $('status1'), step2: $('step2'),
    source: $('source'), preview: $('preview'), count: $('count'), run: $('run'), progress: $('progress'), barfill: $('barfill'),
    status2: $('status2'), cancel: $('cancel'), result: $('result'), summary: $('summary'), code: $('code'),
    copy: $('copy'), add: $('add'), dest: $('dest'), atOn: $('atOn'), atMin: $('atMin'), atName: $('atName'), missingBox: $('missingBox'), missingSum: $('missingSum'), missing: $('missing'),
  };

  pin(el.fab, { position: 'fixed', right: '18px', bottom: '18px', 'z-index': '2147483000' });
  pin(el.panel, { position: 'fixed', right: '18px', bottom: '66px', 'z-index': '2147483000' });

  const togglePanel = () => { el.panel.hidden = !el.panel.hidden; if (!el.panel.hidden) el.theme.focus(); };
  // Bouton de la barre d'outils de Firefox
  ext.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'wmfg-toggle') { mount(); togglePanel(); }
  });

  try { el.theme.value = localStorage.getItem(LAST_KEY) || ''; } catch (_) {}

  // Réglages de l'étiquette automatique (lus par autotag.js à chaque paquet)
  const AT_KEY = 'wmfg_autotag';
  const AT_DEFAULTS = { enabled: true, threshold: 20, tagName: 'à vendre', color: '#22c55e' };
  const atRead = () => { try { return { ...AT_DEFAULTS, ...(JSON.parse(localStorage.getItem(AT_KEY) || '{}')) }; } catch (_) { return { ...AT_DEFAULTS }; } };
  const atCfg = atRead();
  el.atOn.checked = Boolean(atCfg.enabled);
  el.atMin.value = String(atCfg.threshold);
  el.atName.value = atCfg.tagName;
  const atSave = () => {
    const threshold = Number(el.atMin.value);
    const next = {
      ...atRead(),
      enabled: el.atOn.checked,
      threshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : AT_DEFAULTS.threshold,
      tagName: el.atName.value.trim() || AT_DEFAULTS.tagName,
    };
    try { localStorage.setItem(AT_KEY, JSON.stringify(next)); } catch (_) {}
  };
  el.atOn.addEventListener('change', atSave);
  el.atMin.addEventListener('change', atSave);
  el.atName.addEventListener('change', atSave);

  let sources = [];
  let titles = [];
  let cancelled = false;
  let last = null; // { name, rows }

  const setStatus = (node, text, cls = '') => { node.textContent = text; node.className = `status ${cls}`; };
  const familyName = () => (el.name.value.trim() || el.theme.value.replace(/^(en|fr|cat):/i, '').trim() || 'Famille').slice(0, 120);
  const column = () => { const n = parseInt(el.col.value, 10); return Number.isInteger(n) && n > 0 ? n : null; };

  el.fab.addEventListener('click', togglePanel);
  el.close.addEventListener('click', () => { el.panel.hidden = true; });
  el.theme.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.find.click(); });

  async function refreshCount() {
    const src = sources[Number(el.source.value)] || null;
    el.preview.textContent = src ? `Aperçu : ${src.raw.slice(0, 6).join(', ')}${src.raw.length > 6 ? '…' : ''}` : '';
    el.run.disabled = true;
    try {
      titles = await finalTitles(src, lines(el.extra.value), lines(el.exclude.value), (t) => setStatus(el.count, t));
      const batches = Math.ceil(titles.length / BATCH);
      const sec = Math.max(5, Math.round((batches * AVG_DELAY_MS) / 1000));
      setStatus(el.count, `${titles.length} article(s) FR à chercher dans le jeu (≈ ${sec < 90 ? `${sec} s` : `${Math.ceil(sec / 60)} min`}).`);
      el.run.disabled = titles.length === 0;
    } catch (e) {
      setStatus(el.count, String(e.message || e), 'err');
    }
  }

  el.find.addEventListener('click', async () => {
    const theme = el.theme.value.trim();
    const extra = lines(el.extra.value);
    if (!theme && !extra.length) { setStatus(el.status1, 'Entre un thème.', 'err'); return; }
    try { localStorage.setItem(LAST_KEY, theme); } catch (_) {}

    el.find.disabled = true;
    el.step2.hidden = true;
    el.result.hidden = true;
    try {
      sources = theme ? await findSources(theme, column(), (t) => setStatus(el.status1, t)) : [];
      if (theme && !sources.length) {
        setStatus(el.status1, 'Aucune liste exploitable trouvée. Essaie fr:…, en:… ou cat:….', 'err');
        return;
      }
      el.source.innerHTML = '';
      sources.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = s.label;
        el.source.append(o);
      });
      if (!sources.length) {
        const o = document.createElement('option');
        o.value = '-1'; o.textContent = 'Titres ajoutés à la main';
        el.source.append(o);
      }
      setStatus(el.status1, sources.length > 1 ? 'Vérifie la source, change-la si besoin.' : '');
      el.step2.hidden = false;
      await refreshCount();
    } catch (e) {
      setStatus(el.status1, `Erreur : ${e.message || e}`, 'err');
    } finally {
      el.find.disabled = false;
    }
  });

  el.source.addEventListener('change', refreshCount);

  el.run.addEventListener('click', async () => {
    if (!titles.length) return;
    cancelled = false;
    el.run.disabled = true;
    el.find.disabled = true;
    el.result.hidden = true;
    el.progress.hidden = false;
    el.barfill.style.width = '0%';
    setStatus(el.status2, 'Recherche des cartes dans le jeu…');

    try {
      const { rows, missing } = await lookupCards(
        titles,
        (done, total, found) => {
          el.barfill.style.width = `${Math.round((done / total) * 100)}%`;
          setStatus(el.status2, `${done}/${total} titres • ${found} carte(s) trouvée(s)`);
        },
        () => cancelled
      );
      const name = familyName();
      last = { name, rows };
      el.code.value = await encodeFamily(name, rows);
      setStatus(el.summary, `« ${name} » : ${rows.length} carte(s)${cancelled ? ' (arrêté avant la fin)' : ''}.`, 'ok');
      el.missingSum.textContent = `${missing.length} titre(s) sans carte dans le jeu`;
      el.missing.textContent = missing.join('\n');
      el.missingBox.hidden = missing.length === 0;
      fillDestinations();
      el.add.disabled = rows.length === 0;
      el.result.hidden = false;
    } catch (e) {
      setStatus(el.status2, `Erreur : ${e.message || e}`, 'err');
    } finally {
      el.progress.hidden = true;
      el.run.disabled = false;
      el.find.disabled = false;
    }
  });

  el.cancel.addEventListener('click', () => { cancelled = true; setStatus(el.status2, 'Arrêt après le titre en cours…'); });

  el.copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.code.value); }
    catch (_) { el.code.select(); document.execCommand('copy'); }
    el.copy.textContent = 'Copié ✓';
    setTimeout(() => { el.copy.textContent = 'Copier'; }, 1500);
  });

  function updateAddLabel() {
    const fam = readFamilies().find((f) => f.id === el.dest.value);
    el.add.textContent = fam ? `Compléter « ${fam.name} »` : 'Créer la famille';
  }

  function fillDestinations() {
    const keep = el.dest.value;
    el.dest.innerHTML = '';
    const fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = `Nouvelle famille « ${familyName()} »`;
    el.dest.append(fresh);
    for (const f of readFamilies()) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = `Compléter : ${f.name} (${f.cards.length} cartes)`;
      el.dest.append(o);
    }
    if ([...el.dest.options].some((o) => o.value === keep)) el.dest.value = keep;
    updateAddLabel();
  }

  el.dest.addEventListener('change', () => { updateAddLabel(); el.add.disabled = !last?.rows.length; });

  el.add.addEventListener('click', () => {
    if (!last?.rows.length) return;
    try {
      if (el.dest.value) {
        const fam = readFamilies().find((f) => f.id === el.dest.value);
        const added = mergeIntoFamily(el.dest.value, last.rows);
        el.add.textContent = `${added} carte(s) ajoutée(s) à « ${fam?.name} » ✓ (recharge la page)`;
      } else {
        addToFamilies(last.name, last.rows);
        el.add.textContent = 'Famille créée ✓ (recharge la page)';
      }
      el.add.disabled = true;
    } catch (e) {
      el.add.textContent = 'Échec : utilise Copier le code';
      console.warn('[WM familles]', e);
    }
  });

  // Exposé pour les tests
  window.__wmfg = { extractGroups, encodeFamily, findSources, finalTitles, lookupCards, addToFamilies, mergeIntoFamily };
})();
