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

**Schéma canonique des formes (post-refactor `modifyShapeModel-spec` §0–§5)** :
`state.shapes[i]` = `{ pointList: [{x,y}, …], tris: [{p1,p2,p3 (indices)}, …] }`.
Le `pointList` est la **liste canonique des sommets** d'une forme ; tous
les `tris[k].pX` sont des indices dans ce tableau. Aucun partage
cross-shape — chaque forme a son propre `pointList` (Q1a §modify-shape-
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
- **AltGr + clic droit + drag** : déplace **toutes** les formes ensemble
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
le déplacement de toutes les formes.

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
  pointList de la forme active des slots `tris.pX` des triangles qui le
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
`#sceneStatus` indique `modifiée` après une mutation de géométrie, de forme ou de
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
vérifier en permanence les invariants suivants sur chaque forme.
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
le `pointList` de la forme active (`state.shapes[activeShapeIndex].pointList[idx]`).
Le helper `getVertexIndex(p)` de `geometry.js` implémente la résolution
via `activeShapePointList().findIndex(v => adjacentPoints(v, p, 0.01))` —
corollairement, l'invariant I3 (pas de doublons au sens §3.2 tolérance
0.01) garantit un index unique par coord : un `findIndex` est ici
suffisant pour mapper un point écran vers son slot canonique.

La convention est dev-friendly : `pointList[0]` est le 1er sommet de
la forme active — alignement JS array natif qui rend la lecture debug
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
  directement (le `pointList` de la forme active, pas de raccourci
  helper — le code accède à la slice via `state.shapes[…].pointList` à
  chaque call site) et retourne
  `findIndex(v => adjacentPoints(v, p, 0.01))` → -1 si absent
  (defense). `findIndex` est suffisant grace a l'invariant I3 (un
  seul slot par coord, cf. §5.3) — pas de dedup a faire.
- Fallback `'?'` côté caller (`editor.js:updateMouseHover`) si la
  défense retourne -1. Ce cas ne devrait jamais survenir dans le call
  site normal puisque `findNearestPoint` garantit que le point rendu
  existe dans le `pointList` de la forme active (invariants I1+I2 de §5.3).

**Relation aux autres features** :
- §7.4 montre "où" (cercle vert 5 px sur le sommet le + proche), §7.8
  montre "qui" (label d'identité stable). Sans §7.8, deux sommets à
  coordonnées identiques en mode cluster (§3.2) sont indistinguables.
- L'alerte triangle rouge §7.7 (retirée dans le chore du même nom)
  précédait cette feature en comblant le même besoin UX (identifier
  les stacks). §7.8 + §7.9 reprennent ce role sans le surlignage
  strident.

### §7.9 Liste des slots triangles partageant la position survee

Quand le sommet surve a plusieurs refs (cluster §3.2 ou topologie de
mesh dense), `drawStackList(p, refs)` rend une **pill 2-lignes** sous le
label §7.8 listant les `(triangleIndex, slotId)` adjacents.

**Géométrie** :
- Header ligne 1 : `stack (N)` en `#FFD700` (golden) sur fond opaque
  `rgba(0,0,0,0.7)`. N = nombre de slots triangles à cette position.
- Body ligne 2 : `T0.p1, T2.p3, ...` en `#FFFFFF` (blanc), séparés par
  virgule + espace. Format `{triangleIndex}.{slotId}` (slotId = `p1`,
  `p2` ou `p3`).
- Font 10 px monospace, padding 6 px horizontal, height 14 px par ligne
  + 4 px padding vertical.
- Position `OFFSET_Y = +32` — sous §7.8 (offset +14) sans overlap
  visuel.

**Affichage conditionnel** : la pill n'est rendue que si `refs.length > 1`.
Un seul slot adjacent ne déclenche pas §7.9 (ce serait redondant avec
le label §7.8 qui suffit à identifier le sommet). Filtre `if (stackRefs.length > 1)`
dans `editor.js:updateMouseHover` (call site hover).

**Implémentation** :
- Helper `getStackTriangleRefs(p, tolerance = 0.01)` de `geometry.js`
  (commit `05cabe3 feat(geometry): §7.x helpers`). Itère
  `activeTriangles()` (alias court pour
  `state.shapes[activeShapeIndex].tris`, helper exporté par
  `geometry.js`) et pousse pour chaque triangle la liste des slots
  (`p1`/`p2`/`p3`) dont `adjacentPoints(pointList[slot], p, tolerance)`
  est vrai — la résolution coords passe par l'index du slot dans le
  `pointList` (cf. §3.4 runtime indexe).
- Tolerance par défaut 0.01 unité modèle (cohérent avec §3.2 cluster
  semantics et §4.1 delete). Paramétrable pour tests spécifiques.

**Cas d'usage** :
- Topologie normale (deux triangles partageant un sommet) : 1 slot
  adjacent → §7.9 ne s'affiche PAS (filtre `> 1`).
- Cluster intentionnel (`getPointsAtSamePosition(p).length > 1`, §3.2) :
  N>1 → §7.9 liste les slots triangles.
- Stress-test ou import avec doublons accidentels : N visible permet de
  détecter rapidement la multiplicité sans ouvrir devtools.

**Edge case (filet défensif non appliqué)** : `getStackTriangleRefs`
peut retourner plusieurs entrées pour le même `triangleIndex` si 2+
slots du même triangle sont adjacents au point (cas dégénéré topologique).
Une dedup par référence (`!refs.some(r => r.ref === entry.ref)`)
serait plus robuste mais n'est pas appliquée (dette technique
consignée ; nit reviewer du commit `2c586fa`). Le slotId est
identifié via la position de l'index dans le tableau `tris[k]` :
`triangle.tris[k].p1` → slotId `"p1"`, etc. — le format affiche
`{triangleIndex}.{slotId}` (cf. spec §3.10).

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
- **Validation syntaxique** : utiliser `node --experimental-default-type=module --check` sur chaque fichier `.js` ; un simple `node --check` traite ces fichiers comme CommonJS et produit une fausse erreur sur `import`.
- **Import meshes** : le bouton dédié passe par `convert.js` ; un triangle complet est valide dès deux séparateurs `;` (trois sommets). Les reliquats partiels restent représentables par le parseur texte, mais sont filtrés à la frontière IO et ne sont pas hydratés dans la scène. Le hit-testing de hover, clic gauche et clic droit utilise la même cible accrochée à la grille lorsque celle-ci est active.
