# Portabilité : rendre meshes designer indépendant du navigateur

Plan d'action pour sortir l'app du navigateur (ou au moins du serveur) et la rendre portable. Aucune modification du code applicatif n'est requise pour aucune des options — seule la « coquille » change.

## 1. État des lieux — les 5 points d'accroche

Le code applicatif est **100 % vanilla** et n'a besoin d'aucune modification pour aucune des options. Seule la « coquille » change. Ce qui coule l'app au navigateur + serveur aujourd'hui :

| # | Dépendance | Où | Détail |
|---|---|---|---|
| 1 | **ES modules** | `main.html` l.1591+ (`<script type="module" src=…>`) | **Le vrai blocage `file://`** : Chrome refuse le chargement CORS des modules depuis `file://`. C'est la vraie raison du serveur HTTP obligatoire |
| 2 | **`localStorage`** | `io.js` (l.225, 488, 595…), `viewport.js`, `console_overlay.js` | OK sous `file://` dans Chrome/Edge/Safari, **lève `SecurityError` dans Firefox**. Quelques accès sont déjà en try/catch (`io.js` l.215), mais pas les lectures principales |
| 3 | **`FileReader`** | `convert.js` l.77, `io.js` l.929 | Le picker `<input type=file>` + FileReader marche sous `file://` ; le drag-drop aussi |
| 4 | **Export JSON** | `io.js` l.642 (`URL.createObjectURL` + `a.download`) | Fonctionne sous `file://` |
| 5 | **Autoimport `?autoimport=`** | `convert.js` l.111 (`params.get('autoimport')`), l.130 (listener `load`) | `window.location.search` fonctionne aussi sur `file://` |

Les smoke tests Playwright continueront de tourner contre le serveur de dev — ils sont un outil de dev, pas un livrable.

---

## 2. Option A — Fichier HTML unique *(zéro serveur, zéro toolchain)*

**État : ✅ réalisée** — `scripts/build-portable.mjs` + `scripts/check-portable.mjs` (raccourcis npm `build:portable` / `check:portable`, testés en CI, artefact gitignoré). Les étapes ci-dessous documentent la conception ; le README (§ Version portable) est la référence d'usage.

**Objectif :** un `meshes-portable.html` autonome qu'on double-clique. Le plus fidèle à l'éthique « zero build » du projet, transportable sur clé USB. Reste *dans* un navigateur.

**Étapes :**

1. **Script de build** `scripts/build-portable.mjs` (Node pur, sans dépendance) :
   - Parse `main.html` pour extraire les `<script type="module" src="…">` **dans l'ordre des tags** (ordre déjà topologique).
   - Concatène les fichiers dans cet ordre et **supprime les `import` / `export`**.
   - **Pièges du strip identifiés dans le code** (le script a aussi une garde `assertNoResidualImportExport` + détection de collisions top-level qui font échouer le build si un nouveau piège apparaît) :
     - Imports multi-lignes (`import {\n … } from` — partout) → strip par état « dans un import ou pas ».
     - **Renommages de collision** (les modules fusionnés partagent un seul scope) :
       - `geometry.js` l.53 `import { state as _stateForShape }` → doit devenir `const _stateForShape = state` (pas une simple suppression).
       - **`activeShape` déclaré dans editor.js ET merge.js** → le second est renommé `_activeShapeMerge` (collision découverte au premier build, gérée par `COLLISION_RENAMES`).
     - **Deux ré-exports intra-fichier** : `geometry.js` l.183 `export { TAU }` et `history.js` l.67 `export { cloneShape }` → supprimer le mot-clé `export` suffit (aucun `export … from` inter-fichier).
   - Génère une copie de `main.html` sans les tags `<script src=…>` + un `<script type="module">` inline unique contenant tout. **Astuce : un module inline n'est pas soumis au CORS `file://`** (rien n'est fetché) — c'est la clé.
2. **Shim `localStorage`** (Firefox) : en tête du script fusionné, un bloc qui essaie `window.localStorage` et le shadowe par un stockage mémoire si l'accès lève. Chrome/Edge/Safari : inchangé.
3. **Assets** : les icônes toolbar sont des SVG inline (aucun souci). **Seul `assets/favicon.svg` est référencé par l'app** (le `<link rel="icon">` de main.html) — `logo.svg` / `barre_boutons.png` ne servent qu'au README du repo, pas à la modale d'aide (vérifié : aucune image dans la modale). Le build copie le dossier `assets/` à côté du fichier quand la sortie diffère de la racine (ex. `--out dist/`).
4. **Validation** : `npm run check:portable` (rebuild + vérifs statiques + test navigateur en `file://` — canvas, édition, persistance, zoom, autoimport) ; `npm run check` côté sources pour confirmer zéro régression. Les deux sont branchés en CI. **Note : Firefox n'est pas installé sur le poste de dev — le shim `localStorage` n'a pas été testé sur le navigateur cible** (mécanisme standard, Chrome/Edge/Safari inchangés).
5. **Maintenabilité** : les sources multi-fichiers restent canoniques ; `build-portable.mjs` est un artefact généré (script `npm run build:portable`), la sortie `meshes-portable.html` est **gitignorée** (avec `dist/` pour `--out dist/`), toujours régénérable.

**Résultat :** un seul fichier, double-clic → l'app tourne hors-ligne, sans serveur.

---

## 3. Option B — Tauri *(vraie app native, légère)*

**Objectif :** une fenêtre native, plus aucun navigateur. **Aucune modification du code applicatif** — le webview système exécute `main.html` tel quel, et localStorage / FileReader / drag-drop / downloads / `devicePixelRatio` fonctionnent dedans.

**Étapes :**

1. **Scaffold** : `npm create tauri-app` (template vanilla) ou à la main — un dossier `src-tauri/` avec `Cargo.toml` + `tauri.conf.json`, `frontendDist: "../"` (la racine du projet).
2. **Aucun changement de code** ✅. `state.board`, resize, HUD, modales : tout marche dans le webview.
3. **Config cosmétique** : `productName`, icône depuis `assets/logo.svg`, taille de fenêtre.
4. **Optionnel — dialogs natifs** : plugin `tauri-plugin-dialog` (open/save natif) pour remplacer le picker HTML. Pas requis.
5. **Build** : `npm run tauri build` → un binaire par OS : `.deb`/`.rpm`/AppImage (Linux), MSI/NSIS — variante **portable** (Windows), `.dmg` (macOS). **~3-10 Mo par binaire.**
6. **Prérequis toolchain** : Rust + sur Linux `libwebkit2gtk-4.1-dev` + `build-essential` ; Windows WebView2 (pré-installé) ; macOS Xcode CLI.
7. **Piège mineur** : `?autoimport=` (outil de dev) — paramètre d'URL supporté par la config Tauri, non bloquant pour la prod.

**Résultat :** l'app native, portable en un seul exécutable. Le meilleur ratio « indépendance du navigateur » / taille / effort.

---

## 4. Option C — Electron *(le plus simple, le plus lourd)*

1. `npm init -y` + `npm i -D electron electron-builder` ; un `main.js` ouvrant `main.html` en `BrowserWindow`.
2. Aucun changement de code ; localStorage persisté dans `userData`.
3. `electron-builder` → portable `.exe`/zip/`.dmg`/AppImage. **~150-250 Mo** (Chromium embarqué).
4. À choisir seulement si tu veux zéro toolchain Rust et que le poids ne te dérange pas.

---

## 5. Option D — Neutralino *(le plus petit binaire, écosystème réduit)*

1. CLI `neu` ; les fichiers sont embarqués dans une ressource binaire ; app **~2-3 Mo**, webview système.
2. App inchangée ; APIs natives `Neutralino.storage` / `Neutralino.os` disponibles si besoin.
3. Moins de docs et de communauté que Tauri.

---

## 6. Recommandation

1. **Option A (build portable) : ✅ faite.** Elle débloque « zéro serveur + clé USB » et sert de filet de sécurité pour la suite.
2. **Ensuite l'Option B (Tauri)** pour la vraie indépendance du navigateur : natif, léger, code inchangé.
3. Electron/Neutralino en dernier recours selon les contraintes de poids/toolchain.

## 7. Travail commun si on veut aller plus loin

- Extraire les accès `localStorage` derrière une couche `storage.js` (unique point d'échange : fallback fichier plat, ou API native Tauri/Electron).
- Déplacer `FileReader` derrière un service d'import (permet de brancher les dialogs natifs).
- Remplacer l'autoimport URL par un argument de ligne de commande (Tauri/Electron).
