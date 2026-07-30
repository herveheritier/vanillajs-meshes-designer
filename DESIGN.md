# DESIGN.md — design log de `vanillaJS-meshes-designer`

Ce document consolide le **pourquoi** du projet : invariants métier, choix de modélisation,
hacks conservés pour leur raison d'être, anti-régressions observées. Les commentaires
inline dans le code source ne portent plus que des descriptions courtes de type
**what** (1-2 lignes par fonction ou bloc logique), avec un cross-ref
`// Rationale : voir DESIGN.md §X.Y` quand la justification est ailleurs.

## §0. Maintenance de DESIGN.md (anti-drift)

DESIGN.md est une **vue extraite** du code. Si une section devient obsolète par un
changement de comportement dans le code source :

1. **Mettre à jour DESIGN.md EN PREMIER** (avant le commit du changement de code)
   — les cross-refs `// voir §X.Y` dans le code pointeront alors vers une version
   à jour.
2. **Si une nouvelle règle émerge qui mérite DESIGN.md**, créer la section, puis
   ajouter le cross-ref correspondant dans le code.
3. **Si une règle inline devient triviale ou évidente**, la supprimer du code SANS
   toucher DESIGN.md (le doc reste la source de vérité pour les invariants).

Failure mode typique : un futur contributeur modifie `deleteSelectedSegment` sans
toucher §4.1 → le doc dérive. À détecter en revue de PR par grep croisé
`grep -n 'voir DESIGN.md §' <files>` vs sections effectivement présentes.

---

## Lexique

- **MODÈLE** : coordonnées logiques, X→droite, Y→haut (maths).
- **SCREEN** : pixels du canvas, X→droite, Y→bas (inversion canvas).
- **GRAB** : session de drag en cours (`ACTION_GRABBING`).
- **FORME COURANTE / active** : la forme sélectionnée (état `state.activeShapeIndex`).
- **FORME inactive** : toute autre forme du `state.shapes`.

---

## §1. Architecture des modules

### §1.1 Rôle et responsabilités (1 module = 1 domaine)

| Fichier                  | Domaine                                                           | Hors-scope                                                          |
|--------------------------|-------------------------------------------------------------------|---------------------------------------------------------------------|
| `main.js`                | Routeur : entrants DOM globaux + toolbar, point d'entrée          | Pas de logique métier                                               |
| `constants.js`           | Constantes pures, sans dépendance                                 | —                                                                   |
| `state.js`               | Source unique de vérité mutable                                   | N'importe aucun autre module (pas de cycle)                         |
| `draw.js`                | Primitives de rendu canvas en SCREEN                              | Pas de calcul en MODÈLE                                             |
| `editor.js`              | Manipulation scène/points : sélection, hover, find, grab, addPoint | Pas de CRUD formes (→`shapes.js`), pas d'historique (sauf `saveState`), pas de zoom/pan (→`viewport.js`) |
| `viewport.js`            | Zoom, pan, wheel, projection, reticule                            | Pas de manipulation de points                                       |
| `shapes.js`              | CRUD de formes (`addShape`, `deleteShape`, `goToShape`)           | —                                                                   |
| `geometry.js`            | Calculs géométriques purs (`snapToGrid`, `screenToModel`, …)      | —                                                                   |
| `io.js`                  | Sérialisation, persistance, import/export                         | —                                                                   |
| `history.js`             | Pile undo/redo                                                    | —                                                                   |
| `hud.js`                 | Mises à jour DOM des HUD (pill, counters, button enabled state)   | —                                                                   |
| `modals.js`              | Modales réutilisables                                             | —                                                                   |
| `console_overlay.js`     | Console de logs interne (`#messageLog` + drag handle)             | —                                                                   |
| `convert.js`             | Parser `meshes-format` ↔ JSON multi-shape                         | —                                                                   |
| `merge.js`               | Réorganisation des triangles après un delete                      | —                                                                   |

**Règle anti-cycle** : `state.js` n'importe aucun autre module métier (source amont
de vérité). Les autres modules importent `state.js` mais ne s'importent jamais
entre eux cycliquement. Les rares exceptions (e.g. `consoleOverlay` ↔ `main.js`
pour `applyConsoleFrame`) sont documentées localement.

`main.js` est un **routeur** (thinned orchestrator). Les listeners globaux
partagés entre plusieurs modules y vivent (`mousedown` sur board ⇒ shape
management + grab + pan selon le bouton ; `keydown` ⇒ shortcuts clavier). Les
listeners locaux à un module vivent DANS leur module (`wireGridControl`,
`wireHelpModal`, …) et sont appelés depuis `main.js`.

### §1.2 Le `state` comme objet unique (pas de `let` exports)

Pourquoi un objet `state` mutable exporté plutôt que des `let` top-level ?

- **Bindings ES module = read-only** : `import { shapes } from './state.js'` ne
  permet pas `shapes = []` chez l'importer (seulement `state.shapes = []`, qui
  est une mutation de propriété, OK).
- **Référence unique documentée** : les modules dépendants importent `state`
  une fois et accèdent aux sous-propriétés (`state.shapes`, `state.ctx`).
- **Tree-shaking** : pas de pluralité de `let` top-level.
- Pas d'imports croisés surprises d'ordre d'initialisation.

`state.initDomRefs(board, ctx, …)` est exposé comme helper : `main.js` l'appelle
au boot, après quoi les références DOM sont figées.

---

## §2. Système de coordonnées

### §2.1 Inversion Y entre MODÈLE et SCREEN

- **MODÈLE** : X vers la droite, Y vers le haut (maths).
- **SCREEN** : X vers la droite, Y vers le bas (canvas).
- `modelToScreen(p)` : `screenX = centerX + (p.x - viewCenter.x) * zoom`,
  `screenY = centerY - (p.y - viewCenter.y) * zoom`.
- Toutes les fonctions `draw.js` travaillant en pixels passent par
  `modelToScreen(p)` ou une formule directe équivalente. Jamais de coordonnées
  MODÈLE envoyées directement aux primitives canvas.

### §2.2 Ancrage des axes et de la grille sur l'origine MODÈLE

Les axes (`drawAxis`) tracent l'origine `(0, 0)` en SCREEN — pas le centre du
board. `drawGrid` est aligné sur la même ancre pour que les intersections
dessinées correspondent EXACTEMENT aux positions vers lesquelles `snapToGrid`
accroche (multiple de `GRID_STEP` depuis 0). Sans cette cohérence, l'utilisateur
verrait la grille mais son snap irait ailleurs (cf. commit `982b694 Anchor
drawGrid on model origin`).

Avec AltGr + molette (§6), la "rotation de scène" mute les **vertices** de
chaque forme. Les axes restent fixes (repère MODÈLE de référence), le contenu
tourne autour — d'où la formule de projection directe dans `drawAxis` plutôt
que `modelToScreen` (protège contre tout couplage futur type filtres/snapping).

Si l'origine est hors canvas après un zoom, l'axe n'est pas tracé (un seul
stroke pour éviter de casser le motif dash).

### §2.3 Mode partial vs complete dans `drawTriangle`

`drawTriangle(p1, p2, p3, …)` rend différemment selon la complétude :

- `p3 === undefined` (triangle **partiel** en cours d'`addPoint`) : trace
  `p1 → p2` seulement, **pas de fill ni de `closePath`** — préserve le flux
  addPoint.
- Triangle **complet** (`p3 !== undefined`) : `closePath()` AVANT `fill()` puis
  retracé en `stroke()` pour préserver le rendu visuel des versions antérieures.

`fillStyle` est positionné **juste avant `fill()`** (pas en début de fonction)
pour éviter de polluer entre triangles consécutifs si le caller n'a pas
réinitialisé.

---

## §3. Modes de sélection (vertex / segment / triangle)

Cycle via le bouton toolbar `#selectionMode` (cf. `SELECTION_MODES = ['vertex',
'segment', 'triangle']`). Mode courant persisté dans
`meshesDesigner.selectionMode` pour survivre aux reloads.

### §3.1 Ordre du cycle

`vertex` en premier → premier toggle va à `segment` (la découverte de feature
la plus naturelle : un utilisateur expérimenté cherchera à ajouter un triangle
sur un edge existant).

### §3.2 Sémantique par mode

| Mode        | Cible du clic                                                       | Sélectionne                                                          |
|-------------|---------------------------------------------------------------------|----------------------------------------------------------------------|
| **vertex**  | Point le + proche (rayon < 15 unités MODÈLE)                        | Cluster de refs partageant cette position                            |
| **segment** | Edge (projection orthogonale entre 2 sommets)                       | Tous les points dans les 2 endpoints via `collectUnderlyingPoints`   |
| **triangle**| Hit `pointInTriangle` (inclusif sur edge) + tolérance centroïde 20  | 3 sommets du triangle hovered                                       |

### §3.3 Hiérarchie de hit pour `findNearestTriangle`

**Priorité absolue** : un triangle contenant STRICTEMENT le curseur bat un
near-centroid. Sans cette règle, un petit triangle T_near dont le centroïde est
à 5 unités pourrait supplanter un grand T_inside dont le centroïde est à 200
unités — alors que l'utilisateur a cliqué DANS T_inside.

Au sein d'une même priorité (inside-inside ou near-near), **centroïde le plus
proche gagne** (utile pour triangles voisins ou overlapping).

### §3.4 Tolérance centroïde (`CENTROID_HIT_RADIUS = 20`)

Confort UX : un clic à 1-2 px d'une edge (snap, perception humaine) doit
quand même sélectionner le triangle élargi. Plus permissif que le rayon
vertex (15) — un tiers plus large.

### §3.5 Test point-in-triangle

Via le signe du cross-product 2D `(b-a) × (c-a)` : `> 0` si p à gauche du
vecteur `a→b` (maths), `< 0` si à droite, `= 0` si colinéaire. Pour tolérer
l'orientation du triangle, on accepte le signe partagé (tous mêmes signes ou
zeros). `pointInsideTriangle` est **inclusif sur les edges** (cas
floating-point où un des `d1/d2/d3` peut être 0).

### §3.6 Modificateurs de clic (Shift / Ctrl / Cmd / rien)

Trois modifiers × modes :

| Mode        | Plain-click          | Shift-click                 | Ctrl/Meta-click              |
|-------------|----------------------|------------------------------|------------------------------|
| **Entité du mode** | Remplace la sélection | Toggle (déjà → retire, pas là → ajoute) | Ajoute SANS toggle (idempotent) |
| **Espace vide**    | Vide + crée nouveau point | Préserve + crée nouveau point | Préserve, NE CRÉE PAS de point |

---

## §4. Règles de suppression (touche Backspace, par mode)

### §4.1 Règle par mode

- **vertex** (`deleteSelectedPoint`) : supprime le point des slots des
  triangles qui le référencent. Les triangles dont il reste < 2 points
  survivants sont filtrés. Les **segments incidents** à P disparaissent
  (l'un de leurs endpoints n'existe plus) ; le **segment OPPOSÉ** du triangle
  survit si ses 2 autres sommets existent.
- **segment** (`deleteSelectedSegment`) : supprime TOUS les triangles dont
  **≥ 2 slots** matchent les endpoints du segment. Les triangles dont 0-1
  slot match survivent (leurs autres slots gardent leur ref → points GC
  implicitement s'ils ne sont plus référencés ailleurs).
- **triangle** (`deleteSelectedTriangle`) : supprime UNIQUEMENT les triangles
  dont les **3 slots** matchent les sommets du/des triangles sélectionnés.
  Distinction stricte avec le mode segment : `matchCount === 3` ici (vs
  `>= 2`) car "uniquement les triangles sélectionnés" — pas ceux qui partagent
  un sommet ou un edge.

### §4.2 Anti-régression doublure (toutes les `delete*`)

- `saveState()` en tête (rend l'opération annulable via undo — la pile
  contient l'état avant suppression, pas après).
- `reset selection + hover + draw + HUD + persist` en queue.
- No-op silencieux si cibles vide (rien ne se passe sans sélection NI cible
  fallback selon le mode).

### §4.3 Refresh `nearestLine` au point de clic dans `addPoint`

`addPoint()` recalcule `state.nearestLine` au moment du clic (pas depuis la
valeur cachée par `updateMouseHover` au dernier mousemove). Sans ça, un
nouveau triangle pouvait être créé sur une edge qui n'est plus sous le
curseur (cas souris immobile, déplacement rapide, ou clic sans mousemove
intermédiaire).

`state.nearestPoint` n'est PAS re-touché dans `addPoint` — sa propre mise à
jour suit son cycle de hover et n'est pas consommé par l'ajout.

---

## §5. Persistance

### §5.1 Séparation scene / preferences

- **Scene** : `meshesDesigner.shapes`, `meshesDesigner.zoom`,
  `meshesDesigner.viewCenter`, `meshesDesigner.gridStep`, …
  (`state.persistState` sérialise).
- **Preferences** : `meshesDesigner.consoleVisible`,
  `meshesDesigner.consoleFrame`, `meshesDesigner.selectionMode`,
  `meshesDesigner.reticleMode`, `meshesDesigner.importMode`.

Préfixe `meshesDesigner.` partout explicite pour audit devtools rapide.
Isolation entre les deux groupes : clear une clé preference n'affecte pas la
scene.

### §5.2 Cycle `meshesDesigner.consoleFrame`

`consoleFrame = { left, top, width, height }` en pixels, restauré au boot et
persisté après chaque drag/resize (mouseup document-level — pas à chaque tick,
pour éviter de polluer ainsi que la history stack).

---

## §6. Rotation AltGr (molette)

### §6.1 Sémantique : mutation per-shape, pas rotation de caméra

AltGr + molette n'est PAS une transformation du viewport — c'est une mutation
**per-shape** : `rotateEachShapeAroundPivot` translate TOUS les vertices de
TOUTES les formes autour d'un pivot en coords MODÈLE. Les axes restent fixes
(§2.2) car ils représentent le repère MODÈLE de référence.

### §6.2 Pivot qui suit le curseur en MODÈLE

À chaque tick du wheel handler, le pivot est re-évalué via
`screenToModel(cursorScreen)` :

- Si la souris reste fixe : pivot invariant.
- Si elle bouge : pivot suit → rotation orbitale autour d'un point qui suit
  le curseur.

### §6.3 Clear selection au 1er tick d'une gesture

La rotation mute TOUS les points, pas seulement la sélection courante. Si on
garde le surlignage cyan sur la sélection, l'UX est trompeuse ("seuls ces
points tournent"). D'où `state.selectedPoints = []` au 1er tick, AVANT la
première rotation effective.

---

## §7. Couleurs et feedback visuel

### §7.1 Inactif (formes non-courantes)

Gris atténué (`#5A5A5A` lignes, `#7A7800` points) pour signaler
"non-éditable" tout en restant visible. **PAS de fill sur triangles inactifs**
— simples contours gris pour conserver le signal de non-éditabilité (un wash
transparent masquerait ce signal).

### §7.2 Actif (forme courante)

- Contours blancs 1 px en tirets `PATTERN_LINES = [2, 2]`.
- Points jaunes `#FFFF00`.
- Fill léger `rgba(255, 255, 255, 0.10)` sur triangles (wash subtil, ne
  concurrence pas les points/contours). Override-able via `t.fill` (couleur
  custom persistée par triangle).

### §7.3 Sémantique `bg` vs `fill` des swatches (panneau `triangleColor`)

Pour chaque preset dans `TRIANGLE_COLOR_PRESETS` :

- `bg` : couleur pleine opaque (rendu du swatch, pour lisibilité sur fond
  sombre).
- `fill` : même couleur avec `alpha = 0.45` (passée à `t.fill`,
  semi-transparente pour ne pas écraser contours jaunes + hover vert).

Le blanc du preset correspond visuellement au fill par défaut
`COLOR_TRIANGLE_FILL_ACTIVE` (rgba blanc 0.1) — "pas de couleur custom"
équivalent.

### §7.4 Feedback hover (3 modes de sélection)

- **vertex** : point vert oversized 5 px (`#00FF00`) au sommet le + proche.
- **segment** : trait vert épais 3 px `rgba(0, 255, 0, 0.7)` sur l'edge
  hovered. Vert + épais pour **ressortir nettement** parmi :
  - contours blancs 1 px des triangles actifs,
  - pointillés gris 1 px `[4, 4]` des inactives,
  - axes verts foncés dash `[2, 1, 3, 1]`.
- **triangle** : triangle hovered rempli en `rgba(0, 255, 0, 0.18)` + contour
  `rgba(0, 255, 0, 0.6)`.

`lineWidth` est **reset à 1** après chaque stroke (ne pas polluer les rendus
subséquents : axes via `drawAxis`, drawShape / drawTriangle d'autres formes,
reticule, …).

### §7.5 Action enum (`ACTION_NONE`, `ACTION_GRABBING`)

`ACTION_NONE = undefined` (intentionnel, pas `0`) : idiome
`currentAction === undefined` comparable sans cast et exprime clairement "pas
d'action en cours". `ACTION_GRABBING = 1` (drag d'un point en cours).

---

## §8. Conventions diverses

- **Mouse buttons** : `e.button === 0` est le left-click canonique partout.
  `middle-click` sur canvas = pan.
- **AltGr** : détection via `getModifierState('AltGraph')` OU
  `(ctrlKey && altKey)` (browser-inconsistent, AltGr mal exposé sur Firefox
  Linux).
- **`#messageLog`** : mutations via `appendChild` / nouvelles `<div>`, JAMAIS
  `messageBoard.innerText = …` (détruirait drag handle + clear button).
- **CONSOLE_MIN_WIDTH / MIN_HEIGHT** : 80 × 30 px, `resize` handler clamp
  sur ces minimums.
- **Drag overlay** : `persist` uniquement à la fin du drag (mouseup
  document-level), pas à chaque tick.
- **Import drag-drop / FileReader** : bloqué sous `file://` → projet doit
  être servi via HTTP (`python3 test_server.py`).
- **Modèles coord** : `state.ctx = { center, viewCenter, zoomLevel }`,
  `zoomLevel` clampé `[0.1, 10]`, snapé à 0.1 près pour que valeur réelle,
  persistée et affichée matchent.
- **No build / no transpile** : édits + reload = itération. Pas de HMR.
