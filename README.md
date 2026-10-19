# WikiMasters – Générateur de familles

Module complémentaire à **WikiMastersTools-kzfamily**, pensé autour de sa page « Familles ».
Code libre de réutilisation : prenez ce qui vous intéresse.

Testé sur Firefox (Manifest V2). Aucune dépendance, aucun serveur tiers : tout tourne dans le navigateur.

## Installation (Firefox)

1. Télécharger le dépôt (Code → Download ZIP) et le dézipper.
2. Ouvrir `about:debugging#/runtime/this-firefox` → **Charger un module temporaire…** → choisir `manifest.json`.
3. Recharger WikiMasters (F5). Le bouton **＋ Famille** apparaît en bas à droite.

Un module temporaire disparaît au redémarrage de Firefox ; pour une installation permanente, signer l'extension sur addons.mozilla.org (mode non listé).

## Fonctionnalités

### 1. Générer une famille depuis Wikipédia (bouton ＋ Famille)
- Entrée : un thème (`S&P 500`), le titre exact d'une page (`Sommets de plus de 8 000 mètres d'altitude`),
  un lien Wikipédia (`https://fr.wikipedia.org/wiki/…`, mobile accepté), `en:List of…`, `fr:Liste…` ou `cat:Catégorie`.
- Lecture des pages via l'API publique Wikipédia : chaque tableau `wikitable` devient une source,
  les tableaux de même structure (ex. un tableau par lettre) sont fusionnés, repli sur les listes à puces
  puis sur tous les liens de la page. Formats HTML classique et Parsoid (`./Titre`) gérés.
- Pages anglaises converties en titres FR via les liens interlangues ; redirections résolues.
- Correspondance avec les cartes du jeu par **titre exact**, 40 titres par requête sur la table `cards`
  (même méthode que `bridge/families.js` de kzfamily) ; repli sur `/api/cards?q=` si besoin.
- Résultat : code `F1.` compatible avec l'import kzfamily, ou ajout direct dans `wm_families_v1`
  (nouvelle famille ou compléter une famille existante).

### 2. Tuile de prix sur la page Familles
- Sur chaque famille : prix moyen, valeur totale, valeur des cartes manquantes.
- Lit le cache de prix de kzfamily (`wm_avg_v3_<id>` / `wm_avg_v4_<id>`), bouton « Charger les prix manquants »
  qui remplit ce même cache via `/api/marketplace/cards/<id>/sales?scope=summary`.
- Tri des familles : nom, taille, valeur totale/restante, possédées, restantes, complétude (via `order` CSS, sans toucher au DOM de kzfamily).
- Renommer une famille.

### 3. Liste de souhaits du jeu
- « Ajouter les manquantes » / « Ajouter toute la famille » → `POST /rest/v1/wishlist_items`.
- Décompte réel de ce qui est déjà dans la liste (`GET wishlist_items?user_id=eq.…`), boutons masqués quand tout est fait.

### 4. Étiquettes du jeu
- Étiqueter en masse tous les exemplaires possédés d'une famille (étiquette existante ou nouvelle) :
  `tags`, `user_cards`, `user_card_tags`.
- **Étiquette automatique à l'ouverture des paquets** : chaque carte tirée dont le prix moyen dépasse un seuil
  (20 wb par défaut) reçoit l'étiquette « à vendre », uniquement si l'exemplaire n'a encore aucune étiquette.
  Détection via interception de `/api/packs/open` (Firefox `exportFunction`) et via les événements kzfamily
  `wm-average-pack-opened` / `wm-average-open-all-packs-*`. Réglages dans le panneau ＋ Famille.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV2 Firefox, permissions `*.wikipedia.org` + Supabase du jeu |
| `background.js` | Proxy vers l'API Wikipédia (évite CORS/CSP de la page) + bouton de barre d'outils |
| `common.js` | Outils partagés : session Supabase (cookie `sb-…-auth-token`), en-têtes, rythme de requêtes variable |
| `content.js` | Panneau ＋ Famille : Wikipédia → titres → cartes → code / ajout aux familles |
| `prices.js` | Tuiles de prix, tri, renommage, liste de souhaits, étiquettes en masse (page Familles) |
| `autotag.js` | Étiquette automatique à l'ouverture des paquets |

## Points d'intégration avec kzfamily

- Familles : lecture/écriture de `localStorage.wm_families_v1` au format natif de kzfamily.
- Code famille : `F0.` / `F1.` + base64url(gzip(JSON `[nom, indexCouverture, [[id, titre, rareté, catégorie, image, atk, def], …]]`)).
- Prix : réutilise et alimente le cache `wm_avg_v3_` / `wm_avg_v4_`.
- UI : s'injecte autour de `.wm-family-grid`, `.wm-family-card`, `.wm-family-detail-head` (sélecteurs de kzfamily).
- Session : relue dans le cookie Supabase à chaque appel, jamais stockée.

## Portage MV3 / Chrome (si vous reprenez le code)

- `exportFunction` / `wrappedJSObject` (autotag.js) sont propres à Firefox : sous Chrome, passer par le bridge
  page-world de kzfamily (il émet déjà `wm-average-pack-opened`).
- `background.scripts` → `service_worker` ; `DOMParser` reste côté content script (déjà le cas).

## À savoir

- Certaines fonctions écrivent dans le compte du joueur (liste de souhaits, étiquettes) et toutes font des requêtes
  au jeu. Les règles de WikiMasters interdisent l'automatisation : à utiliser en connaissance de cause.
  Les requêtes suivent un rythme variable (0,9–2,6 s, pauses régulières) et sont regroupées quand c'est possible.
- Les endpoints `user_cards` et la lecture de `wishlist_items` / `tags` ont été déduits des requêtes du site
  (format PostgREST) et peuvent changer sans prévenir.

## Licence

MIT : libre de réutilisation, modification et redistribution.
