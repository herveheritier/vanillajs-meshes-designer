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
- **PLAN COURANT / actif** : le plan sélectionné (état `state.activeShapeIndex`).
- **PLAN inactif** : tout autre plan du `state.shapes`.

---

## §1. Architecture des modules

### §1.1 Rôle et responsabilités (1 module = 1 domaine)

| Fichier                  | Domaine                                                           | Hors-scope                                                          |
|--------------------------|-------------------------------------------------------------------|---------------------------------------------------------------------|
| `main.js`                | Routeur : entrants DOM globaux + toolbar, point d'entrée          | Pas de logique métier                                               |
| `constants.js`           | Constantes pures, sans dépendance                                 | —                                                                   |
| `state.js`               | Source unique de vérité mutable                                   | N'importe aucun autre module (pas de cycle)                         |
| `draw.js`                | Primitives de rendu canvas en SCREEN                              | Pas de calcul en MODÈLE                                             |
| `editor.js`              | Manipulation scène/points : sélection, hover, find, grab, addPoint | Pas de CRUD plans (→`shapes.js`), pas d'historique (sauf `saveState`), pas de zoom/pan (→`viewport.js`) |
| `viewport.js`            | Zoom, pan, wheel, projection, reticule                            | Pas de manipulation de points                                       |
| `shapes.js`              | CRUD de plans (`addShape`, `deleteShape`, `goToShape`) + ordre (`moveShapeUp`/`moveShapeDown`, §7.13) | — |
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

**Schéma canonique des plans (post-refactor `modifyShapeModel-spec` §0–§5)** :
`state.shapes[i]` = `{ pointList: [{x,y}, …], tris: [{p1,p2,p3 (indices)}, …] }`.
Le `pointList` est la **liste canonique des sommets** d'un plan ; tous
les `tris[k].pX` sont des indices dans ce tableau. Aucun partage
cross-shape — chaque plan a son propre `pointList` (Q1a §modify-shape-
model-spec.md §1). Plus de JS-refs dans les slots : tout est adressable
par indice (Q1c), ce qui simplifie le drag d'un sommet partagé
(`pointList[idx].x = targetX` en O(1) au lieu de N mutations de slots),
la suppression avec compactage immediat (Q2a), et la fusion de doublons
adjacents (invariant I3).

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

---## §1.3 Mode d'édition unique (`edition`)

`state.editingMode` n'a qu'une seule valeur persistée en localStorage :
**`edition`**. L'ancienne matrice a trois modes (`edition`, `construction`,
`selection`), cyclée via le bouton toolbar `#editMode` et le raccourci `E`,
a été réduite à un seul contrat de clic pour simplifier le modèle mental et
éliminer les branches mortes :

- **Clic gauche** dans le vide : crée un point à la position du curseur
  (snappé à la grille si active). **Clic gauche** sur une entité existante :
  sélectionne selon `state.selectionMode` (sommet / segment / triangle).
- **Clic gauche + drag** : délimite un lasso sans déplacer la géométrie.
- **Clic droit simple** : sélectionne uniquement l'entité la plus proche selon
  `state.selectionMode` et désélectionne les autres. Sans cible dans le
  rayon de tolérance, la sélection est effacée.
- **Clic droit + drag** : déplace la sélection depuis n'importe quel point
  du canvas ; sans sélection engageante, sélectionne puis déplace l'entité
  sous le pointeur selon `state.selectionMode`.
- **Ctrl/Cmd + clic droit** : ajoute l'entité sous le pointeur à la
  sélection sans la déplacer (`selectAtRightClick` additif, court-circuit
  avant `beginGrabbing`).
- **AltGr + clic droit + drag** : déplace **tous** les plans ensemble
  avec le même delta (mode AltGr quasi-global).
- **Backspace** : supprime selon `state.selectionMode` (sommet / segment /
  triangle). `⇧+Backspace` : reset complet (modale de confirmation).

Le champ `state.editingMode` reste exposé à `'edition'` pour la migration
silencieuse d'anciennes sessions (cf. `restoreEditingMode` dans
`viewport.js`) qui auraient stocké `construction` ou `selection` dans la clé
`meshesDesigner.editingMode`. `EDITING_MODES = ['edition']` dans
`constants.js` est la source de vérité pour la validation de la valeur
restaurée. Aucune écriture ultérieure n'a lieu — il n'y a plus de toggle UI
à persister (`toggleEditingMode` et `wireEditingModeControl` ont été
supprimés ; `updateEditingModeButton` n'est plus exposé par `hud.js`).


### §1.4 Hit-testing en pixels écran

Les seuils de détection sont définis en pixels (`POINT_HIT_RADIUS_PX`,
`LINE_HIT_RADIUS_PX`, `TRIANGLE_CENTROID_HIT_RADIUS_PX`) puis convertis en
unités modèle par division par `state.ctx.zoomLevel`. Ainsi la zone de clic
visuelle reste stable lorsque l’utilisateur zoome ou dézoome. Les résultats de
`findNearestPoint` et `findSelectedLine` exposent leur distance modèle pour
permettre au caller d’appliquer le seuil correspondant. Les arêtes dégénérées
sont projetées sans division par zéro.

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
chaque plan. Les axes restent fixes (repère MODÈLE de référence), le contenu
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

### §2.4 Pipeline de rendu offscreen et HUD de stats (branch `feature/performance`)

Le rendu canvas suit un pipeline **deux-tiers** introduit sur la branch
`feature/performance` pour eviter les repeints inutiles sur input
subtil (mousemove sur zone vide, mouseup sans mutation reelle, etc.) :

1. **SCENE STABLE** (depend du modele : `state.shapes`,
   `state.ctx.zoomLevel`/`viewCenter`, `state.selectedPoints`,
   `state.selectedTriangles`, `state.GRID_STEP`, `state.activeGrid`) :
   peinte integralement dans un canvas **offscreen** puis blitee sur
   le visible via `state._ctx.drawImage(offscreen, 0, 0)` (= 1 memcpy
   rapide meme pour un grand canvas). Cf. `draw.js` `renderSceneToOffscreen`.
2. **SURFACE TRANSITOIRE** (depend du runtime : reticule +
   selectionBox, cf. `renderTransient` dans `draw.js`) : repeinte a
   chaque frame SUR le visible, par-dessus le blit -- peut bouger
   entre deux frames meme si la scene stable est inchangee.

Deux mecanismes cooperent pour minimiser les repeints :

- **`requestDraw` coalescing** (cf. `draw.js` `requestDraw`) : le flag
  `frameScheduled` empeche les rafales d'appels (60+ mousemove/s sur
  un drag continu) d'enclencher 60+ callbacks rAF. Au plus 1
  `drawBoard()` par frame, peu importe le nombre de mutations
  sur la frame.
- **`sceneDirty` cache hit** (cf. `draw.js` `drawBoard`) : si rien
  n'a mute la scene stable depuis le dernier repeint offscreen,
  `drawBoard` saute `renderSceneToOffscreen()` et ne fait que blit +
  transient. Le flag n'est leve que par `invalidateScene()` ou
  `requestDraw()`.

**Instrumentation (HUD bas-gauche : `#fpsDisplay`)** :

Pour valider *que* ces mecanismes font leur travail, la metrique
exposee n'est PAS un compteur rAF/vsync (= 60 Hz en idle, peu importe
le travail reel) -- ce serait factuellement faux (un idle stable
produit 60 rAF/s mais 0 `drawBoard`, le vsync n'est pas un indicateur
de travail). On compte directement les **appels a `drawBoard`** via
deux compteurs module-level dans `draw.js` :

- `statsRedraws` (incremente inconditionnellement en tete de
  `drawBoard`) : nombre total de paints par seconde, toutes raisons
  confondues (= 1 max par frame grace a `frameScheduled`). Proche du
  vsync quand l'utilisateur drag/zoom, tombe a 0 en idle = preuve
  que le rAF coalescing fait son travail.
- `statsOffscreen` (incremente dans le bloc `if (sceneDirty)`) :
  nombre de re-renders offscreen. Doit rester << `statsRedraws` en
  pratique : un ratio proche de 1 signifierait que le cache de scene
  ne sert a rien (= regression a investiguer).

Le sampling est fait toutes les `FPS_DISPLAY_INTERVAL_MS = 250 ms`
(= 4 Hz) par la boucle rAF dans `viewport.js` (`fpsSampleLoop`) qui
appelle `consumeDrawStats()` (snapshot + reset des compteurs) puis
formate le texte `"X redraws/s (Y offscreen)"` via
`updateFpsDisplay(redraws, offscreen)`. Le polling ne tourne que
quand `state.fpsVisible === true` -- cout total en idle = 0 meme si
les compteurs restent toujours presents dans `draw.js` (cout
negligeable : deux `++` par paint, pas branche conditionnelle).

**Couts en idle** :

- Incrementation dans `drawBoard` : deux `++` (microscopique,
  inconditionnel).
- Sampling HUD : ~1 appel `consumeDrawStats` toutes les 250 ms quand
  visible ; zero sinon.
- DOM `textContent` : 1 mutation toutes les 250 ms, jamais par
  paint -- pas de thrash `×60/s`.

**Pas de seuil `data-perf` "warn"** : la metrique est volontairement
neutre, l'utilisateur parse lui-meme le chiffre (`X redraws/s`=
vitesse effective de paint, `(Y offscreen)`= cout scene-cache).
La regle CSS `#fpsDisplay[data-perf="warn"]` reste dormante dans
`main.html` -- reservee pour evolution future si on decide d'ajouter
un seuil (typ. warn si `offscreen/s >> redraw/s`, signal
d'invalidation de cache excessive a investiguer). Cf. `viewport.js`
`updateFpsDisplay` qui n'ecrit plus `data-perf` ; le markup HTML
garde `data-perf="good"` en dur.

Couts invariants : persistance `meshesDesigner.fpsVisible`, raccourci
`F`, bouton toolbar `#fps` -- inchanges (toggle stable, seul le
contenu textuel et la semantique evoluent).

#### §2.4.1 Compteur FPS discret (pilule toolbar, toujours visible)

Demande utilisateur : « un compteur discret de fps à afficher en haut à
gauche de l'écran ». Choix validés avec l'utilisateur : (1) **TOUJOURS
visible** — pas de toggle, pas de persistance ; (2) **pilule verte
read-only DANS la toolbar** (haut-gauche, même langage que `#shapeLabel` /
`#undoCount` / `#selectionCount`) ; (3) le HUD redraws/s bas-gauche reste
**inchangé** (toggle `F`) — les deux affichages coexistent car ils
répondent à deux questions différentes.

Le compteur (`#fpsCounter`) affiche le **vrai fps** (fréquence des
callbacks `requestAnimationFrame`), PAS le nombre de `drawBoard`
(§2.4) : c'est une mesure de **fluidité perçue** — le chiffre attendu
d'un « compteur de fps » —, pas de charge de rendu. La remarque §2.4
(« 60 rAF/s en idle = factuellement faux comme indicateur de travail »)
reste vraie pour le diagnostic redraws/s ; elle ne s'applique pas ici
car l'intention est exactement celle-là : montrer la fréquence
d'affichage de la session.

Mesure (viewport.js `startFpsCounter`) : delta entre callbacks rAF,
lissage exponentiel (`FPS_COUNTER_EMA = 0.1`, 1er échantillon à pleine
pondération — la pilule s'affiche dès la première frame), frames à
`dt > 1000 ms` sautées (onglet en arrière-plan / réveil machine — non
représentatives). DOM throttlé à 1 `textContent` toutes les
`FPS_COUNTER_DISPLAY_INTERVAL_MS = 500 ms` (jamais par frame, cf. §2.4
anti-thrash). Boucle permanente : coût en idle = 1 callback rAF/frame +
1 textContent/500 ms — négligeable, et le navigateur suspend
automatiquement rAF quand l'onglet est masqué.

**État ambre sous le seuil, avec hystérésis** : la pilule passe en
`data-perf="warn"` (texte + bordure ambre, fond teinté — même langage
visuel que la règle `#fpsDisplay[data-perf="warn"]`, historiquement
dormante, qui sert de référence de couleur) quand la fréquence lissée
descend sous `FPS_COUNTER_WARN_LOW = 42`, et revient en `"good"`
quand elle remonte au-dessus de `FPS_COUNTER_WARN_HIGH = 48`. Entre les
deux (bande morte de 6 fps), **l'état précédent est conservé**
(`fpsCounterPerf`, transitoire de session) — sans cette hystérésis, une
fréquence oscillant autour du seuil ferait clignoter la pilule verte ↔
ambre. L'attribut n'est écrit qu'au changement (pas de style recalc par
tick) ; la base verte de la pilule reste le défaut.

Masquage : la pilule vit dans le groupe « canvas ops » de la toolbar —
les règles `:has()` de `body.preview-mode` / `body.kiosk-mode` (§2.6.1)
la masquent donc avec le reste de la chrome, sans règle dédiée.

---

### §2.5 Optimiseurs de batch rendering (branch `feature/performance`)

Trois optimiseurs s'empilent sur le hot path de `renderSceneToOffscreen`,
complétés d'un safe-belt. Tous gardent la parité visuelle avec l'ancien
`drawTriangle` per-tri par défaut : aucun mesh réel ne regresse sur le
résultat, mais les meshes typiques (windings uniformes en canvas space,
grille à step raisonnable, plans avec peu de tris custom-color)
profitent du batching sans changement de comportement.

#### §2.5.1 Opt #1 — `drawPointsBatch` (groupement des vertex en un seul path-stroke)

Avant l'optim, pour N triangles, `drawShape` appelait 3N `drawPoint`,
chacun faisant `setLineDash([])` + `setStrokeStyle` + `beginPath()` +
`arc()` + `stroke()` = 5 API calls → 15N cycles pour le path-state machine.

`drawPointsBatch(points, radius, color)` (draw.js) :
- Une seule `setLineDash([])` + `setStrokeStyle` pour le batch.
- Un seul `beginPath()`.
- Pour chaque point : `moveTo(sp.x, sp.y)` + `arc(sp.x, sp.y, r, 0, TAU)`.
  `moveTo` explicite entre chaque arc car `arc()` NE reset PAS le `current
  point` du path après son tracé (spec Canvas 2D) — sans moveTo, le
  path tracerait une ligne parasite entre les centres consécutifs.
- Un seul `stroke()` final.

**Sub-path moveTo obligatoire** : spec Canvas 2D `CanvasPath::arc` dit
que si le `current point` du path n'est pas la position cible, le path
dessine implicitement une ligne du current point vers le start de
l'arc. Sans `moveTo` entre les arcs, chaque cercle du batch serait
relié au précédent par un segment = bug visible. Le `moveTo(sp.x, sp.y)`
avant chaque `arc` casse cette continuité et isole chaque cercle en
sous-path fermé ; le `stroke()` final trace tout en un seul appel GPU.

**Réduction mesurée attendue** : sur mesh-wail (33 pts, 36 tris ≈ 108
strokes de vertex) → 1 beginPath/stroke. Ratio ~50-100x sur la sous-op
vertex-stroke. Sous-effect quand le cache de scene reste valide (pas
de dirty offscreen) = gain nul. Sous-effect maximal pendant
drag/zoom/mutations sur gros meshes.

**Resolve des shared vertex** : un sommet partagé entre plusieurs
triangles (invariant Q1a : un sommet logique = une seule entrée
`pointList`) produit plusieurs refs identiques dans `vertexPoints` —
l'over-stroke d'un cercle de même couleur de même rayon au même
emplacement est visuellement identique à un stroke unique.

**Callers non-batchés** : `drawMouse` (cursor sur visible post-blit)
et `editor.js:updateMouseHover` (nearest point radius 5 vert) utilisent
toujours `drawPoint` direct car leurs cycles sont sur le visible
canvas APRÈS le blit offscreen → pas dans le scope de batch.

#### §2.5.2 Opt #2 — Grid LOD (skip sur step sub-pixel)

`drawGrid` itère N_x = ceil(width/step) verticales et N_y = ceil(height/step)
horizontales avant de stroke() le path global. À zoom 0.1 + GRID_STEP 32,
`step = 3.2 px` → `N_x + N_y ≈ 1200 lignes` traçées alors que les
lignes adjacentes fusionnent en bloc gris (aliasing per pixel) sans qu'un
pixel distinct ne soit visible. Solution : early-return si `step <
MIN_GRID_STEP_PX = 4` (constante module-level).

Borne basse seule (pas de borne haute) : à zoom ×10, `step = 320 px`,
le loop dessine 6-15 lignes par viewport — utile, pas de gain à
skipper. Pas d'invalidation de cache : si GRID_STEP ou zoomLevel
reviennent dans la plage visible, la prochaine
`renderSceneToOffscreen` repeint la grille normalement.

**Cas typique négligé** : viewport < 320 px sur mobile portrait avec
GRID_STEP=8 peut rester sub-4 px à zoom ×1 → grille se masque. UX
trade-off acceptable : l'utilisateur peut la désactiver via `G`.

#### §2.5.3 Opt #3 — Triangle fill+stroke batching (3 passes par shape)

Avant : pour N triangles de forme active, `drawTriangle` × N où chaque
appel = 1 beginPath + (closePath si complet) + (fill si complet+fill) +
1 stroke = jusqu'à 4N API calls en pure overhead.

Après (`drawShape` draw.js) :
1. **Resolved once** : `resolvedTris = [{p1, p2, p3, fill}]` itère
   `shape.tris` une seule fois en résolvant les indices `pointList[t.pX]`
   via lookup O(1) et en calculant `fill` canonique par shape-active.
   Single source of truth consommé par les 3 passes en aval.
2. **Fill pass** (active shape only, tris complètes only) :
   groupage par `fill` color via `Map<string, Array<r>>`. K groupes =
   K fill() (K = nombre de couleurs distinctes). Cas typique mesh-wail
   1 default-color = 1 fill() au lieu de N.
3. **Stroke pass** : `setLineDash` + `setStrokeStyle` une fois + 1
   beginPath couvrant TOUS les tris (completes + partiels) +
   `moveTo/lineTo/closePath` empilés en sub-paths + 1 stroke() final.
   `setLineDash`/`setStrokeStyle` fixés une fois pour toute la shape
   (mêmes pattern/color par `drawShape`).
4. **Vertex pass** : `drawPointsBatch` opt #1.

**Pourquoi fill et stroke sont scindés** : spec Canvas 2D applique
`fill()` sur TOUS les sub-paths formés depuis le dernier `beginPath()`.
Si on mettait plusieurs `fillStyle` dans un même beginPath (un par
couleur custom), le dernier `fill()` repeindrait la totalité avec la
dernière couleur (les précédents seraient perdus). Le fill DOIT donc
être un beginPath par groupe de couleur. Stroke en revanche :
`strokeStyle` peut transitionner dans un même path sans réinitialiser
les segments dessinés — d'où un seul beginPath pour le stroke pass
(gain maximal indépendant du nombre de groupes de couleurs).

#### §2.5.4 Safe-belt (détection windings inconsistantes)

L'opt #3 batching fill peut produire des **trous visibles** sous
`fillRule=nonzero` (default Canvas 2D) si plusieurs tris de même fill
ont des **windings inconsistantes** dans le même chemin. Cause
rarement anticipée : `modelToScreen` flippe Y (cf. §2.1), donc une tri
CCW en **model space** devient **CW en canvas space** et inversement.
Un fan de 4 tris "CCW en math" peut devenir en canvas space "1 CCW +
3 CW" (ex : `assets/mesh-overlap-test.json`, forme 3, après le Y-flip).
Sous `fillRule=nonzero`+batch fill, les contributions +1 et -1
s'annulent localement au voisinage du centre partagé → trou.

Le safe-belt implémente une détection O(N) par groupe de couleur :

1. Pre-calcul des screen coords (modelToScreen × 3 par tri) — évite
   de re-invoquer `modelToScreen` dans la passe rendering.
2. Loop de détection : cross product `(s2-s1) × (s3-s1)` en **screen
   space**. Si tous les cross products du groupe ont le même signe ET
   aucun n'est nul (tri dégénéré), `useBatchedFill = true`. Sinon
   (signes hétérogènes OU tri dégénéré) → `useBatchedFill = false`.
3. Bascule :
   - `useBatchedFill = true` → batched (1 beginPath + sub-paths + 1
     fill, gain opt #3 préservé).
   - `useBatchedFill = false` → per-tri fallback (1 beginPath + 1
     fill par tri, comportement équivalent à l'ancien `drawTriangle`,
     zéro interaction de winding possible entre sub-paths isolés).

**Coût du safe-belt** :
- Cas safe (mesh typique, windings uniformes en canvas space, ex:
  mesh-wail 33 pts) : 1 cross product par tri en screen space = O(N)
  micro-arithmétique par groupe, négligeable face au gain batching.
  `useBatchedFill = true` toujours. Aucune régression.
- Cas pathologique (windings mixtes en canvas space, fan importé
  avec doublons reversed dans le JSON, etc.) : per-tri = N beginPath +
  N fill cycles. Parité pixel-perfect avec l'ancien `drawTriangle`.

**Validation empirique** : test manuel sur `assets/mesh-overlap-test.json`
avec 4 plans (control + reverse-winding duplicate + fan avec 1 CW +
fan avec 3 CW). Le safe-belt pass→per-tri sur les 2 fansrend tous les plans pleins. Sans le safe-belt, fan 3 (CCW en math, 1 CW en
canvas) montrait un trou au centre — confirmé par observation dans
Chrome interactif.

**Cross-ref §2.1 (Y-flip)** : c'est précisément parce que `modelToScreen`
flippe Y (une inversion non triviale, math=CCW ↔ canvas=CW) que cette
détection est faite **en screen space**, pas en model space. Une
détection naïve en model space donnerait uniformement CCW pour les 4
tris du fan test → `useBatchedFill = true` → reprise du bug. Le
`modelToScreen` invariant (§2.1) doit être respecté par tous les
calculs de winding dans `draw.js`.

#### §2.5.5 Mesure et instrumentation

Outils disponibles sans modif UI :

- `state.debugRenderTime = true` (toggleable depuis la console
  navigateur, désactivé par défaut, gate `console.time('renderScene')`
  dans `renderSceneToOffscreen` — cf. draw.js). Une fois activé,
  Chrome devtools Console agrège min/max/avg/x sur le label
  `renderScene`.
- `#fpsDisplay` ON (toolbar bouton `#fps` ou raccourci `F`). Affiche
  `X redraws/s (Y offscreen)`. Avec le safe-belt, le batched path
  reste actif sur mesh typique — gain opt #3 visible comme baisse
  du temps moyen par offscreen repaint.
- Console overlay (`#messageBoard`) : `log(...)` emissions des paths
  de mutation (add/undo/grab) — utile pour event-order, pas pour perf.

**Protocole de capture** :

1. Charger `assets/mesh-wail.json` (33 pts, 36 tris, case typique
   windings uniformes dans la convention naturelle de mesh-wail).
2. Toggle `#fpsDisplay` ON et bastion navigateur ouvert.
3. Activer `state.debugRenderTime = true` dans devtools Console.
4. Effectuer 60+ drag-uniformes (e.g., drag d'un sommet du mesh dans
   une amplitude fixée) — laisser Chrome devtools Console agréger.
5. Noter dans le tableau de bord :
   - `renderScene: Xms` moyenne (opt #1, #2 actifs).
   - Comparer avec mesurable du même drag sur le même mesh après
     `git stash` des optimiseurs.

Note : les counts `redraws/s` + `offscreen/s` du `#fpsDisplay` ne
changent PAS en valeur absolue entre avant/après opt (mêmes triggers
d'invalidation). Seule la `renderScene: Xms` moyenne chute. C'est
attendu et correct.

#### §2.5.6 Anti-régression checklist

- [ ] mesh-wail rendu pixel-perfect (aucun trou, aucun décalage).
- [ ] alphabet2 / complexe-shape (assets fournis) ne regressent pas.
- [ ] `assets/mesh-overlap-test.json` : 4 plans tous pleins après
      safe-belt (mixte windings en canvas → fallback per-tri).
- [ ] Rotation AltGr + drag continu (`§6.1`) : pas de stutter visible
      au path batched.
- [ ] Lasso (`renderTransient`) : `selectionBox` rendu inchangé
      (post-blit, hors scope batched).
- [ ] Hover (`editor.js:updateMouseHover`) : `drawPoint` radius 5
      vert sur le nearest continue de fonctionner (chemin non
      batched, sur visible post-blit).

---

### §2.6 Preview — mode visualisation seule (bouton œil, cycle en 3 états)

Un mode de **focus transitoire** qui réduit l'écran à la géométrie de la
scène : points de contrôle, axes, grille, HUD et boutons sont masqués pour
visualiser le maillage « tel quel » (triangles, lignes, fills custom),
comme on verrait une capture du résultat final. Spec utilisateur :
« visualiser la scène sans les points de contrôle ni les axes ni le HUD
ni les boutons ».

**Cycle en 3 états (évolution bouton prévisualiser)** : le bouton `#preview`
et la touche `P` font tourner un cycle `off → preview simple → plans → off` :

1. **preview simple** (1er clic) — comportement historique : la scène est
   visualisée « telle quelle » (plan actif rempli, autres en contours
   atténués), chrome masquée.
2. **plans** (2e clic) — TOUS les plans sont rendus remplis
   dans l'ORDRE du tableau : le plan d'indice le plus haut recouvre
   les précédents là où ils se chevauchent. Cette vue fait apparaître la composition en plans
   (stacking) de la scène. `state.previewPlans` (state.js) est le
   sous-état qui distingue les deux vues — même chrome masquée, même
   non-persistance.
3. **off** (3e clic) — sortie.

Les sorties **directes** (Échap, clic gauche sur le canvas, `Ctrl+S`)
quittent les deux états d'un coup via `exitPreview` (viewport.js) — elles
n'avancent PAS le cycle (sinon le clic de sortie afficherait les plans au
lieu de quitter). Pour que le 2e/3e clic du bouton soient possibles, la
toolbar est réduite en preview au seul bouton œil flottant (cf. §2.6.1).

#### §2.6.1 Délimitation : chrome masquée vs contenu canvas

Le mode agit sur DEUX plans complémentaires :

1. **Chrome DOM** — la classe `body.preview-mode` posée par
   `applyPreviewMode` (viewport.js) active des règles CSS (main.html) qui
   passent en `display: none !important` : la console (`#messageBoard`),
   le HUD bas-gauche (`#coords`, `#zoomDisplay`, `#fpsDisplay`),
   `#sceneStatus`, le panneau de couleur (`#triangleColorPanel`) et les
   modales (`.modal`). La toolbar, elle, est RÉDUITE à son seul bouton
   `#preview` (l'œil) : le fond/cadre de la card disparaît et tous les
   autres éléments sont masqués (règles `:has()` sur `.toolbar-group`) —
   c'est la condition pour que le CYCLE au clic (`off → preview → plans →
   off`) reste pilotable à la souris depuis l'intérieur du mode. Le
   `!important` est obligatoire pour surpasser le
   `#messageBoard.style.display` inline posé par `updateConsoleButton`
   (hud.js) et l'attribut `hidden` du `#fpsDisplay`. Le curseur du canvas
   passe en `grab` (indice de pan) via
   `body.preview-mode #board { cursor: grab !important }` — nécessaire
   parce que `#board` porte un `cursor: 'none'` inline posé en JS (haute
   priorité), même pattern que `body.dragging-console`.
2. **Contenu canvas** — gardes `state.previewMode` dans `draw.js` :
   - `renderSceneToOffscreen` : saute `drawGrid`, `drawAxis` et
     `drawSelectedPoints` — la scène stable (§2.4) se réduit à
     `drawShapes`.
   - `drawShapes` : en plans (`state.previewPlans`), TOUS les plans
     sont dessinés en `isActive=true` dans l'ordre du tableau — chaque
     plan est rendu rempli (fills conservés), le dernier recouvre les
     précédents là où ils se chevauchent. En preview simple,
     comportement historique (plan actif rempli, autres en contours
     atténués).
   - `drawShape` (pass vertex) : saute `drawPointsBatch` — les points de
     contrôle (disques des sommets) disparaissent.
   - `renderTransient` : early-return — réticule et selectionBox (lasso)
     ne sont plus peints.
   - `updateMouseHover` (editor.js) : early-return — plus d'overlays de
     survol (cercle vert du nearest, labels §7.8/§7.9, highlights ligne /
     triangle) ni de `drawMouse`.

`state.previewMode` (state.js, défaut `false`) est la source de vérité du
mode, lue par la couche DOM (viewport.js), le rendu (draw.js) ET les
gardes d'interaction (main.js). `state.previewPlans` (défaut `false`) est
son sous-état : il ne vaut que si `previewMode` est vrai et ne change que
le rendu de `drawShapes` (la chrome est masquée dans les deux états).

#### §2.6.2 Contrat d'interaction : navigation seule, édition impossible

Choix validé avec l'utilisateur : la preview conserve la navigation mais
ne permet AUCUNE mutation de la scène.

| Geste | En preview |
|---|---|
| **Molette** | **Toujours zoom** — les deux chemins de rotation sont bloqués : `onBoardWheel` (viewport.js) gate la rotation AltGr (`§6`) et `canRotate` avec `!state.previewMode`. Sans cette garde, une sélection non vide (masquée mais toujours présente dans l'état) ferait pivoter la géométrie au lieu de zoomer — mutation invisible interdite. |
| **Clic milieu + drag** | Pan, inchangé — seul geste souris autorisé (`e.button === 1`). |
| **Clic gauche** | **Sort du mode** — sortie DIRECTE (des deux états, preview simple et plans) : le clic est avalé : le mousedown quitte la preview AVANT de poser la selectionBox, donc pas de lasso / sélection / `addPoint` sur le coup qui quitte. |
| **Clic droit** | Ignoré — pas de grab, et `processRightClickSelection` gate par `!state.previewMode` sur le mouseup. |
| **`Backspace` / `⇧+Backspace`** | Ignorés (suppression = mutation). |
| **`Ctrl+Z` / `Ctrl+⇧+Z` / `Ctrl+Y`** | Ignorés (undo/redo muteraient une scène invisible à l'écran). |
| **`Ctrl+S`, `Ctrl+0`** | Conservés (export + reset zoom : non-mutants de la géométrie). |
| **`G` / `R` / `F`** | Conservés mais sans effet visible (grille / axes / réticule masqués par le mode ; l'état revient tel quel à la sortie). |
| **`P`** | Fait tourner le **cycle** : off → preview simple → plans → off (comme le bouton `#preview`). |
| **`Échap`** | **Sortie directe** — quitte la preview (simple OU plans) d'un coup (`exitPreview`), priorité absolue sur la fermeture de modale dans le keydown handler. |

**Filet anti-grab** : `togglePreview` ET `exitPreview` retournent tôt si
`grabbed()` (`ACTION_GRABBING` en cours). Sans ce garde, P/Échap pendant
un clic-droit + drag entrerait en preview alors que
`resolveMouseMoveOnBoard` continuerait de muter la scène jusqu'au
mouseup. Le bouton toolbar est inatteignable pendant un drag (souris
occupée sur le canvas) — le clavier est la seule voie d'entrée, d'où la
garde partagée côté `togglePreview` (P, cycle) / `exitPreview` (Échap et
le clic gauche de sortie).

À l'entrée, `applyPreviewMode` nettoie aussi les gestes en cours
(`isSelectingBox`, hover state) pour ne rien laisser transiter d'un mode
à l'autre.

#### §2.6.3 Invalidation du cache offscreen

Le mode change la SCENE STABLE (§2.4) : grille, axes et points de
contrôle sont des éléments du rendu offscreen, pas du transitoire.
`applyPreviewMode` appelle donc `requestDraw()` (= `sceneDirty = true`),
jamais un simple blit — un toggle sans invalidation laisserait l'offscreen
précédent affiché. Le `requestDraw` est rAF-coalescé : un toggle on/off
rapide dans la même frame rend l'état final, pas un flicker intermédiaire.

#### §2.6.4 Non-persistance localStorage (décision)

À la différence des toggles de préférences (grille, réticule, FPS,
console — persistés via leurs clés `meshesDesigner.*`), la preview n'est
PAS persistée — ni l'état simple ni l'état plans (`previewMode` /
`previewPlans`). Un reload en preview laisserait l'utilisateur sans
boutons (la toolbar est réduite au seul bouton œil) — seule la sortie
clavier (P / Échap) resterait disponible, et l'état d'édition par défaut
au boot est plus sûr. La preview est un état de **focus passager**, pas
une préférence de vue.

#### §2.6.5 Points d'entrée / sortie

- Bouton toolbar `#preview` (groupe « Canvas ops », icône œil, cycle en 3
  états : état actif `.preview-active` vert — même langage que
  `#fps.fps-active` — et sous-état `.preview-plans` ambre avec ring inset
  + libellé « plans », cf. `updatePreviewButton` dans viewport.js).
- Raccourci clavier `P` (gate `!e.repeat` : maintenir P ne doit pas faire
  clignoter toute la chrome on/off — impact visuel bien plus lourd que
  G/R/F) — même cycle que le bouton.
- **Sortie directe** (des deux états) : `Échap` — **priorité absolue** sur
  la fermeture de modale dans le keydown handler (la chrome étant masquée,
  un modal ouvert n'a pas de sens à l'écran) —, clic gauche sur le canvas
  (clic avalé, cf. §2.6.2) et `Ctrl+S` (`openSaveModal` sort d'abord via
  `exitPreview` pour que la fenêtre d'enregistrement soit visible).

Anti-régression : à la sortie, le `requestDraw` du toggle re-rend
l'offscreen avec grille / axes / points restaurés ; `updateMouseHover`
reprend ses overlays dès le prochain mousemove (la signature de hover est
recalculée, et le `sceneDirty` posé par le toggle empêche le skip de
frame du cache de signature).

---

### §2.7 Resize du navigateur : resync du bitmap sans stretch

Le canvas `#board` est dimensionné en CSS à `99vw × 99vh` (boot,
main.js) mais son **bitmap interne** (attributs `width`/`height`, la
vraie résolution de dessin) était figé une seule fois au boot. Sans
handler de resize, le navigateur **étire** le bitmap fixe pour remplir
la nouvelle boîte CSS après un redimensionnement de fenêtre — géométrie
distordue (cercles ovalisés, grille non carrée, distances fausses à
l'écran).

`resizeCanvasToFitBrowser` (main.js, listener
`window.addEventListener('resize', …)`) resynchronise le bitmap sur la
taille CSS réelle à chaque resize puis repeint :

1. **Resync bitmap** : `state.board.width/height =
   Math.round(rect.width × dpr)` — pixels **physiques** (CSS ×
   `devicePixelRatio`), voir convention HiDPI ci-dessous. La garde
   `w === state.board.width && h === state.board.height` évite de
   resetter le bitmap (opération qui **efface la surface canvas**) pour
   un événement resize sans changement effectif de taille — les
   navigateurs en émettent pour d'autres raisons (zoom navigateur,
   apparition de scrollbars, …). Le `dpr` est relu à chaque événement :
   un passage de fenêtre entre deux écrans de densités différentes
   change le bitmap sans que la taille CSS bouge (le guard passe
   alors). La comparaison se fait sur la valeur arrondie : l'attribut
   canvas est un entier, `getBoundingClientRect()` renvoie un float.
   **Garde double** : le handler compare aussi le centre dérivé du CSS
   (`rect.width/2`). Cas tordu couvert : fenêtre draguée entre deux
   écrans de densités différentes avec taille CSS qui change et taille
   physique qui coïnciderait (`cssW × dpr` identique) — le centre CSS
   changerait sans que `w/h` bougent, le recentrage serait alors
   indispensable.
2. **Recentrage de `center`** : `state.ctx.center = (rect.width/2,
   rect.height/2)` — même règle qu'au boot, **en pixels CSS** (jamais
   en pixels bitmap). Préserve l'invariant **« `viewCenter` = le point
   modèle affiché au centre de l'écran »**, sur lequel s'appuient les
   maths de zoom/pan (viewport.js `zoomCenteredOnCursor`, `updatePan`)
   et la projection `modelToScreen`/`screenToModel` (geometry.js).
   **Artefact accepté** : un geste en cours (grab/lasso) au moment du
   resize voit les points engagés « sauter » par rapport au curseur —
   les coordonnées d'interaction passent par `modelToScreen`/
   `screenToModel` qui dépendent de `center`. Rare et transitoire,
   inhérent à tout recentrage (l'alternative — garder `center` fixe —
   casserait l'invariant et désancrerait la grille/les axes de
   l'origine modèle, cf. §2.2).
3. **Repaint** : `requestDraw()` suffit (rAF-coalescé, cf. §2.4) — il
   invalide la scène offscreen et `syncOffscreenSize` (draw.js)
   resynchronise la taille du cache sur le nouveau bitmap au prochain
   `drawBoard`.

**Non-persisté** : `center` est une donnée **dérivée** de la taille du
canvas (jamais sérialisée, pas de clé `meshesDesigner.*`) — pas de
`persistState()` dans le handler. La scène (zoom, `viewCenter`) reste
inchangée par un resize ; seuls le bitmap et l'origine pixel bougent.

### §2.7.1 Convention HiDPI : bitmap physique, coords internes en CSS px

Le bitmap du canvas est dimensionné en **pixels physiques** (`board.width
= round(cssW × dpr)`) pour un rendu net sur écrans HiDPI, mais **toutes
les coordonnées internes restent en pixels CSS** : positions souris
(`e.x - rect.x`), `state.ctx.center`, `modelToScreen`/`screenToModel`,
rayons de hit-testing (§1.4 — `POINT_HIT_RADIUS_PX` etc. restent des
CSS px, la tolérance de clic ne dépend pas du dpr), bornes grille/axes/
rététicule. La conversion CSS → physique se fait aux deux seules
frontières :

1. **Sizing du bitmap** (main.js boot + `resizeCanvasToFitBrowser`) :
   `board.width = round(rect.width × dpr)`.
2. **Transform canvas** (draw.js `applyDprTransform`) :
   `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` posée en tête de
   `drawBoard` sur le visible (invariant : elle n'est **jamais
   retirée** — les overlays d'editor.js, hover + `drawMouse`,
   dessinent sur `state._ctx` après `drawBoard` et s'appuient sur cette
   transform active) et dans `renderSceneToOffscreen` sur l'offscreen.
   Le blit du cache se fait en 9-args
   (`drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0,
   cssBoardW(), cssBoardH())`) : le cache est en pixels physiques, la
   boîte de destination en CSS px — la transform dpr le rétablit en
   1:1 physique, aucun upscale ni downscale.

Les lectures de `state.board.width/height` dans draw.js (grille,
axes, rététicule) passent par les helpers `cssBoardW()/cssBoardH()`
(= bitmap ÷ dpr) : le bitmap est physique, le dessin est en CSS px. Le
réticule / la sélectionBox / les labels restent donc géométriquement
identiques en CSS px quel que soit l'écran, avec un trait net (1 CSS px =
`dpr` pixels physiques).

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
| **vertex**  | Point le + proche dans un rayon de `POINT_HIT_RADIUS_PX` pixels écran | Ensemble des indices `pointList[*]` partageant ce coord (cluster §3.2) |
| **segment** | Edge (projection orthogonale entre 2 sommets), dans `LINE_HIT_RADIUS_PX` pixels | Tous les points dans les 2 endpoints via `collectUnderlyingPoints` |
| **triangle**| Hit `pointInTriangle` (inclusif sur edge) + tolérance centroïde de `TRIANGLE_CENTROID_HIT_RADIUS_PX` pixels | 3 sommets du triangle hovered |

### §3.3 Hiérarchie de hit pour `findNearestTriangle`

**Priorité absolue** : un triangle contenant STRICTEMENT le curseur bat un
near-centroid. Sans cette règle, un petit triangle T_near dont le centroïde est
à 5 unités pourrait supplanter un grand T_inside dont le centroïde est à 200
unités — alors que l'utilisateur a cliqué DANS T_inside.

Au sein d'une même priorité (inside-inside ou near-near), **centroïde le plus
proche gagne** (utile pour triangles voisins ou overlapping).

### §3.4 Tolérance centroïde (`TRIANGLE_CENTROID_HIT_RADIUS_PX = 20`)

Confort UX : un clic à 1-2 px d'une edge (snap, perception humaine) doit
quand même sélectionner le triangle élargi. Cette tolérance, comme les
rayons vertex et segment, est exprimée en pixels écran puis convertie en
unités modèle selon le zoom.

### §3.5 Test point-in-triangle

Via le signe du cross-product 2D `(b-a) × (c-a)` : `> 0` si p à gauche du
vecteur `a→b` (maths), `< 0` si à droite, `= 0` si colinéaire. Pour tolérer
l'orientation du triangle, on accepte le signe partagé (tous mêmes signes ou
zeros). `pointInsideTriangle` est **inclusif sur les edges** (cas
floating-point où un des `d1/d2/d3` peut être 0).

### §3.6 Modificateurs de clic (Shift / Ctrl / Cmd / rien)

Les gestes sont séparés par bouton pour éviter toute ambiguïté entre
sélection et déplacement :

| Geste | Effet |
|---|---|
| **Clic gauche** sur une entité | Remplace la sélection (ou toggle avec Shift) |
| **Clic gauche + drag** | Délimite uniquement le lasso ; ne déplace jamais la géométrie |
| **Ctrl/Cmd + clic droit** sur une entité | Ajoute la sélection sans toggle et sans déplacer la géométrie |
| **Clic droit + drag** | Déplace la sélection existante, depuis n'importe quel point du canvas |

Le clic droit Ctrl/Cmd est traité comme une action de sélection immédiate,
avant l'initialisation du grab. Il ne crée donc aucune entrée d'historique,
ne mute aucune coordonnée et ne peut pas déplacer accidentellement la sélection.
En mode `triangle`, l'index du triangle est ajouté de façon idempotente dans
`selectedTriangles`; en mode `segment`, les points des deux endpoints sont
ajoutés. En mode `vertex`, l'ensemble des indices `pointList[*]` partageant ce
coord (cluster §3.2) est ajouté sans doublon.

Implémentation : `processMouseUpSelection` reçoit uniquement le geste gauche
et neutralise Ctrl/Cmd pour les appels de sélection ; le geste
`Ctrl/Cmd + clic droit` passe par `selectAtRightClick` dans `editor.js`, puis
`beginGrabbing` retourne immédiatement sans armer `ACTION_GRABBING`.

Le helper `applySelectionModifiers(pointsAtPos, e, ctrlToggles)` reste la
source commune des règles Shift / ajout idempotent. Le Shift gauche conserve
le toggle de sélection ; le Ctrl/Cmd gauche n'est plus un geste d'ajout.
Sur espace vide, le clic gauche en mode `edition` crée un point (snap
éventuel à la grille) ; le clic droit simple efface la sélection s'il ne
trouve aucune entité sous le pointeur.

Le clic droit sans Ctrl/Cmd conserve son contrat de déplacement : avec une
sélection existante, il la déplace depuis la position de départ ; sans
sélection, il peut sélectionner l'entité sous le pointeur et armer son grab.
AltGr est exclu du Ctrl/Cmd de sélection : le chemin AltGr + clic droit reste
le déplacement de tous les plans.

**Cohérence `selectedTriangles` ↔ `selectedPoints`** : la branche shift de
`applyGrabTriangleSync` ne pousse un index `i` dans
`state.selectedTriangles` que si les 3 sommets de `tris[i]` sont
effectivement en sélection *après* le toggle de `applySelectionModifiers`.
Sinon, le toggle retire les sommets de `selectedPoints` mais l'index
demeurerait dans `selectedTriangles` — incohérence entre le surlignage
des sommets (perdu) et le fill vert du triangle (perpétué). Cette garde est
indispensable depuis que `hasModifier` ouvre le chemin « clic-droit + shift
+ triangle dont les 3 sommets sont déjà sélectionnés » (que
`preserveExisting=true` masquait avant).

### §3.6.1 Clic-droit propre vs clic-droit-drag : parité sparse-replace WYSIWYG

Le clic-droit propre (sans drag) suit la table §3.6 Plain-click — il
remplace la sélection. Le clic-droit-drag suit historiquement une
règle divergente — « drag depuis n'importe quel point du canvas déplace
la sélection engagée » — qui **préserve** la sélection même quand le
mousedown vise une autre entité. Cette divergence est piégeuse : selon
qu'un drag fasse 2 px ou 50 px, la sélection survit ou est écrasée. La
règle suivante unifie les deux gestes pour le cas sparse :

| Sélection actuelle  | Clic-droit propre (sans drag)         | Clic-droit + drag (mousedown + 5+ px) |
|---|---|---|
| **0 élément**       | `selectedPoints = [under-cursor]`     | `selectedPoints = [under-cursor]` puis drag (idem clic propre) |
| **1 élément**       | Plain-click replace → `[under-cursor]` | §3.6.1 sparse-replace → `[under-cursor]` puis drag (parité stricte) |
| **≥ 2 éléments**    | Plain-click replace → toute la sélection groupée perdue | PRÉSERVÉ (filet défensif — drag déplace le groupe engagé depuis n'importe où) |

> **Note (extension mode-aware post-refactor §3.6)** : « 1 élément
> logique » désigne désormais l'entité engagée selon `state.selectionMode`,
> via `isSelectionSparse()` dans `beginGrabbing` (editor.js). **vertex**
> = cluster physique (tol 0.01 §3.2, byte-équivalent à l'ancien
> `isSingleCluster`). **segment** = ≤ 1 edge couverte par
> `selectedPoints`, dédup par paire non ordonnée `(min, max)` pour
> éviter qu'une edge partagée entre plusieurs triangles soit comptée
> N fois (regression validée : clic sur edge AB partagé entre T1/T2
> retournait couvert=2 au lieu de 1 sans la dédup). **triangle** =
> ≤ 1 triangle dont les 3 slots sont dans `selectedPoints` (pas de
> dédup — un sommet partagé par N triangles reste N triangles dans
> ce mode, sinon on sur-compterait). Maintient invariants **I1**
> (défense `Number.isInteger` sur chaque slot avant lookup) et **I3**
> (pointList dédupliqué par coord → comptage sans paires fantômes).

Implémentation : `beginGrabbing` insère une **pre-branch §3.6.1** juste
avant l'early branch « selectedPoints.length > 0 grab-from-selection ».
Cette pre-branch ne déclenche un replace QUE si les trois conditions
suivantes sont réunies :

1. `isSelectionSparse()` retourne `true` (gate mode-aware couvrant
   les 3 modes via cluster / dédup edge-pair / exact-3-slot ; voir
   bloc détaillé ci-dessus). Le 0-tuple est capturé par le
   fall-through de `beginGrabbing` via `applySelectionModifiers` ; le
   1-tuple (cluster / 1 edge / 1 triangle) est traité ici.
2. Le curseur vise une entité (mode-aware : `findNearestTriangle` >
   `findSelectedLine` > `findNearestPoint`, chacun avec sa
   tolérance hit-radius en pixels écran).
3. Cette entité n'est PAS déjà intégralement dans `state.selectedPoints`
   (`!cursorGrabPoints.every(p => isPointSelected(p))`) — sans cette
   garde, un drag à 1 px du point engagé re-replace flickerait la
   sélection (anti-flicker).

Le replace passe par `applySelectionModifiers(... ctrlKey=false metaKey=false)`
qui ré-utilise exactement le même chemin que le clic-droit propre — donc
parité stricte click/drag sur la sémantique de remplacement. Pour les
modes `triangle` et `segment`, `applyGrabTriangleSync` est appelé
après le replace pour réconcilier `selectedTriangles` ↔
`selectedPoints` (sa propre garde « ne push un index que si les 3
sommets sont en sélection post-toggle » assure la cohérence, cf. §3.6).

Les modifiers Shift/Ctrl/Cmd restent indépendants de §3.6.1 :
`hasCtrlSelectionModifier` court-circuite bien avant dans
`beginGrabbing` (Ctrl/Cmd + clic-droit = `selectAtRightClick`
additif et retour sans grab), donc la pre-branch §3.6.1 ne concerne
que le clic-droit SEUL sans modifier. `e.shiftKey` est transmis
tel quel à `applySelectionModifiers` mais n'a aucun effet ici
puisque le replace passe la branche « else » (`!shiftKey &&
!ctrlKey && !metaKey`) — Shift ne toggle pas à ce niveau.

La pre-branch ne fait pas `saveState()` : un mousedown qui ne
démenche aucun mouvement (drag-distance < 5 px selon `hasDragged`
dans `resolveMouseMoveOnBoard`) ne pollue pas l'historique. Pour
un drag qui bouge, `resolveMouseMoveOnBoard` appelle
`saveState()` au premier tick significatif via le flag
`state.grabHistorySaved` — donc l'undo couvre bien le déplacement
final post-replace (l'état pré-drag, qui inclut ou non l'ancien
point sélectionné selon le cas, est dans la pile).

---

## §4. Règles de suppression (touche Backspace, par mode)

### §4.1 Règle par mode

- **vertex** (`deleteSelectedPoint`) : supprime l'**indice** `idx` du
  pointList du plan actif des slots `tris.pX` des triangles qui le
  référencent (les slots deviennent `undefined`). Les triangles dont il
  reste < 2 slots définis sont filtrés. Les **segments incidents** à P
  disparaissent (l'un de leurs endpoints n'existe plus) ; le **segment
  OPPOSÉ** du triangle survit si ses 2 autres sommets existent.
- **segment** (`deleteSelectedSegment`) : supprime TOUS les triangles dont
  **≥ 2 slots** matchent les indices des endpoints du segment.
  Les triangles dont 0-1 slot match survivent (leurs autres slots
  conservent leur indice vers `pointList`).
- **triangle** (`deleteSelectedTriangle`) : supprime UNIQUEMENT les triangles
  dont les **3 slots** matchent les indices des sommets du/des triangles
  sélectionnées. Distinction stricte avec le mode segment : `matchCount === 3`
  ici (vs `>= 2`) car "uniquement les triangles sélectionnés" — pas ceux qui
  partagent un sommet ou un edge.

**Compactage immédiat (Q2a spec §modify-shape-model-spec.md §2a)** : après
chaque `delete*`, `compactPointList` (editor.js) retire les entrées
`pointList[*]` non référencées par aucun slot survivant ET ré-indexe
les `tris.pX` restants via une map `oldIdx → newIdx` (le décalage est
soustrait pour les `oldIdx > deletedIdx`). L'invariant runtime **I2**
(§spec §5) reste garanti en O(N) sans orphelins (zombies). `state.selectedPoints`
est aussi mis à jour via la même map : les indices sélectionnés restants
sont remappés pour pointer sur le même sommet logique post-compactage.

### §4.2 Anti-régression doublure (toutes les `delete*`)

- `saveState()` en tête (rend l'opération annulable via undo — la pile
  contient l'état avant suppression, pas après).
- `reset selection + hover + draw + HUD + persist` en queue.
- No-op silencieux si cibles vide (rien ne se passe sans sélection NI cible
  fallback selon le mode).

### §4.3 Refresh `nearestLine` au point de clic dans `addPoint`

`resolveMouseClickOnBoard()` recalcule `state.nearestLine` au moment du clic
(et non depuis une valeur cachée par `updateMouseHover` au dernier mousemove).
Sans ça, un nouveau triangle pouvait être créé sur une edge qui n'est plus
sous le curseur (cas souris immobile, déplacement rapide, ou clic sans
mousemove intermédiaire).

Quand le dernier triangle est partiel (`p1`/`p2` sans `p3`), une ligne valide
calculée pour le clic courant est prioritaire : `addPoint()` crée alors un
nouveau triangle sur ce segment, au lieu de réutiliser le triangle partiel.
Cette règle est nécessaire après la suppression d'un point, qui conserve le
segment opposé sous forme partielle pour préserver la géométrie visible ; ce
reliquat ne doit pas être interprété comme la construction active suivante.
En l'absence de segment détecté, un triangle partiel réellement en cours de
construction peut encore être complété.

`state.nearestPoint` n'est PAS re-touché dans `addPoint` — sa propre mise à
jour suit son cycle de hover et n'est pas consommée par l'ajout.

---

### §4.4 Anti-leak des triangles partiels au reload

`resolveTrisToTriangles` (dans `io.js`, frontière d'hydratation appelée
par `loadState` ET `applyImport`) filtre les triangles incomplets — sans
`p3`, ou sans l'un des `p1`/`p2`/`p3`. Symétriquement, `shapeToMesh`
(`io.js`) filtre aussi à la sérialisation pour qu'un triangle partiel
n'occupe pas de slots vides dans `localStorage` (defense in depth —
DevTools ne voit plus de triangles fantômes).

Sans ces filtres, un triangle en cours de dessin au moment du reload
(l'utilisateur a posé `p1` et `p2`, mais pas encore `p3`) survit intact
dans le scene réhydraté, et le premier clic après restart le **complète**
via la branche `addPoint` « partial fill » :
`else if (triangle.p3 === undefined) triangle.p3 = point`. Cette branche
bypasse entièrement le recalcul de `state.nearestLine` (cf. §4.3) — le
triangle ainsi formé utilise l'arête `p1-p2` laissée en plan avant
restart comme base, perçue à tort comme « le dernier segment utilisé
avant redémarrage » au lieu du segment le plus proche du clic.

La règle : **un triangle doit avoir ses 3 sommets pour franchir la
frontière d'io**, que ce soit par reload ou par import — et symétriquement
pour ne pas polluer la sortie.

---

## §4.5 Contrat JSON versionné et validation

Les exports portent `format: "meshes-designer"` et `version: 1`. Les imports
acceptent les anciens fichiers sans ces champs, mais refusent un format inconnu,
une version future, des coordonnées non numériques et des indices hors limites.
Le modal d'import affiche la scène avant de donner le focus à son bouton primaire ;
Échap et le clic sur le backdrop annulent en restaurant le focus précédent.
La scène n’est pas modifiée lorsque la validation échoue. Le statut HUD
`#sceneStatus` indique `modifiée` après une mutation de géométrie, de plan ou de
couleur et `sauvegardée` après export ou restauration. Les changements de vue
(zoom, pan, grille) sont persistés mais ne marquent pas la scène comme modifiée.

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

### §5.3 Invariants runtime du modèle {pointList, tris}

Le runtime `state.shapes[i] = { pointList, tris }` (Phase 1) doit
vérifier en permanence les invariants suivants sur chaque plan.
Voir `modifyShapeModel-spec.md` §A pour la définition complète des
catégories d'erreur (`out_of_bounds`, `orphan`, `duplication`,
`partial_inverted`, `fill_not_string`). Les invariants ci-dessous
sont enforced en soft-mode (log-only, jamais bloquant) par le helper
dev `validateShape(shape)` de `io.js` (wire dans `persistState` et
`loadState`), et détectés defensivement par les helpers de rendu
(`drawShape`, `drawSelectedPoints`) lorsque la donnée est corrompue
à l'entrée (reload localStorage legacy, import externe, etc.).

| Invariant | Énoncé | Enforced par |
|---|---|---|
| **I1** — _out_of_bounds_ | Tout `tris[k].pX` est un entier dans `[0, pointList.length)`. Pas de NaN, string, float, ou index négatif. | `validateShape` (log); `shapeToMesh` (filtre), `drawTriangle` (Number.isInteger gate) |
| **I2** — _orphelin_ | Toute entrée `pointList[idx]` est référencée par au moins un `tris[k].pX` d'idx. Pas de slot fantôme. | `validateShape` (log); Q2a compactage immédiat post-merge/delete (cf. §4.1) |
| **I3** — _dedup_ | Au plus une entrée `pointList[*]` par coordonnée flottante (au sens §3.2 tolérance 0.01). Deux sommets à la même position = une seule entrée, N slots triangle si N triangles. | `validateShape` (log, O(N²)); `addPoint` (ignore voisins `≤ 1 px`); `mergeSelectedPoints` (compactage immediat) |
| **I4** — _schema_ | `shape` est un object avec `Array.isArray(pointList) && Array.isArray(tris)`. Pas de table `triangles` legacy en runtime (chemin legacy toléré dans `shapeToMesh` sortie uniquement, Q3b back-compat). | `validateShape` (`shape_missing`, `pointList_missing`, `tris_missing`) |
| **I5** — _partial_inverted_ | Un triangle partiel valide (`p3 === undefined`) conserve toujours `p1` et `p2` définis. Pas de `p1` undefined si `p2` ou `p3` sont presents (forme dégénérée). | `validateShape` (log); `shapeToMesh` (filtre `if (t.p1 === undefined …)`) |
| **I6** — _fill type_ | Tout `tris[k].fill` est soit absent, soit une string non-vide. Pas de `null`, nombre, ou objet. Anti-leak symétrique à I5 sur la sérialisation. | `validateShape` (log); `shapeToMesh` (`if (typeof t.fill === 'string' && t.fill.length > 0) nt.fill = t.fill`) |
| **I7** — _indice continuité_ | Après delete+compactage (§4.1 + Q2a), les indices `pX` referencent des slots contigus `[0..N)` sans saut. Pas de hole dans la séquence après une suppression. | _Implicite_ : delete+compactage immediat (cf. §4.1) — l'invariant est garanti par construction, pas testé par `validateShape` directement |
| **I8** — _fill opacité cohérente_ | `fill` parsé en `rgba(r,g,b,a)` avec `a ∈ [0,1]`. Pas d'alpha négatif ou `> 1`. | _Observé_ : le panneau `triangleColor` (§7.3) contraint l'opacité à 45% par défaut — pas de test runtime dédié |

**Corrélation I1 ↔ I2 ↔ I3** : l'invariant I3 (au plus une entrée par
coord) combiné avec I2 (toute entrée est référencée) implique un
mapping canonique 1:1 entre coord flottante et index `pointList`.
Cette propriété justifie l'usage de `pointList.findIndex(v =>
adjacentPoints(v, p, 0.01))` dans §7.8 (label) et l'absence de dedup
dans `cloneShape` §3.8 (l'unicité est garantie à l'entrée —
`validateShape` loguerait au reload si une scene legacy enfreint I3).

### §5.2 Cycle `meshesDesigner.consoleFrame`

`consoleFrame = { left, top, width, height }` en pixels, restauré au boot et
persisté après chaque drag/resize (mouseup document-level — pas à chaque tick,
pour éviter de polluer ainsi que la history stack).

### §5.4 Persistance de l'historique undo/redo (`meshesDesigner.undo`)

L'historique undo/redo (`state.historyStack` / `state.redoStack`) est
persisté dans `localStorage` et restauré au boot, pour que l'utilisateur
retrouve son historique en revenant dans l'application (reload navigateur,
fermeture/rouverture). Spec utilisateur : « conserver le undo en localhost
pour le retrouver au retour dans l'application ; le réinit de l'undo est
effectué au réinit de la scène ou au load replace d'une scène ».

#### §5.4.1 Clé dédiée, séparée de la scène

La clé `meshesDesigner.undo` (`UNDO_STORAGE_KEY`) est distincte de
`meshesDesigner.scene` : `serializeState()` alimente aussi `saveMesh`
(export fichier) — l'historique ne doit JAMAIS transiter par le wire format
exporté (fichiers boursouflés + fuite de données d'édition).

Format : `{ scene, historyStack, redoStack }` où `historyStack` /
`redoStack` sont les piles telles quelles (entries delta OU fallback
snapshot, cf. §8.2 — les slots `undefined` survivent au round-trip JSON
en tant que clés absentes, ce qui préserve les invariants I5/I6), et
`scene` est le **fingerprint** (cf. §5.4.3).

#### §5.4.2 Écriture conditionnelle via le flag `undoPersistDirty`

`persistState()` est appelé en continu (zoom/pan via `viewport.js`,
mutations via `editor.js` / `shapes.js` / `merge.js`). Re-sérialiser
l'historique à chaque appel coûterait cher (jusqu'à `MAX_HISTORY = 50`
entries × patches/snapshots). Un flag module-scope `undoPersistDirty`
(io.js — pas un champ de `state` : donnée de persistance interne, pas
état applicatif) limite l'écriture aux moments où les piles changent :

- `saveState` / `undo` / `redo` (history.js) posent le flag via
  `markUndoPersistDirty()` ; la `persistState()` suivante (appelée par le
  call site juste après `saveState`, ou en fin d'`undo`/`redo`)
  ré-écrit la clé.
- L'import MERGE pose le flag aussi : les piles ne changent pas mais le
  fingerprint de scène doit être rafraîchi après l'append (cf. §5.4.4).
- Zoom/pan ne touchent jamais le flag → la clé n'est pas ré-écrite.

#### §5.4.3 Atomicité d'écriture + fingerprint de scène

Les deux clés (`meshesDesigner.scene` et `meshesDesigner.undo`) sont
écrites dans le MÊME appel synchrone de `persistState()` (la même string
`sceneJson` sert à la fois à la clé scene et au champ fingerprint du JSON
undo) : aucun crash ne peut s'intercaler entre les deux `setItem` — les
deux clés restent cohérentes, ou aucune ne bouge.

Au boot, `restoreUndoHistory()` (io.js, appelé depuis `loadState` avant
`captureSceneBaseline`) compare le fingerprint stocké avec
`serializeState()` de la scène réhydratée. En cas de divergence, les
entries sont ignorées (log `Undo restore: historique ignore ...`) plutôt
que restaurées sur une scène qui ne leur correspond pas (les indices des
patches pointeraient faux). Cas de divergence couverts :

- **Quota dépassé** sur l'écriture undo (la scène passe, l'undo non). Le
  flag est neutralisé pour éviter de re-tenter + re-logger à chaque
  zoom/pan ; l'undo ne survit simplement pas au reload (dégradation
  silencieuse, loggée).
- **Onglets croisés** : deux onglets partagent le localStorage ; leurs
  `setItem` peuvent s'intercaler entre la clé scene et la clé undo.
- **Ancien build / clé absente** : restore no-op.

Garde-fous du restore : JSON corrompu / structure invalide → abandon
silencieux (les piles restent vides) ; piles recoupées à `MAX_HISTORY`
(defense in depth — `saveState` plafonne déjà à l'écriture).

`onBeforeUnload` flushe le même couple clé + fingerprint si un flag est
resté en attente (fermeture avant le prochain `persistState`) — miroir
strict de `persistState`.

#### §5.4.4 Points de réinit (spec utilisateur)

Le réinit de l'undo se fait à DEUX moments, en mémoire ET sur disque :

| Événement | En mémoire | Sur disque |
|---|---|---|
| **Reset complet** (`resetAll`) | `state.historyStack/redoStack = []` | `clearPersistedUndo()` : `removeItem(UNDO_STORAGE_KEY)` + flag neutralisé (la `persistState` suivante — ex. un zoom — ne ré-écrit pas la clé) |
| **Import REPLACE** (`applyImport` mode `replace`) | `resetEphemeralState(true)` | `clearPersistedUndo()` |
| **Import MERGE** (`applyImport` mode `merge`) | CONSERVÉ (`resetEphemeralState(false)`) | CONSERVÉ ; `markUndoPersistDirty()` rafraîchit juste le fingerprint |

Pourquoi MERGE conserve : les entries existantes référencent des indices
de plan `< beforeCount` — un append ne les invalide pas. Conséquence
assumée : après un MERGE, `Ctrl+Z` annule la dernière action d'avant le
merge (le merge lui-même n'est pas annulable — il n'est pas représenté
dans la pile).

#### §5.4.5 Cycle de vie complet (walkthrough)

1. Mutation → `saveState` (push entry + flag) → `persistState` écrit
   scene + undo ensemble (fingerprint = scène post-mutation).
2. Reload → `loadState` réhydrate la scène → `restoreUndoHistory`
   compare le fingerprint → match → les deux piles sont restaurées
   (`updateUndoRedoHud` affiche la profondeur).
3. Undo/redo → transfert d'entries + flag + `persistState` ré-écrit les
   deux clés (fingerprint = scène post-undo/redo).
4. Reset / REPLACE → piles vidées + clé retirée → un reload ne
   ressuscite pas l'undo de l'ancienne scène.

---

## §6. Rotation AltGr (molette)

### §6.1 Sémantique : mutation per-shape, pas rotation de caméra

AltGr + molette n'est PAS une transformation du viewport — c'est une mutation
**per-shape** : `rotateEachShapeAroundPivot` translate TOUS les vertices de
TOUS les plans autour d'un pivot en coords MODÈLE. Les axes restent fixes
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

### §7.1 Inactif (plans non-courants)

Gris atténué (`#5A5A5A` lignes, `#7A7800` points) pour signaler
"non-éditable" tout en restant visible. **PAS de fill sur triangles inactifs**
— simples contours gris pour conserver le signal de non-éditabilité (un wash
transparent masquerait ce signal).

### §7.2 Actif (plan courant)

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

### §7.3.1 Palette persistée, modifiable et enrichissable (`meshesDesigner.colorPalette`)

Evolution « la palette de couleur peut être modifiée et enrichie ; elle est
conservée en localhost ». La palette passe du statut de **constante**
(`TRIANGLE_COLOR_PRESETS`, figée au boot) à celui de **préférence
utilisateur** : `state.colorPalette` est un tableau de `{ bg, fill }`
initialisé aux 8 presets historiques, remplacé au boot par
`restoreColorPalette` (editor.js) si une sauvegarde existe, et ré-écrit à
chaque mutation via `persistColorPalette`.

**Format persisté** : liste JSON de strings hex `#rrggbb` (le `fill` est
TOUJOURS dérivé du couple `(bg, colorAlpha)` par `triangleFillFromBg` —
le `fill` est une fonction pure de la couleur ET de l'opacité globale
§7.3.2, il n'a pas de raison d'être persisté ; la clé reste compacte et la
désynchronisation `bg`/`fill` impossible). Les **anciennes sauvegardes**
restent lisibles : liste de strings hex (format historique) ou liste
d'objets `{ bg }` / `{ bg, alpha }` (format intermédiaire, l'alpha par
swatch est ignoré : l'opacité est désormais globale). Clé absente, JSON
invalide, liste vide ou entrée mal formée → fallback sur les defaults.

**Statut de préférence (vs scène)** : comme `consoleVisible` /
`reticleMode` / `circleSegments`, la palette est restaurée au boot mais ne
fait PAS passer la scène à « modifiée » — elle n'entre pas dans le wire
format exporté (`serializeState` ne la sérialise pas, la palette ne doit
jamais transiter par un fichier de scène).

**Interactions du panneau `#triangleColor`** :

- **Ajouter** (`#colorPaletteAdd`) : enregistre la couleur courante du
  picker (`#triangleColorInput`) comme nouveau swatch — dédup
  case-insensitive sur le `bg` (une couleur déjà présente = no-op armé).
- **Retirer** : clic droit sur un swatch (`removePaletteColor`) — garde :
  la palette ne doit JAMAIS être vide (`showTriangleColorPanel` et les
  ré-armements du pinceau lisent `colorPalette[0]` ; une palette vide
  casserait l'ouverture du panneau). Le pinceau est ré-armé sur la couleur
  qui a pris la place de celle retirée.
- **Modifier** : double-clic sur un swatch (`startPaletteEdit`) = mode
  édition — le picker prend sa couleur, et chaque `input` du picker met à
  jour le swatch EN DIRECT (WYSIWYG, commit + persistance à chaque tick).
  Entrée = fin de mode (la couleur déjà committée reste), Échap =
  annulation (`cancelPaletteEdit`, retour à `colorPaletteEditingBefore`
  — la couleur d'origine est re-committée et re-persistée). Le curseur
  d'opacité n'est PAS touché par le mode édition (opacité globale).
- **Restaurer** (`#colorPaletteRestore`) : revient aux 8 presets
  d'origine (`TRIANGLE_COLOR_PRESETS`).

**Priorité d'interception d'Échap** (main.js keydown) : en mode édition,
le premier Échap annule l'édition SANS fermer le panneau (le panneau ne
se ferme qu'au second Échap). La branche `colorPaletteEditingIndex != null`
est donc placée AVANT la branche `hideTriangleColorPanel`.

**Coexistence avec le pinceau direct** : hors mode édition, le picker
conserve son usage historique — sa valeur hex + l'opacité de travail
courante arment le pinceau DIRECTEMENT, sans passer par la palette (une
couleur libre n'est pas forcément destinée à la palette ; l'intention
utilisateur — y compris l'opacité — est préservée, cf. §7.3.2). En mode
édition au contraire, le picker pilote le swatch. Les deux chemins sont
distingués par `state.colorPaletteEditingIndex`.

### §7.3.2 Opacité unique appliquée à chaque peinture (curseur `#colorAlpha`)

L'opacité de peinture est **unique et globale** : le curseur `#colorAlpha`
(range 0..100, libellé `#colorAlphaValue` en %) du panneau fixe
`state.colorAlpha` ([0,1], défaut `TRIANGLE_COLOR_DEFAULT_ALPHA = 0.45`),
le fill de CHAQUE couleur de la palette étant dérivé du couple
`(bg, colorAlpha)` par `triangleFillFromBg`. Conséquence directe :
« l'opacité choisie par l'utilisateur est appliquée à chaque fois que l'on
peint un triangle » — cliquer un swatch choisit la COULEUR, l'opacité
reste celle de l'utilisateur (le curseur ne bouge pas au clic).

- **Armement** : toute armée du pinceau (clic swatch, picker hors
  édition, ouverture du panneau, « Défauts », drag du curseur) produit
  `fill = triangleFillFromBg(bg, colorAlpha)`. Le swatch affiche ce fill
  (aperçu WYSIWYG de la peinture sur le fond sombre du panneau).
- **Drag du curseur** : `setColorAlphaSlider` + `refreshPaletteFills`
  (recalcul de tous les fills → les swatches montrent la nouvelle
  translucidité EN DIRECT) + ré-armement du pinceau + `buildColorSwatches`.
- **Édition (double-clic)** : porte sur la COULEUR uniquement (picker →
  swatch en direct) ; l'opacité est hors du mode édition.
- **Reset / Défauts** : ne touchent pas à l'opacité de travail (ils
  restaurent des couleurs, pas la préférence d'opacité).

**Persistance** (`meshesDesigner.colorAlpha`) : l'opacité est une
**préférence utilisateur** (restaurée au boot par `restoreColorPalette`
— AVANT la palette, dont les fills en sont dérivés — jamais sérialisée en
scène). Règle : « l'opacité reste à la dernière valeur fixée par
l'utilisateur ». Seul un réglage **manuel** du curseur (drag `#colorAlpha`)
persiste la valeur (`persistColorAlpha`) ; les synchronisations
d'affichage (clic swatch, Reset, Défauts) ne réécrivent jamais la
préférence — au prochain rechargement, c'est le dernier réglage manuel
qui revient et qui s'applique à la peinture. `state.colorAlpha` porte la
valeur de session ; le curseur DOM n'est qu'un miroir synchronisé par
`setColorAlphaSlider`.

`triangleFillFromBg` clample l'alpha dans [0,1] (défense : un alpha hors
bornes produirait un rendu canvas silencieusement invalide et passerait
tel quel dans le wire format des scènes).

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
subséquents : axes via `drawAxis`, drawShape / drawTriangle d'autres plans,
reticule, …).

### §7.6 Feedback post-clic (sélection effective)

Une fois le clic engagé (§3.6 modificateurs appliqué), la sélection passe du
vert de prévisualisation (§7.4) au cyan `#00FFFF` pour distinguer
_"en cours de décision"_ de _"sélection confirmée"_. Sans cette séparation
chromatique, une sélection pré-existante et un hover seraient indistinguables
UX — ambiguïté maximale juste avant une touche Suppr par exemple.

**Points sommets engagés** (`drawSelectedPoints`) :

- `COLOR_SELECTED_POINT = '#00FFFF'` — cercle rayon 6 autour de chaque
  sommet engagé (vs 5 hover §7.4 vs 3 curseur §8) pour signaler _stabilité_
  vs _volatilité_.
- `COLOR_SELECTED_POINT_DIMMED = 'rgba(0, 255, 255, 0.6)'` — variante
  atténuée déclenchée par `state.isSelectionDimmed = true` quand une
  sélection existe déjà et que le hover désigne **un autre point** que ceux
  engagés (le clic simple remplacerait la sélection — informer
  visuellement que la sélection courante ne survivrait pas).

**Boîte de sélection (lasso)** (`drawSelectionBox`) :

- `COLOR_SELECTION_BOX_FILL = 'rgba(0, 255, 255, 0.15)'` — remplissage de
  la zone (15% d'opacité, wash léger qui ne masque pas les triangles
  actifs).
- `COLOR_SELECTION_BOX_STROKE = '#00FFFF'` — contour en
  `setLineDash([4, 4])` pour signaler visuellement _"zone en cours de
  définition"_.

**Cohérence hover vs post-clic** : cyan (sélection engagée) et vert (hover
prévisualisation §7.4) sont dans des familles chromatiques disjointes (bleu
vs vert ± transparent). Sans cette règle, une personne dyschromate
confondrait les deux états, et un screenshot sans contexte
(documentation, bug report) perdrait l'info _état hover_ vs _état engagé_.

### §7.5 Action enum (`ACTION_NONE`, `ACTION_GRABBING`)

`ACTION_NONE = undefined` (intentionnel, pas `0`) : idiome
`currentAction === undefined` comparable sans cast et exprime clairement "pas
d'action en cours". `ACTION_GRABBING = 1` (drag d'un point en cours).

### §7.8 Label d'index stable du sommet surve

Quand le curseur passe au-dessus d'un sommet dans n'importe quel mode de
sélection, `drawVertexLabel(p, idx)` rend une **pill sombre 10 px
monospace** sous le sommet affichant l'**index 0-based** du vertex dans
le `pointList` du plan actif (`state.shapes[activeShapeIndex].pointList[idx]`).
Le helper `getVertexIndex(p)` de `geometry.js` implémente la résolution
via `activeShapePointList().findIndex(v => adjacentPoints(v, p, 0.01))` —
corollairement, l'invariant I3 (pas de doublons au sens §3.2 tolérance
0.01) garantit un index unique par coord : un `findIndex` est ici
suffisant pour mapper un point écran vers son slot canonique.

La convention est dev-friendly : `pointList[0]` est le 1er sommet du
plan actif — alignement JS array natif qui rend la lecture debug
immédiate (`state.shapes[i].tris[k].p1 = vertex 7` → label "7"
cohérent). Toute la topologie est désormais en indices (cf. §3.4
runtime indexe), donc un label "7" référence directement
`shapes[i].pointList[7]`.

**Géométrie** :
- Background `rgba(0,0,0,0.6)` — semi-transparent pour rester lisible
  sur zone sombre ou triangle custom (cf. §7.3 fill swatches qui ne
  doivent pas masquer ce signal).
- Foreground `#FFFFFF`, font 10 px monospace, padding horizontal 6 px.
- Hauteur 14 px, position sous le cercle vert hover rayon 5 px de §7.4
  (`OFFSET_Y = +14`) sans chevauchement visuel.

**Implémentation** :
- Le helper `getVertexIndex(p)` itère `state.shapes[activeShapeIndex].pointList`
  directement (le `pointList` du plan actif, pas de raccourci
  helper — le code accède à la slice via `state.shapes[…].pointList` à
  chaque call site) et retourne
  `findIndex(v => adjacentPoints(v, p, 0.01))` → -1 si absent
  (defense). `findIndex` est suffisant grace a l'invariant I3 (un
  seul slot par coord, cf. §5.3) — pas de dedup a faire.
- Fallback `'?'` côté caller (`editor.js:updateMouseHover`) si la
  défense retourne -1. Ce cas ne devrait jamais survenir dans le call
  site normal puisque `findNearestPoint` garantit que le point rendu
  existe dans le `pointList` du plan actif (invariants I1+I2 de §5.3).

**Relation aux autres features** :
- §7.4 montre "où" (cercle vert 5 px sur le sommet le + proche), §7.8
  montre "qui" (label d'identité stable). Sans §7.8, deux sommets à
  coordonnées identiques en mode cluster (§3.2) sont indistinguables.
- L'alerte triangle rouge §7.7 (retirée dans le chore du même nom)
  précédait cette feature en comblant le même besoin UX (identifier
  les stacks). §7.8 + §7.9 reprennent ce role sans le surlignage
  strident.

### §7.9 Liste des slots triangles partageant la position survee

Quand le sommet surve a plusieurs refs (cluster §3.2 ou topologie de mesh dense), `drawStackList(p, refs)` rend une **pill 2-lignes** sous le label §7.8 listant les `(triangleIndex, slotId)` adjacents.

**Géométrie** :
- Header ligne 1 : `stack (N)` en `#FFD700` (golden) sur fond opaque `rgba(0,0,0,0.7)`. N = nombre de slots triangles à cette position.
- Body ligne 2 : `T0.p1, T2.p3, ...` en `#FFFFFF` (blanc), séparés par virgule + espace. Format `{triangleIndex}.{slotId}` (slotId = `p1`, `p2` ou `p3`).
- Font 10 px monospace, padding 6 px horizontal, height 14 px par ligne + 4 px padding vertical.
- Position `OFFSET_Y = +32` — sous §7.8 (offset +14) sans overlap visuel.

**Affichage conditionnel** : la pill n'est rendue que si `refs.length > 1`. Un seul slot adjacent ne déclenche pas §7.9 (ce serait redondant avec le label §7.8 qui suffit à identifier le sommet). Filtre `if (stackRefs.length > 1)` dans `editor.js:updateMouseHover` (call site hover).

**Implémentation** :
- Helper `getStackTriangleRefs(p, tolerance = 0.01)` de `geometry.js` (commit `05cabe3 feat(geometry): §7.x helpers`). Itère `activeTriangles()` (alias court pour `state.shapes[activeShapeIndex].tris`, helper exporté par `geometry.js`) et pousse pour chaque triangle la liste des slots (`p1`/`p2`/`p3`) dont `adjacentPoints(pointList[slot], p, tolerance)` est vrai — la résolution coords passe par l'index du slot dans le `pointList` (cf. §3.4 runtime indexe).
- Tolerance par défaut 0.01 unité modèle (cohérent avec §3.2 cluster semantics et §4.1 delete). Paramétrable pour tests spécifiques.

**Cas d'usage** :
- Topologie normale (deux triangles partageant un sommet) : 1 slot adjacent → §7.9 ne s'affiche PAS (filtre `> 1`).
- Cluster intentionnel (`getPointsAtSamePosition(p).length > 1`, §3.2) : N>1 → §7.9 liste les slots triangles.
- Stress-test ou import avec doublons accidentels : N visible permet de détecter rapidement la multiplicité sans ouvrir devtools.

**Edge case (filet défensif non appliqué)** : `getStackTriangleRefs` peut retourner plusieurs entrées pour le même `triangleIndex` si 2+ slots du même triangle sont adjacents au point (cas dégénéré topologique). Une dedup par référence (`!refs.some(r => r.ref === entry.ref)`) serait plus robuste mais n'est pas appliquée (dette technique consignée ; nit reviewer du commit `2c586fa`). Le slotId est identifié via la position de l'index dans le tableau `tris[k]` : `triangle.tris[k].p1` → slotId `"p1"`, etc. — le format affiche `{triangleIndex}.{slotId}` (cf. spec §3.10).ols.

**Edge case (filet défensif non appliqué)** : `getStackTriangleRefs` peut retourner plusieurs entrées pour le même `triangleIndex` si 2+ slots du même triangle sont adjacents au point (cas dégénéré topologique). Une dedup par référence (`!refs.some(r => r.ref === entry.ref)`) serait plus robuste mais n'est pas appliquée (dette technique consignée ; nit reviewer du commit `2c586fa`). Le slotId est identifié via la position de l'index dans le tableau `tris[k]` : `triangle.tris[k].p1` → slotId `"p1"`, etc. — le format affiche `{triangleIndex}.{slotId}` (cf. spec §3.10).

### §7.10 Marqueur des sommets multi-points (anneau orange)

Evolution « ajouter une distinction visuelle pour les sommets qui
correspondent à plusieurs points afin de faciliter leur regroupement ».

**Sémantique** : un **sommet multi-points** est une position physique
portant **plusieurs entrées `pointList`** dans le plan actif (cluster
§3.2, tolérance 0.01) — autrement dit des **doublons** : des points
distincts superposés au même endroit, chacun référencé par ses propres
slots triangles. C'est le cas des scènes legacy / importées (le wire
format déduplique par coord exacte à l'import, mais les fichiers JSON
anciens — p.ex. un dump d'avant la restructuration `{pointList, tris}`
— peuvent porter des coords identiques en doublon ; `validateShape`
les signale en log soft sous l'invariant I3). Ces sommets sont les
**vrais candidats à la fusion** `#mergePoints` : cliquer dessus en
mode vertex sélectionne TOUT le cluster (`getIndicesAtSamePosition`),
puis le bouton Fusionner les regroupe en une seule entrée au centroid.

**Distinction avec §7.9** : `getStackTriangleRefs` (pill `stack (N)`
au survol) compte les **slots triangles** partageant la position — y
compris la topologie dense légitime (centre d'un éventail de cercle,
sommet partagé par N triangles), qui n'a rien à fusionner. Le
marqueur §7.10 compte les **entrées `pointList`** (les « points » au
sens de l'édition) : c'est la multiplicité que l'utilisateur peut
vraiment réduire par la fusion. Un cercle généré par l'app ne porte
donc AUCUN marqueur (un seul `pointList` par coord, invariant I3).

**Rendu** : anneau **orange** (`COLOR_MULTI_POINT = #FFA500`, rayon
`MULTI_POINT_RADIUS = 5`) autour du point jaune (rayon 2). Orange
choisi pour rester distinct à tous les états : jaune des points actifs
(#FFFF00), cyan de sélection (#00FFFF), vert de hover (#00FF00),
blanc du curseur (#FFFFFF). Il est dessiné dans la **scène stable**
(offscreen, `drawMultiPointMarkers` appelé dans
`renderSceneToOffscreen` **après** `drawSelectedPoints`) : un sommet
sélectionné garde son anneau visible au-dessus du cercle cyan r6.
Batching via `drawPointsBatch` (1 beginPath/stroke) ; l'over-stroke de
N anneaux identiques sur la même position est inoffensif (un seul
anneau visible). Masqué en preview, comme tous les points de contrôle.

**Plan actif uniquement** : `mergeSelectedPoints` n'agit que sur le
plan actif (et §7.8/§7.9 sont déjà actives-shape-only) — les
marqueurs guident la fusion là où elle s'applique, sans bruit sur les
plans inactifs grisés. À la navigation de plan, les marqueurs
suivent le plan actif.

**Complexité** : `getMultiPointIndices(shape)` (geometry.js) trie les
indices par x puis balaye une fenêtre glissante — break dès que
`dx >= 0.01` (la tolérance exigeant les deux axes, toute paire au-delà
est non-adjacente par construction). O(N log N) en cas normal, au
lieu du O(N²) naïf de `validateShape` ; le pire cas (N points de même
x) retombe sur O(N²), borne déjà acceptée pour I3. Recalculé à chaque
re-render offscreen, donc jamais sur le chemin chaud du blit.

**Anti-régression** : le marqueur ne doit apparaître que pour de VRAIS
doublons — une scène dessinée par l'app (I3) n'en affiche aucun ; les
scènes importées avec doublons en affichent un par position dupliquée,
et la fusion réduit le compte à zéro (contre-épreuve couverte par
`scripts/smoke-multipoint.mjs`).

### §7.11 Fusion par déplacement (2e fonction de `#mergePoints`)

Le bouton Fusionner porte deux fonctions :
1. **Fusion classique** (>= 2 points sélectionnés) : les points
   convergent vers le centroid des positions uniques.
2. **Fusion par déplacement** (exactement 1 point sélectionné) : le
   clic ARME le mode au lieu de signaler une sélection insuffisante.
   Déplacer le point sélectionné (clic droit + drag, le geste de
   déplacement habituel) puis le RELÂCHER près d'un autre point le
   fusionne avec lui.

**Cycle du bouton en 3 états (évolution verrouillage)** : le clic sur
le bouton (avec 1 point sélectionné) fait cycler le mode dans un
cycle à 3 états au lieu du simple toggle armé/désarmé :

1. **Désarmé** → clic = **arme** (bouton `.merge-armed`, accent vert,
   libellé du rayon).
2. **Armé (non verrouillé)** → clic = **verrouille** (bouton
   `.merge-locked` + icône cadenas + ring inset vert). Le verrou
   exprime l'intention d'ENCHAÎNER plusieurs fusions : après une
   fusion réussie, le mode reste armé ET verrouillé au lieu de se
   désarmer.
3. **Armé + verrouillé** → clic = **désarme** tout (mode + verrou),
   même contrat que l'ancien re-clic.

Le verrouillage n'est jamais persisté (même statut transitoire que
`mergeOnDropActive`) : un reload retombe sur le mode désarmé.

**Le mode se désarme** : au clic sur le bouton verrouillé, après une
fusion réussie NON verrouillée, ou dès que la sélection n'est plus un
point unique (garde dans `updateSelectionHud`, hud.js — qui déverrouille
AUSSI : la sélection multi-points déverrouille et désarme). La fusion
classique (>= 2 points) désarme aussi le mode en tête de
`mergeSelectedPoints` (chemin préexistant).

**Limite réglable** : `state.mergeDropRadius` (pixels écran, défaut
`MERGE_DROP_RADIUS_DEFAULT_PX = 20`, bornes 8–64, pas ±2 px par cran),
convertie en unités modèle via le zoom — même convention que les
tolérances de hit-testing (§1.4) : la zone de fusion reste constante à
l'écran quel que soit le zoom. Réglée à la molette sur le bouton
Fusionner QUAND le mode est armé (même langage que le nombre de côtés
du cercle : le bouton affiche « 20px », `wireMergeDropWheelControl` /
`adjustMergeDropRadius` dans viewport.js, sans effet hors mode).
Préférence de session persistée hors wire format (clé
`meshesDesigner.mergeDropRadius`, restaurée au boot par
`restoreMergeDropRadius`) — même statut que `circleSegments`. La borne
basse (8 px) reste volontairement serrée : la fusion doit demeurer un
geste délibéré.

**Sémantique de la fusion** : le point DÉPLACÉ fusionne DANS la cible
(le point le plus proche dans la limite) — la position de la cible est
conservée, pas un centroïde intermédiaire. Le mécanisme commun
`applyMergeToSelection` (survivant = plus petit indice, redirection des
slots, compactage immédiat Q2a, ré-indexation) est partagé avec la
fusion classique : la seule différence est la position du survivant
(centroid vs position de la cible) et le libellé du log.

**Déroulement du geste** :
1. `mergeSelectedPoints` (merge.js) : 1 seul point → `toggleMergeOnDrop`
   fait avancer le CYCLE du bouton (arme → verrouille → désarme, cf.
   ci-dessus — bouton `.merge-armed` / `.merge-locked`, log explicatif).
   0 point → modale « Sélection insuffisante » (inchangé). >= 2 →
   fusion classique.
2. `beginGrabbing` / `resolveMouseMoveOnBoard` (editor.js) : pendant
   le drag, `updateMergeDropCandidate` calcule à chaque tick le point
   le plus proche du point déplacé dans la limite →
   `state.mergeDropCandidate` (index pointList, undefined sinon) ;
   `renderTransient` (draw.js) l'affiche en anneau orange en pointillés
   (même couleur que le marqueur multi-points §7.10) AU RAYON COURANT
   `state.mergeDropRadius` — le cercle matérialise la zone de capture,
   le réglage de la molette est donc visible en direct pendant le drag.
   Gardé par `currentAction === ACTION_GRABBING` pour ne jamais montrer
   un candidat périmé hors drag.
3. `endGrabbing` (editor.js) retourne `movedScene` ; main.js n'appelle
   `attemptDropMerge` (merge.js) QUE si le geste a réellement déplacé
   la géométrie — un clic droit simple reste sélection pure
   (`processRightClickSelection`), jamais une fusion (la sélection
   aurait pu changer entre le mousedown et le mouseup).
4. `attemptDropMerge` : lit `state.mergeDropCandidate` (calculé au
   dernier tick du drag, y compris par le `resolveMouseMoveOnBoard`
   final de `endGrabbing`), pose `selectedPoints = [déplacé, cible]` et
   délègue à `applyMergeToSelection(position de la cible)`. Conflit
   topologique (un triangle contient les deux points) → modale d'erreur
   et restauration de la sélection utilisateur (le mode reste armé —
   verrouillé ou non — et le déplacement reste annulable). Succès →
   désarmement SAUF si le mode est verrouillé : dans ce cas il reste
   armé ET verrouillé pour permettre l'enchaînement (le survivant est
   l'unique point sélectionné, le mode reste donc utilisable
   immédiatement sur un autre point).

**Historique** : le geste produit 2 entrées undo (déplacement puis
fusion), chacune annulable séparément (Ctrl+Z une fois = retour à la
position de dépôt sans fusion ; Ctrl+Z deux fois = retour à la position
d'origine). Le patch déplacement est commité par `endGrabbing` avant la
tentative de fusion ; le patch fusion est un `replaceShapePatch`
before/after classique.

**Anti-régression** : un drag AltGr (mouvement global) vide la
sélection dans `beginGrabbing` → la garde « 1 point sélectionné »
d'`attemptDropMerge` ne peut pas se déclencher. Le candidat est effacé
en tête de `beginGrabbing` (pas de résidu d'un drag précédent) et à
chaque mutation de sélection non-singleton. Couvert par
`scripts/smoke-mergedrop.mjs`.

### §7.12 Presse-papiers interne : couper / copier / coller (`#copy` / `#cut` / `#paste`, Ctrl+C / Ctrl+X / Ctrl+V)

(évolution « couper, copier, coller les éléments sélectionnés »)

**Périmètre** : les opérations portent sur la sélection du PLAN
ACTIF — les points de `state.selectedPoints` + les triangles du
plan actif ENTIÈREMENT contenus (les 3 slots `pX` sont des indices
sélectionnés). Les triangles partiels (`pX` undefined, construction en
cours) ne sont jamais copiés. Le `fill` des triangles est conservé
(propriété du triangle, même convention que `compactPointList`).

**Presse-papiers interne, pas `navigator.clipboard`** : le contenu est
un sous-ensemble du modèle `{pointList, tris}` — format interne que le
presse-papiers système ne transporte pas fidèlement, et l'accès async +
permissions serait fragile sous `file://` (build portable).
`state.clipboard = { points: [{x,y}…], tris: [{p1,p2,p3,fill}…],
offset }` ; `offset` = compteur de collages de la chaîne courante
(réinitialisé à 0 à chaque copier/couper, incrémenté après chaque
coller). Non persisté en localStorage (session seule, comme la preview).

**Copier** (`copySelection`, editor.js) : `captureClipboard` lit les
coords des points sélectionnés + les triangles contenus, ré-indexés en
indices RELATIFS à la liste copiée (le collage re-base sur
`pointList.length` du plan actif au moment du collé). La sélection
est conservée.

**Couper** (`cutSelection`) : copie puis supprime la sélection via
`deleteSelectedPoint` (même sémantique que Backspace : tris à < 2
survivants filtrés, compactage I2, `replaceShapePatch` before/after —
un seul chemin de vérité pour la suppression). Le presse-papiers reste
rempli pour coller.

**Coller** (`pasteClipboard`) : append les points à la fin du
`pointList` du PLAN ACTIF (coords absolues), re-indexe les
triangles dessus (base = longueur pré-mutation), sélectionne la copie
collée. **Décalage de collage** : chaque collage décale d'un demi-pas
de grille (`GRID_STEP / 2`) supplémentaire depuis la source (cumulé via
`clipboard.offset`), pour que les copies successives se cascadent
visuellement et restent distinctes de la source — grabbables sans
ambiguïté malgré les doublons de position (les doublons restent de
toute façon signalés par l'anneau orange §7.10).

**Boutons & raccourcis** : `#copy` / `#cut` / `#paste` dans le groupe
sélection de la toolbar (après `#selectionCount`), désactivés sans
sélection / sans presse-papiers (`updateClipboardButtons`, hud.js —
appelé par `updateSelectionHud` et par les fonctions presse-papiers).
Ctrl+C / Ctrl+X / Ctrl+V (main.js) passent par les MÊMES fonctions — un
seul chemin de vérité. Garde `typing` : indispensable pour Ctrl+V, sans
elle le coller interne intercepte la frappe dans un champ (ex. champ de
renommage de la fenêtre d'enregistrement) et casserait le collage natif
du navigateur. Ignorés en preview (mutations de scène, même politique
que undo/redo).

**Historique** : couper et coller produisent chacun UNE entry undo
(`replaceShapePatch`) — Ctrl+Z annule le collage (les points collés
disparaissent, la sélection revient), Ctrl+Z après un couper restaure
les points supprimés. Couvert par `scripts/smoke-clipboard.mjs`.

---

### §7.13 Ordre des plans : monter / descendre (`#moveShapeUp` / `#moveShapeDown`, Alt+↑ / Alt+↓)

(évolution « boutons pour gérer l'ordre des formes »)

**L'ordre EST la sémantique des plans.** Dans la vue plans (§2.6),
`drawShapes` rend les plans dans l'ordre du tableau `state.shapes` —
le plan d'indice le plus haut est dessiné en dernier donc **recouvre**
les précédents là où ils se chevauchent. Réordonner le tableau =
réordonner les plans, sans toucher ni aux `pointList` ni aux `tris`
d'aucun plan.

**Sens choisi avec l'utilisateur :** MONTER le plan actif =
indice +1 (`1/3 → 2/3 → 3/3`), il passe AU-DESSUS dans la vue plans
(recouvre ceux d'indice inférieur). DESCENDRE = indice -1, il passe
en dessous. Le compteur `#shapeLabel` (plan actif / total) monte et
descend avec lui — un monter du plan 1/3 l'amène en 2/3.

**Entrées** : boutons `#moveShapeUp` / `#moveShapeDown` dans le groupe
« Shape nav » (après `#nextShape`, avant `#newShape`) + raccourcis
`Alt+Flèche Haut` / `Alt+Flèche Bas` (main.js keydown). Gardes des
raccourcis : `typing` (ne pas voler la saisie d'un champ), `preview`
(visualisation seule, même politique que undo/redo), `!e.ctrlKey`
(AltGr = Alt+Ctrl est exclu — cf. §3.6), `!e.repeat` (un déplacement
par frappe). Les boutons passent par les MÊMES fonctions
(`moveShapeUp` / `moveShapeDown` dans shapes.js) — un seul chemin de
vérité.

**Bornes** : `updateShapeHud` (hud.js) grise `#moveShapeUp` sur la
dernier plan (`activeShapeIndex >= length - 1`) et
`#moveShapeDown` sur la première (`<= 0`) — même langage disabled que
undo/redo (opacité 0.35 + `not-allowed`). Les fonctions sont
elles-mêmes des no-op hors bornes (défense en profondeur : un clic
programmatique sur un bouton grisé ne fait rien).

**Historique (delta §8)** : nouveau patch `shapeMove { from, to }`
dans history.js — le plus économe possible (~16 B) car un déplacement
ne change NI `pointList` NI `tris` : seules les positions du tableau
bougent, l'applicateur fait le splice dans les deux directions
(forward = `from→to`, inverse = `to→from`). Le call site (shapes.js
`moveShape`) accole un `activeShapeIndexPatch(from, to)` : le plan
actif SUIT son déplacement, et l'undo/redo restaure donc l'ordre ET
l'index actif. L'entry est couverte par `shouldUseSnapshot`
(estimation 16 B — jamais promue en snapshot). Le splice en mémoire
est le miroir exact de l'applicateur history.js (remove at `from`,
insert at `to`) ; `goToShape(to)` réutilise le nettoyage d'état
transitoire du chemin de navigation (sélection, hover, HUDs).

**Persistance** : mutation de scène ordinaire — `saveState` (dirty +
undo) puis `persistState` (le nouvel ordre est sérialisé dans le wire
format et survit au reload). Couvert par `scripts/smoke-shapeorder.mjs`.

---

### §7.14 Alignement / répartition des points sélectionnés (`#align`, panneau 4 actions, Alt+← / Alt+→ / Alt+⇧+← / Alt+⇧+→)

(évolution « boutons pour forcer l'alignement et la répartition des
points sélectionnés »)

**4 actions sur la sélection du PLAN ACTIF**, accessibles depuis
le panneau du bouton `#align` (groupe sélection, après `#paste` avant
`#triangleColor`) et les raccourcis clavier :

| Action | Raccourci | Sémantique |
|---|---|---|
| Aligner X | `Alt+←` | tous les points sélectionnés prennent la coordonnée **X du premier point sélectionné** (l'ancre), leur Y est conservé |
| Aligner Y | `Alt+→` | idem sur Y (X conservé) |
| Répartir X | `Alt+⇧+←` | espacement **uniforme** selon X entre les deux points extrêmes (min et max restent en place) |
| Répartir Y | `Alt+⇧+→` | idem sur Y |

**Référence d'alignement = le premier point sélectionné** (`state.selectedPoints[0]`), convention des éditeurs vectoriels : l'ancre est explicite dans l'ordre de sélection, les autres points convergent vers elle (coordonnée alignée seule, l'autre axe est conservé). La répartition trie les indices sélectionnés par coordonnée croissante puis place les rangs intermédiaires à pas égal : `pos_i = min + (max - min) * i / (n-1)` (les rangs 0 et n-1 sont les extrêmes, invariants de l'opération ; si tous les points sont déjà sur la même coordonnée, `max == min` → no-op).

**Bornes** : aligner nécessite ≥ 2 points sélectionnés (1 seule ancre), répartir ≥ 3 (2 extrêmes + 1 intermédiaire au moins). `updateAlignPanelButtons` (hud.js) grise les 4 actions en conséquence à chaque mutation de sélection (appelé depuis `updateSelectionHud`, même pattern que `updateClipboardButtons`) ; `alignOrDistribute` (editor.js) garde en plus un no-op en profondeur (bornes + points invalides filtrés). Le bouton `#align` lui-même reste toujours actif (il ouvre/ferme le panneau) ; sa classe `.align-panel-open` (ring inset vert, même langage que `#shapes.shapes-panel-open`) est posée par `updateAlignButton` en miroir de `state.alignPanelOpen` (flag transitoire, jamais persisté — comme `shapesPanelOpen`).

**Panneau** : structure calquée sur `#shapesPanel` (positionné sous le bouton par un helper dédié, fermeture au clic extérieur / `Échap` / re-clic sur `#align` via `wireAlignPanel`). Contrairement à `#shapesPanel` (qui se ferme quand on arme un outil), il reste **ouvert après une action** pour permettre d'enchaîner (ex. Aligner X puis Aligner Y) ; masqué en preview comme les autres panneaux (`body.preview-mode #alignPanel`).

**Historique** : chaque action est une entry undo UNIQUE via `replaceShapePatch` before/after (même pattern que `pasteClipboard` / `deleteSelectedPoint`) — seules les coordonnées de `pointList` changent, les `tris` restent intacts (indices valides, fills survivent), donc le patch est compact. L'undo restaure les coordonnées exactes ; la sélection est vidée par l'undo (comportement standard `clearEditingTransientState`).

**Raccourcis** : mêmes gardes que l'ordre des plans (§7.13) — `typing`, `preview` (aucune édition), `!e.ctrlKey` (AltGr = Alt+Ctrl exclu), `!e.repeat` ; `e.shiftKey` distingue répartir (Shift+) d'aligner. Les raccourcis passent par les MÊMES fonctions que les boutons (`alignSelectedPointsX/Y` / `distributeSelectedPointsX/Y`) — un seul chemin de vérité. Couvert par `scripts/smoke-align.mjs`.

### §7.15 Commentaire contextuel dans le HUD (`#actionComment`)

**Motivation** (conseils.md, priorité 1) : la modale d'aide `?` intervient
*après* que l'utilisateur a rencontré une difficulté ; il manque une aide
**au moment de l'action**. L'évolution ajoute un toast contextuel dans le
HUD bas-gauche, **prospectif et piloté par le survol** : il dit à
l'utilisateur **ce qu'il PEUT faire maintenant et comment** — le geste
que l'élément sous le pointeur permet, ou le geste suivant après une
action — au lieu de faire le compte-rendu de l'action passée. Le
feedback pédagogique arrive pendant que le geste est encore frais.

**Définition du message prospectif (contrainte produit)** : le toast ne
dit JAMAIS ce qui vient d'être fait (« Point posé », « Triangle fermé »,
« Annulé », « N points supprimés »… sont interdits). Il exprime
uniquement le prochain geste possible et sa méthode. L'exemple fondateur
: approcher le pointeur d'un côté de triangle mis en surbrillance affiche
« **Clic gauche pour créer un nouveau triangle à partir de ce segment** ».
La correction « clic gauche » (vs clic droit dans la demande initiale)
est volontaire : le message reflète la sémantique RÉELLE de l'app (le
clic gauche branche un triangle sur le segment en mode vertex ; le clic
droit déplace) — un message qui annoncerait un geste inexistant serait de
l'aide mensongère.

**Hiérarchie des sources** (dans `editor.js:updateHoverComment`, appelée
à chaque mousemove après le calcul des `nearest*`, ET depuis la branche
cercle/étoile/anneau/forme de `updateMouseHover` où les overlays de
survol sont coupés) :

| # | Source | Exemple de message |
|---|---|---|
| 1 | Modes de construction (cercle / étoile / anneau / forme) — le clic est entièrement consommé par le geste | « 1er clic gauche : pose le centre du cercle — la molette règle le nombre de côtés » / « 2e clic gauche : valide… » selon la phase (`circleCenterModel`, `starPhase`, `annulusPhase`, `shapeAnchorModel`) |
| 2 | Construction en cours (triangle partiel) — le geste SUIVANT du triangle prime sur tout le reste | « Cliquez pour poser le 2e sommet… » / « …le 3e sommet — il fermera le triangle ». Un tri `p2 = undefined` est TOUJOURS resumable (addPoint le modifie même s'il n'est plus actif) ; `p3 = undefined` ne l'est que s'il est le `activeConstructionTriangle` (sinon le clic serait ignoré — on ne le suggère pas) |
| 3 | Pinceau armé (`brushMode`) — le clic gauche peindra | « Clic gauche pour peindre ce triangle avec la couleur choisie » |
| 4 | Survol d'élément — MÊME ordre de résolution que le clic (processMouseUpSelection) | triangle (mode triangle) > segment (mode segment) > point (« sélectionner ce sommet — clic droit pour le déplacer ») > segment en mode vertex (« **créer un nouveau triangle à partir de ce segment** ») |
| 5 | Zone vide — un post-action en cours finit ses 3 s ; sinon message générique | « Cliquez pour poser le 1er point de votre plan » (scène vide) / « Survolez un segment pour y brancher un nouveau triangle… » (forme fermée) |

Le message de survol **persiste tant que le pointeur est sur l'élément**
(« tant que survolé ») : aucun timer, le survol suivant le remplace. Le
post-action (après une action : undo, suppression, fusion, copier,
création…) reste ~3 s puis laisse place au message de survol ou au
générique — la zone vide le laisse finir (`isActionCommentActive`) au
lieu de l'écraser.

**Placement & style** : `#actionComment` (main.html) est un div absolu en
bas-gauche, au-dessus de la pile HUD `#coords` → `#zoomDisplay` →
`#fpsDisplay` (bottom 122 px), même charte visuelle (monospace, fond
sombre transparent, blur, border). Deux états CSS : invisible par défaut
(`opacity: 0`, `pointer-events: none` — le toast n'intercepte JAMAIS un
clic) ; `.action-comment-visible` = `opacity: 1` avec transition 0.3 s
(fondu). `max-width: 380px` + `white-space: normal` : les messages
prospectifs sont plus longs qu'un simple compte-rendu, le retour à la
ligne évite tout débordement sur les petits écrans. Masqué en preview
(`body.preview-mode #actionComment`), comme tout le HUD.
`aria-live="polite"` pour les lecteurs d'écran.

**API** (hud.js — module sans import de module métier, pas de cycle,
cf. §1.1) :
- `showHoverComment(text)` : message de survol PERSISTANT (aucun timer).
  Incrémente le token de génération pour invalider tout timer de
  post-action en attente (un survol qui remplace un post-action ne doit
  pas être effacé par son timer). Garde de dédup : même texte + classe
  visible + source 'hover' = le toast est déjà à jour (pas de ré-écriture
  DOM à chaque mousemove) ; on ré-affiche quand même si un post-action a
  expiré entre-temps (le survol reprend la main) ou est en cours (le
  survol le remplace — le texte peut être identique, ex. guide de
  construction).
- `showActionComment(text)` : post-action ~3 s. L'élément est rempli, la
  classe posée, puis un timer module-level programme le retrait de la
  classe après `ACTION_COMMENT_DURATION = 3000` ms. `clearTimeout` AVANT
  chaque re-arm : une action rapide remplace le commentaire précédent sans
  jamais le faire clignoter (le nouveau toast reste visible 3 s à partir
  de la dernière action). Un second timer (`ACTION_COMMENT_FADE = 350` ms)
  vide le texte APRÈS le fondu : pas de contenu fantôme invisible (résidu
  lisible par un lecteur d'écran ou un zoom navigateur forçant la
  transparence).
- `isActionCommentActive()` : vrai tant qu'un post-action est affiché —
  `updateHoverComment` lit cette source pour laisser un post-action finir
  ses 3 s quand le pointeur est sur une zone vide.
- `updateHoverComment()` (editor.js) : calcule le message courant via
  `computeHoverComment` (hiérarchie ci-dessus) et le diffuse via
  `showHoverComment` ; `null` (zone vide + post-action en cours) = ne
  rien faire. Appelé depuis `updateMouseHover` après le calcul des
  `nearest*` (derrière la garde de signature : il ne se met à jour que
  quand le survol change) et depuis la branche des modes de construction.

**Token de génération** : chaque appel (hover OU action) incrémente
`actionCommentToken`. Le timer d'un post-action capture le token de SON
appel et ne retire la classe que s'il est toujours le dernier (un survol
intervenu entre-temps l'invalide — sans ça, le timer retirerait la classe
du message de survol qui l'a remplacé). `actionCommentSource`
('hover' | 'action') pilote la garde de dédup et `isActionCommentActive`.
Les timers vivent au niveau module (pas dans `state`) : effets de bord UI
transitoires, jamais persistés — exactement comme la preview ou l'état
armé de la fusion.

**Call sites du post-action** (tous importent `showActionComment` depuis
hud.js — pas de cycle : hud.js ne lit que `state` et les constantes) :

| Module | Actions couvertes | Guidance prospective (extrait) |
|---|---|---|
| `editor.js` | `addPoint` (le message SUIT le geste de construction : push → « Cliquez pour poser le 2e sommet… », modify-p2 → « …le 3e sommet », modify-p3 → « Cliquez sur un segment pour y brancher… », push-new-tri → « …de ce nouveau triangle ») | geste suivant du triangle |
| `editor.js` | `deleteSelectedPoint` / `deleteSelectedSegment` / `deleteSelectedTriangle` | « Ctrl+Z pour annuler — sélectionnez / cliquez sur… » |
| `editor.js` | `copySelection` / `cutSelection` / `pasteClipboard` | « Ctrl+V pour coller… » / « Ctrl+Z pour annuler — la copie collée est sélectionnée, glissez-la… » |
| `editor.js` | `alignOrDistribute` (§7.14) | « Ctrl+Z pour annuler — Alt+→ pour aligner aussi selon Y… » |
| `editor.js` | `rotateSelectedPoints` — au COMMIT du debounce (pas à chaque tick de molette : le timer est réinitialisé par chaque tick, le message ne partirait jamais) | « Molette pour continuer à pivoter — Ctrl+Z » |
| `editor.js` | créations cercle / étoile / anneau / forme prédéfinie | « C pour tracer un autre cercle… » / « Panneau Formes pour une autre étoile… » |
| `editor.js` | `paintTriangleAtCursor` | « Ctrl+Z pour annuler — cliquez sur un autre triangle pour le peindre » |
| `merge.js` | `applyMergeToSelection` (cœur commun fusion classique ET par déplacement) | « Ctrl+Z pour annuler — sélectionnez ≥ 2 points pour une autre fusion » |
| `shapes.js` | `moveShapeUp/Down` (via `moveShape`) + `addShape` (§7.17) | « Ctrl+Z pour annuler — Alt+↑/↓ pour continuer à réordonner » / « Plan vide AVANT/APRÈS le plan courant — cliquez pour poser le 1er point » |
| `history.js` | `undo` / `redo` | « Ctrl+Shift+Z (ou Ctrl+Y) pour rétablir » / « Ctrl+Z pour annuler à nouveau » |
| `io.js` | `saveMesh` / `applyImport` (merge + replace) / `resetAll` | « Ctrl+S pour ré-enregistrer… » / « Ctrl+Z pour annuler l'import… » / « Cliquez pour poser le 1er point de votre nouvelle scène » |

**Non couvert volontairement** : le post-action de sélection simple
(changement de plan actif, clic de sélection) — ce n'est pas une
action qui produit un résultat à commenter, et le bruit noierait le
signal (le survol #4 annonce déjà le clic de sélection avant le geste).
La rotation AltGr globale (`rotateEachShapeAroundPivot`) reste
silencieuse : le HUD `#zoomDisplay` affiche déjà l'angle cumulé, un toast
en plus serait du bruit. Couvert par `scripts/smoke-comment.mjs` (16e
suite — y compris l'exemple fondateur : survol du milieu d'un segment →
« créer un nouveau triangle à partir de ce segment »).

### §7.16 Kiosque de sélection des plans (`#kiosk`, Alt+K)

**Motivation** (EVOLUTIONS.md) : avec plusieurs plans, passer de l'un à
l'autre par la navigation répétitive (`◀`/`▶`) devient pénible ; il
manque une vue d'ensemble qui montre TOUS les plans à la fois et rende
la sélection immédiate. Le kiosque est un mode de sélection dédié :
chaque plan devient une « carte » inclinée autour d'un axe vertical
virtuel (effet cover-flow / kiosque), et la position horizontale du
pointeur fait varier l'inclinaison des cartes pour mettre un plan en
avant — l'analogie du kiosque de sélection de la consigne.

**Mode transitoire** (jamais persisté, même politique que la preview) :
`state.kioskMode` (state.js) + `body.kiosk-mode` (main.html) masque la
chrome (CSS `:has()` groupe par groupe, seule la barre d'outils est
réduite au bouton `#kiosk` flottant — vert actif + `aria-pressed` —,
contrairement à la preview le toast `#actionComment` reste visible pour
guider). Bouton `#kiosk` (groupe shape-nav) + raccourci `Alt+K`
(main.js, gardes typing / AltGr exclu `!e.ctrlKey` / `!e.repeat` ; en
preview le raccourci sort d'abord de la preview — `toggleKiosk` appelle
`exitPreview` —, mutuellement exclusifs). Bouton grisé quand
`state.shapes.length <= 1` (`updateShapeHud` dans hud.js, synchro via
`updateKioskButton`). Contrôle : `viewport.js` `toggleKiosk` /
`exitKiosk` / `applyKioskMode` (reset défensif des gestes en cours,
comme `applyPreviewMode`) / `updateKioskButton` / `wireKioskControl`
(suivi du pattern `#preview` : câblage DÉDIÉ, pas de doublon avec
`wireButton`).

**Rendu** (`draw.js` — branche kiosque dans `drawBoard` qui remplace
TOUTE la scène par les cartes : ni grille, ni axes, ni points de
contrôle, fond canvas normal ; plus un guide vertical pointillé vert
`KIOSK_GUIDE_COLOR` dans `renderTransient` matérialisant l'axe piloté
par le pointeur) :
`computeKioskLayout` calcule le layout partagé entre le rendu et le
focus/sélection : chaque carte `i` a `dx = i - focus` (écart au plan
mis en avant), `tilt = clamp(dx × KIOSK_TILT_RAD_PER_STEP, ±KIOSK_MAX_TILT_RAD)`
(45° par carte d'écart — `KIOSK_TILT_RAD_PER_STEP = π/4` —, plafond
~66°), `scale = min + (1-min)·exp(-|dx|/falloff)`
(gaussienne, plancher `KIOSK_MIN_SCALE = 0.4`), `y` surélevé des cartes
lointaines (`KIOSK_MAX_PARALLAX_Y = 18` px).
`kioskFocus()` = le focus CONTINU piloté par l'abscisse du pointeur
via la règle linéaire `t·(n-1)` (`t = clamp(x/w, 0, 1)` : bords du
canvas => premier/dernier plan mis en avant) — le pointeur « fait
varier l'inclinaison des plans et met un plan en valeur », comme
demandé. Cette règle (`kioskFocusAt`) est PARTAGÉE avec la sélection au
clic (`kioskSelectedIndex`) : l'affichage et le clic ne peuvent
diverger (cf. « Sélection au clic » ci-dessous). `drawKiosk` rend les cartes par ordre de `|dx|` croissant
(le plan en avant passe PAR-DESSUS ses voisins — chevauchement simulé),
sans tranche d'épaisseur (la bande sombre du faux-3D a été retirée :
plans plats, la perspective trapèze suffit — cf. EVOLUTIONS). AUCUN
cadre ni anneau : le plan mis en évidence ne se
distingue que par son nom vert « Plan n » (texte simple GROS
`KIOSK_LABEL_FONT = bold 18px`, sans pastille) affiché sous sa carte et
sa pleine opacité (les autres sont dimmés). Le passage d'un plan à un
autre est un FONDU ENCHAÎNÉ (dissolution) : dans la fenêtre |dx| ≤ 1,
l'opacité interpole LINÉAIREMENT entre le focus (1) et le niveau de
repos d'un voisin `KIOSK_NEIGHBOR_ALPHA = 0.45` — le plan qui sort
s'éteint pendant que le suivant s'allume (avant, le voisin restait à
~0.8 d'opacité et le basculement n'était porté que par le nom/trait :
sensation directe) ; au-delà, la courbe exponentielle
(`KIOSK_DIM_MIN_ALPHA = 0.3` + `(KIOSK_NEIGHBOR_ALPHA - min) ·
exp(-(|dx|-1)/KIOSK_DIM_FALLOFF = 3)`) poursuit, continue en |dx| = 1
— `prom = max(0, 1-|dx|)`, `alpha = prom + (1-prom)·rest` — et le nom
s'affiche en FONDU CROISÉ (alpha = prom) sur les deux cartes voisines
du focus : l'ancien nom s'efface pendant que le nouveau apparaît. Une
ligne-guide verte
souligne le focus. **La face de chaque carte est
dessinée en vraie PROJECTION PERSPECTIVE** (`projectKioskPoint`, un
point local `(u, v) ∈ [-1, 1]²` pivoté de `tilt` autour de l'axe
vertical central puis projeté depuis `KIOSK_PERSPECTIVE_D = 2.5`
demi-largeurs de carte : `s = D/(D - u·sin(tilt))`) — le bord qui
s'approche du spectateur est AGRANDI, l'opposé RÉTRÉCI, et les bords
verticaux restent verticaux (effet trapèze, l'impression d'un plan
incliné de 45°), au lieu de la compression orthographique
`scale(cos tilt, 1)` d'origine qui « aplatissait » sans donner de
relief. Les triangles du plan sont projetés sommet par sommet (la
perspective n'est pas affine : un scale global ne suffit pas), le nom
« Plan n » (uniquement pour le plan mis en évidence, texte vert simple
sans pastille, centré sur le milieu de l'empreinte projetée) passe sous
le bas du bord proche agrandi. `cardFootprint` reste le contrat partagé
rendu/layout (les bords u = ±1 projetés) : le recentrage anti-clipping
du layout et la face dessinée partagent la même géométrie.
Les cartes sont dimensionnées pour tenir dans l'écran dans LES DEUX
dimensions : `cardDims` borne la largeur à `cssBoardW ×
KIOSK_CARD_W_RATIO = 0.55 × scale` (un plan très allongé — aspect
plafonné 2.8 — ferait sinon une carte plus large que le canvas : le
fit ne protège que la géométrie DANS la carte, pas la carte elle-même) ;
la hauteur est réduite en conséquence pour préserver l'aspect.
`computeKioskLayout` RECENTRE chaque carte sur son slot : le MILIEU de
son empreinte projetée (et non son centre géométrique, décalé par
l'asymétrie perspective) occupe `w/2 + dx·spacing`, puis CLAMPE la
carte dans l'écran (un slot peut sortir du canvas quand le focus est
près d'un bord) — sans cela les cartes extrêmes (fortement inclinées)
débordent de l'écran côté bord proche ; l'espacement max a été resserré
en conséquence (`KIOSK_CARD_SPACING_RATIO = 0.35`).

**Entrées** (main.js) : le clic gauche sélectionne le plan MIS EN
AVANT via `kioskSelectedIndex(x)` (même règle linéaire que l'affichage,
évaluée à l'abscisse du clic), `goToShape(idx)` puis `exitKiosk()` =
sélection + sortie immédiate (consigne utilisateur) ; clic droit =
annule sans changement ; clic milieu consommé (pas de pan). `Échap` sort sans changement (main.js, garde
`state.kioskMode`). Le pointeur pilote le tilt via
`resolveMouseMoveOnBoard` (editor.js : branche kiosque =
`lastMousePos` + `requestDraw`, aucun hit-test d'édition). Toutes les
autres entrées sont coupées en kiosque : `updateMouseHover`
(editor.js, garde `previewMode || kioskMode`), la molette (viewport.js,
garde `kioskMode` → pas de zoom ni de cercle), le clavier d'édition.

**Sélection au clic = le plan mis en avant (règle anti-régression)** :
`kioskSelectedIndex(x)` n'effectue AUCUN hit-test d'empreinte — le clic
sélectionne le plan mis en avant (le focus arrondi), calculé avec la
MÊME règle linéaire que l'affichage (`kioskFocusAt`, partagée avec
`kioskFocus`). L'affichage et le clic ne peuvent donc pas diverger : si
le pointeur n'est pas au-dessus de la carte mise en avant (marges,
interstices), un clic ne peut PAS déclencher un plan précédent/suivant
(régression des anciens hit-tests « centre le plus proche » puis
« ordre de profondeur des empreintes », qui divergeaient du focus
affiche). Couvert par `smoke-kiosk.mjs` : 9 plans — clic à 0.375 ×
largeur dans le chevauchement → plan 4/9 (le mis en avant) ; clic à
0.09 × largeur dans la marge gauche, AUCUNE carte sous le pointeur →
plan 2/9 (le mis en avant, jamais le plan 1).

**Post-action HUD** : `showActionComment` à l'entrée (« Survolez les
plans : le pointeur fait varier l'inclinaison — cliquez pour sélectionner
le plan mis en avant, Échap pour annuler ») et à la sortie (« ◀ ▶ pour
naviguer entre les plans — Alt+↑/↓ pour l'ordre des plans ») — les deux
côtés du mode sont prospectifs. Couvert par `scripts/smoke-kiosk.mjs`
(17e suite : ouverture bouton + Alt+K, garde ≤ 1 plan, focus piloté par
le pointeur, clic → `goToShape` + sortie, Échap sans changement).

### §7.17 Insertion d'un plan avant / après le plan courant (`#newShape`, clic gauche / droit)

(évolution « ajouter un nouveau plan se fait en l'intercalant soit avant
le plan courant (clic gauche) soit après le plan courant (clic droit) »)

**Sémantique** : le bouton `+` (`#newShape`, groupe shape-nav) crée un
plan vide RELATIF au plan courant — **clic gauche = AVANT** (le nouveau
plan prend l'index du plan courant, qui recule d'un rang) ; **clic droit
= APRÈS** (index courant + 1). Dans les deux cas le nouveau plan devient
le plan actif (le compteur `#shapeLabel` montre sa position `i/N`).
L'ancien append en fin de tableau est remplacé par cette insertion
relative — avec un seul plan, gauche = index 0, droit = index 1, les
deux gestes restent valides (pas de bornes).

**Câblage** (main.js) : pas de `wireButton` (qui ne gère que le clic
gauche) — un listener `click` (garde `e.button !== 0`) appelle
`addShape('before')`, et un listener `contextmenu` dédié (avec
`preventDefault` : le listener global du document ne protège que le
board, sinon le menu natif du navigateur s'ouvrirait) appelle
`addShape('after')`. Le `title` du bouton porte le geste complet et
l'aria-label en est dérivé (`updateAccessibilityLabels`, hud.js).

**`addShape(position = 'after')`** (shapes.js) : index d'insertion
`position === 'before' ? activeShapeIndex : activeShapeIndex + 1`, puis
`splice` au lieu de `push`. Historique : mêmes patches delta que
l'ancien append — `shapeArrayPatch(newIndex, null, newShape)` +
`activeShapeIndexPatch(fromIndex, newIndex)` — avec `from === to` dans
le cas before (l'undo remet l'index actif sur le plan courant retrouvé à
la même position). **`saveState` est appelé APRÈS le splice** (contrat
§8.5 : le fallback snapshot rejoue l'inverse des patches sur l'état
post-mutation pour reconstruire le pré-mutation). L'ancien pattern
(`saveState` avant la mutation) ne valait que pour l'append en fin de
tableau, où l'inverse `splice(index = length, 1)` était un no-op ; avec
une insertion relative, il retirait un plan RÉEL du clone — undo corrompu
sur petites scènes (≤ ~4 pts/tris, scène vide incluse).

Le nouveau plan est activé par `activateShape`, helper extrait de
`goToShape` : l'insertion AVANT garde le même index numérique que le
plan courant, la garde `newIndex === state.activeShapeIndex` de
`goToShape` (no-op de navigation) sauterait donc tout le nettoyage
transitoire (sélection de l'ancien plan, hover, construction en cours)
— `activateShape` est partagé par les deux chemins.

**Guidance (§7.15)** : le post-action `showActionComment` précise la
position (« Plan vide AVANT/APRÈS le plan courant — cliquez pour poser
le 1er point »). Couvert par `scripts/smoke-shapeorder.mjs` (section
plans vides : clic gauche → 1/2, clic droit → 2/3, undo des
insertions, suppression multi-plan + undo sans doublon).

### §7.18 Mode d'affichage en édition : toutes couleurs (`#showAllFills`)

(évolution « bouton pour choisir le mode d'affichage en édition »)

**Problème** : en édition, seul le plan actif est rempli — les
couleurs de triangles des AUTRES plans ne se voient pas sans passer
par la preview plans (§2.6), qui coupe toute édition. Le mode
« toutes couleurs » rend TOUS les plans remplis de leurs couleurs de
triangles PENDANT l'édition, pour contrôler l'harmonie des couleurs de
la scène complète en travaillant.

**Sémantique** : `state.showAllFills` (bool) = mode d'affichage en
édition, cycle standard → toutes couleurs → standard par le bouton
`#showAllFills` (groupe Canvas ops, juste après `#preview`). C'est un
MODE D'AFFICHAGE PUR : l'édition est strictement inchangée
(selection, hover, clics — seuls les pixels changent). Aucun
raccourci clavier (comme le réticule — toggle de vue au clic).

**Rendu** (draw.js) : `drawShapes` a une branche `showAllFills`
(dessinée après la preview plans, avant le rendu standard). Les plans
INACTIFS sont rendus dans l'ordre du tableau (z-order entre eux
préservé, le plus haut recouvre les précédents) avec le 3e paramètre
`forceFill` de `drawShape` — qui force le remplissage (lignes
pointillées + points atténués conservés) ; le plan ACTIF est dessiné
EN DERNIER, par-dessus : il garde SON rendu actif complet (lignes
pleines + points actifs) et reste la cible d'édition visible même
quand un plan postérieur le chevauche (remplissage opaque — à la
différence de la preview plans où l'ordre strict du tableau prime).
Règle de couleur inchangée : `t.fill` ou le défaut
`COLOR_TRIANGLE_FILL_ACTIVE`. En preview SIMPLE (pas « plans »),
`drawShapes` est aussi appelé : le mode continue de s'appliquer
tranquillement (les fills de tous les plans restent visibles) — le
bouton, lui, est masqué par la chrome. En preview PLANS, la branche
`previewPlans` de `drawShapes` sort avant (`return`), le mode ne
s'applique pas.

**Préférence persistée** : `meshesDesigner.showAllFills`
(`ALL_FILLS_STORAGE_KEY`, constants.js) — même statut que le
réticule : clé dédiée hors wire format, restaurée au boot par
`restoreAllFills` (viewport.js), jamais dirty, jamais serialisée.

**Câblage** (viewport.js) : `toggleAllFills` (bascule + bouton + draw
+ persistance en écriture directe), `restoreAllFills`, `wireAllFillsControl`
(déclaré au boot dans main.js). État du bouton par `updateAllFillsButton`
(hud.js) : classe `.all-fills-active` (même langage vert accent que
`#fps.fps-active`) + `aria-pressed`. Chrome masquée en preview par les
selectors `:has()` du groupe Canvas ops (le bouton disparaît avec la
preview, comme `#preview` lui-même).

**Couvert par** `scripts/smoke-allfills.mjs` (18e suite) : scène de 2
plans injectée (fills distincts) — standard (actif rempli / inactif
non rempli), toggle (inactif rempli de SA couleur, actif inchangé),
retour au standard, persistance de la clé + restore au boot, masquage
en preview et retour à la sortie.

---

## §8. Pile d'historique avec stockage delta

### §8.1 Motivation

L'implémentation historique de `history.js` utilisait un **deep clone
complet** de `state.shapes` à chaque `saveState()` : pour N points et
M triangles sur K plans, chaque entry de la pile pèse ≈
`K × (N + M) × ~80 B` (overhead JS object + 2-4 floats typiques)
plafonnée à `MAX_HISTORY = 50` (cf. `constants.js`). Sur une session
de peinture typique (« on dessine, on drag, on dessine encore »),
l'utilisateur génère ~50 entrées — pour un mesh moyen (33 pts, 36
tris), ça représente ~280 KB de clones complets en mémoire à tout
instant, peu importe que la majorité des entrées diffèrent de la
précédente par le déplacement de 1 sommet.

**L'observation** : la plupart des opérations undo concernent un
**petit sous-ensemble** de la scène :

- Grab / drag d'un sommet : 1 à N points déplacés (souvent 1).
- Rotation AltGr d'une sélection : N points tournés autour d'un pivot.
- AddPoint : 1 point + 1 tri modifié.
- applyColorToSelectedTriangles : N fills modifiés.
- addShape / performDeleteShape : 1 plan inséré/retiré.

Cloisonner la mémoire à cette sous-partie via un **delta** plutôt
qu'à la scène entière est le gain mémoire escompté. Pour 50 drags
d'un seul sommet sur mesh-wail : 50 × 32 B = 1.6 KB vs 280 KB
snapshot — gain ~175×.

### §8.2 Format d'entry (delta + fallback snapshot)

Chaque entry sur `state.historyStack` (ou `state.redoStack`) est :

```js
// Format delta (preferred)
{
  activeShapeIndex: <number>,
  patches: [
    { kind: 'movePoints',
      before: [{ s, i, x, y }, ...],
      after:  [{ s, i, x, y }, ...] },
    { kind: 'insertPoint',
      shapeIdx, lastTriIndexBefore, lastTriBefore,
      lastTriIndexAfter, lastTriAfter, insertedPoint },
    { kind: 'replaceShape',
      shapeIdx,
      pointListBefore, trisBefore,
      pointListAfter, trisAfter },
    { kind: 'setFills',
      before: [{ s, t, fill }, ...],
      after:  [{ s, t, fill }, ...] },
    { kind: 'shapeArray',
      shapeIndex, before, after },
    { kind: 'activeShapeIndex', from, to },
  ],
}

// Format snapshot (fallback ou chemin legacy)
{
  activeShapeIndex,
  snapshotShapes: cloneSceneSnapshot(state.shapes),
}

// Discrimination : entry.patches OU entry.snapshotShapes (constante
// au runtime dans applyEntry, history.js).
```

Le format choisi est **forward + reverse par patch** : chaque patch
porte `before` et `after` simultanément plutôt qu'une direction unique.
Conséquence :
- `saveState` peut être appelé à n'importe quel moment du geste.
- `undo` applique `before` (inverse), `redo` applique `after` (forward).
- Pas de calcul d'inverse runtime — les deux extrémités sont déjà
  matérialisées dans le patch. Coût mémoire : 2× celui d'un
  single-side, mais c'est borné (la carte modifiée n'est pas
  toute la scène) — voir tableau §8.4.

### §8.3 Patch kinds et leur domaine

| Patch           | Domaines mutés                                     | Champs principaux                                           |
|-----------------|----------------------------------------------------|-------------------------------------------------------------|
| `movePoints`    | coords des points `state.shapes[s].pointList[i]`    | `before`/`after` = `[{s, i, x, y}, ...]`                  |
| `insertPoint`   | push 1 entrée pointList + update/append last tri    | `lastTriIndexBefore/After`, `lastTriBefore/After`, `insertedPoint` |
| `replaceShape`  | remplace pointList + tris d'1 seul shape             | `pointListBefore/After`, `trisBefore/After`                 |
| `setFills`      | fill de N tris (set / clear)                        | `before`/`after` = `[{s, t, fill}, ...]`                   |
| `shapeArray`    | insert / remove / replace un plan                  | `before` (plan à l'index avant) ou `null` (insert), `after` idem |
| `activeShapeIndex` | index du plan actif                         | `from`, `to`                                              |

Convention de direction :
- `movePoints` / `setFills` / `activeShapeIndex` : `forward` =
  appliquer `after`, `inverse` = appliquer `before`.
- `insertPoint` : `forward` = push point + apply lastTriAfter,
  `inverse` = pop point + apply lastTriBefore.
- `replaceShape` : `forward` = apply `pointListAfter`/`trisAfter`,
  `inverse` = apply `pointListBefore`/`trisBefore`.
- `shapeArray` : triplet `before`/`shapeIndex`/`after` selon
  (`before=shape, after=null` = remove ; `before=null, after=shape`
  = insert ; `before, after=shapes` = replace).

### §8.4 Patch memory footprint vs snapshot baseline

Heuristique de coût mémoire estimée (par entry) :

| Patch kind            | Coût typique (par entry)                  | Cas pathologique            |
|-----------------------|-------------------------------------------|-----------------------------|
| `movePoints`          | `n × 32 B` (n = nb points déplacés)       | mutation AltGr globale = O(total points) |
| `insertPoint`         | ~ 80 B (1 coord + 2 lastTri)              | —                           |
| `replaceShape`        | `2 × (pointList + tris) × 24 B` (1 shape) | full shape if mono-scène     |
| `setFills`            | `N × 24 B` (N = nb tris modifiés)         | —                           |
| `shapeArray`          | ~ 200 B (le shape complet cloné)          | —                           |
| `activeShapeIndex`    | 8 B                                       | —                           |
| full snapshot         | `Σ (pointList + tris) × 24 B` (toute la scène) | toujours O(scene)        |

**Comparaison qualitative** :

- Pour un `movePoints` sur 1-5 points : 160-800 B vs 5-6 KB full
  snapshot (mesh-wail) → **gain 7-30×**.
- Pour AltGr rotation global (100 points déplacés) :
  3.2 KB vs 5-6 KB → **gain ~2×**.
- Pour un `replaceShape` sur une scène mono-shape : ~10 KB vs 5 KB
  full → **régression 2×** (covered par snapshot fallback §8.5).
- Pour un `replaceShape` sur scelle multi-shape (5 plans,
  suppression sur 1) : 10 KB vs 25 KB → **gain ~2.5×**.
- Pour un `insertPoint` : 80 B vs 5-6 KB → **gain ~70×**.

### §8.5 Snapshot fallback et seuil de bascule

Le helper `shouldUseSnapshot(patches, shapes)` dans `history.js`
estime la taille cumulée des patches et la compare à `2 ×
snapshotByteSize(shapes)`. Si les patches dépassent ce seuil, on
bascule en snapshot complet (`snapshotShapes`).

Justification du seuil `×2` :
- Un snapshot complet est **structurellement simple** (1 seul
  tableau de refs, avant en lui-même fait déjà la moitié du snapshot
  avec ses paires `{x, y}` adjacentes pour les points). Sa taille
  overhead est comparable à la somme `pointList + tris` × 24 B.
- Un delta coûte naturellement 2× (avant + après). Tant qu'il
  ne dépasse pas grossièrement 2× le snapshot, il reste un gain
  net (deux représentations symétriques plus simples à cloner /
  comparer qu'une seule grosse structure indexée hiérarchiquement).

Cas concret où le seuil déclenche :
- `replaceShape` sur scène mono-shape avec ≥ 1 point / tri :
  `2 × (pointList + tris) × 24 B > 2 × (pointList + tris) × 24 B`
  → bascule en snapshot (égalité stricte déclenche, gain marginal
  mais parité avec ancien comportement).
- `movePoints` couvrant > 50 % des points du scene total :
  bascule en snapshot (rare : AltGr globale sur petites scènes).

**L'entry snapshot stocke l'état PRÉ-mutation (fix undo)** : les
call sites patche-courants appellent `saveState` APRÈS la mutation,
et `applyEntry('inverse')` d'une entry snapshot restaure
`snapshotShapes` tel quel. Un fallback naïf (clone de lascène courante, c.-à-d. post-mutation) rendait donc l'undo no-op pour
TOUTES les suppressions / fusions / rotations sur petites scènes
mono-shape (le cas le plus courant). `saveState` reconstruit désormais
la scène pré-mutation via `snapshotBeforeState` (history.js) : un
clone de la scène courante sur lequel on rejoue l'inverse des patches
(les applicateurs ne touchent que `state.shapes` + `activeShapeIndex`,
restaurés). Exception : les patches `insertPoint` (addPoint) sont
laissés de côté — addPoint appelle `saveState` AVANT la mutation, la
scène courante EST déjà l'état pré-mutation, et rejouer l'inverse
dessus détruirait un point/tri pré-existant. Le redo reste correct
sans changement : `transferEntry` re-capture la scène courante au
moment de l'undo (= état post-mutation) comme cible du redo.

**Corollaire saveState-before (anti-régression)** : tout call site qui
appelle `saveState` AVANT une mutation `shapeArray` corrompt le
snapshot — l'inverse du patch est rejoué sur l'état pré-mutation et
retire/ré-insert un plan RÉEL du clone. C'était un no-op accidentel
pour l'ancien append d'`addShape` (inverse `splice(index = length, 1)`
sans effet) mais pas pour une insertion relative (§7.17) ni pour le
remove de `performDeleteShape` (ré-insertion = doublon). Les deux
appellent désormais `saveState` APRÈS la mutation (l'index actif n'est
pas encore muté → `entry.activeShapeIndex` reste l'index pré-mutation).

### §8.6 Pattern deferred fill (geste long)

Les gestes longs (grab, rotations wheel) ne connaissent pas l'**état
final post-mutation** au moment où la première tick est détectée :
l'utilisateur n'a pas encore relâché. Pour ne pas capturer inutilement
le snapshot complet juste pour le commit, le pattern **deferred fill**
permet de pousser un patch dont le slot `after` est résolu depuis le
live state au moment du commit :

```js
// Capture BEFORE à la première tick du geste :
state._pendingGrabPatch = movePointsPatch(
  startCoordsOfAllGrabbedItems,  // [{s, i, x, y}, ...]
  null,  // after = null = "à remplir"
)
// ... mutations live pendant le drag ...

// Commit au relâchement / fin de debounce :
saveState({ patches: [state._pendingGrabPatch] })
//        ^^^ saveState résout `after = live` via resolveDeferredAfter
```

`history.js resolveDeferredAfter` itère les patches et, pour tout
`movePoints` avec `after === null`, lit le live state de chaque
`(s, i)` et remplit `after`. Pas de re-clone complet, juste une
lecture O(N) au commit.

**Champ state associé** : `state._pendingGrabPatch`,
`state._pendingEachShapeRotatePatch`, `state._pendingSelectedRotatePatch` —
champs nullables réinitialisés dans `clearEditingTransientState` pour
qu'un geste interrompu (Ctrl+Z mid-rotation, etc.) ne laisse pas un
patch orphelin qui se commit incorrectement au geste suivant.

### §8.7 Granularité des entrées et coalescing implicite

La granularité de l'historique est calée sur les **gestes longs**, pas
sur les ticks individuels :

- Grab : un seul `saveState` au premier tick significatif (≥ 5 px),
  via le flag `state.grabHistorySaved`. Pas d'entrée par pixel
  déplacé.
- Rotation AltGr : un seul `saveState` pour la durée du geste
  (~ 400 ms de debounce entre ticks). Pas d'entrée par tick.
- Rotation sélection molette : idem.
- Clic addPoint / delete / color : un saveState par action, déjà
  naturellement granulaire.

Le coalescing n'est donc pas une optimisation à rajouter : il est
déjà implicite via les flags `grabHistorySaved` / `isWheelRotating` /
`isEachShapeRotating` qui distinguent « nouvelle entrée » de « suite
du même geste ». Le delta ne change pas cette sémantique, il
diminue simplement le coût mémoire par entrée.

### §8.8 Call sites (rappel exhaustive)

13 sites `saveState` au total. Mapping vers patch :

| Site (fichier:ligne, fonction)                              | Patch appliqué                              |
|-------------------------------------------------------------|---------------------------------------------|
| `editor.js:addPoint`                                        | `insertPointPatch`                          |
| `editor.js:deleteSelectedPoint`                             | `replaceShapePatch` (1 shape)               |
| `editor.js:deleteSelectedSegment`                           | `replaceShapePatch` (1 shape)               |
| `editor.js:deleteSelectedTriangle`                          | `replaceShapePatch` (1 shape)               |
| `editor.js:resolveMouseMoveOnBoard` (1ʳᵉ tick grab)        | `movePointsPatch` (deferred fill)           |
| `editor.js:rotateEachShapeAroundPivot` (AltGr wheel)        | `movePointsPatch` (deferred, multi-shape)   |
| `editor.js:rotateSelectedPoints` (wheel sélection)          | `movePointsPatch` (deferred, sélection seulement) |
| `editor.js:applyColorToSelectedTriangles`                   | `setFillsPatch`                             |
| `shapes.js:addShape`                                        | `shapeArrayPatch` + `activeShapeIndexPatch` |
| `shapes.js:performDeleteShape`                              | `shapeArrayPatch` (remove ou replace) + `activeShapeIndexPatch` |
| `merge.js:mergeSelectedPoints`                              | `replaceShapePatch` (1 shape, mais avec reindex complet) |
| `editor.js:pasteClipboard`                                   | `replaceShapePatch` (1 shape)               |
| `editor.js:alignOrDistribute` (align/répartir §7.14)         | `replaceShapePatch` (1 shape)               |

### §8.9 API publique inchangée

`saveState`/`undo`/`redo`/`cloneScene` restent les exports publics
de `history.js`. Backward-compat :
- `saveState()` sans argument → snapshot (comportement legacy, pour
  les chemins qui n'ont pas encore migré).
- `saveState({ patches })` → delta avec auto-fill deferred.
- `cloneScene` reste exporté (utilisable par patches `replaceShape`
  en interne OU pour des tests).

---

## §9. Conventions diverses

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
- **Validation syntaxique** : depuis Node 24 (LTS du poste), un simple `node --check` suffit — la détection du type de module est automatique. De Node 18 à 22 il fallait `--experimental-default-type=module` (flag disparu de Node 24) pour ne pas traiter les `.js` en ES modules comme du CommonJS.
- **Import meshes** : le bouton dédié passe par `convert.js` ; un triangle complet est valide dès deux séparateurs `;` (trois sommets). Les reliquats partiels restent représentables par le parseur texte, mais sont filtrés à la frontière IO et ne sont pas hydratés dans la scène. Le hit-testing de hover, clic gauche et clic droit utilise la même cible accrochée à la grille lorsque celle-ci est active.
