// Proxy vers l'API publique de Wikipédia (évite les blocages CORS/CSP de la page du jeu).
const api = globalThis.browser || globalThis.chrome;

// Clic sur le bouton de la barre d'outils : ouvre/ferme le panneau sur l'onglet WikiMasters
api.browserAction?.onClicked.addListener(async (tab) => {
  const onGame = /^https:\/\/(www\.)?wiki-masters\.com\//.test(tab?.url || '');
  if (!onGame) {
    await api.tabs.create({ url: 'https://www.wiki-masters.com/collection' });
    return;
  }
  try {
    await api.tabs.sendMessage(tab.id, { type: 'wmfg-toggle' });
  } catch (_) {
    // Script pas encore injecté (onglet ouvert avant l'installation) : on recharge l'onglet
    await api.tabs.reload(tab.id);
  }
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'wmfg-wiki') return undefined;

  const lang = String(msg.lang || '');
  if (!/^[a-z]{2,3}$/.test(lang)) {
    sendResponse({ error: 'langue invalide' });
    return undefined;
  }

  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  Object.entries({ format: 'json', formatversion: '2', ...(msg.params || {}) })
    .forEach(([k, v]) => url.searchParams.set(k, String(v)));

  fetch(url.toString(), { headers: { 'Api-User-Agent': 'WM-Famille-Generateur/1.0' } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Wikipédia HTTP ${res.status}`))))
    .then((json) => sendResponse({ json }))
    .catch((error) => sendResponse({ error: String(error?.message || error) }));

  return true; // réponse asynchrone
});
