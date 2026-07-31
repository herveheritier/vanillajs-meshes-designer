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

## §1.3 Modes d’édition explicites

`state.editingMode` expose trois contrats de clic persistés dans
`meshesDesigner.editingMode`, avec **`edition` comme valeur par défaut** :

- **`edition`** : mode fluide de création, sélection et déplacement. Un clic
  gauche simple conserve le geste de création/sélection ; un clic gauche-glissé
  délimite uniquement un lasso. Un clic droit simple sélectionne uniquement
  l'entité la plus proche selon `state.selectionMode` et désélectionne les
  autres ; un clic droit + drag déplace toute la sélection depuis n'importe
  quel point du canvas. S'il n'y a pas de sélection, le clic droit conserve le
  grab direct de la cible sous le curseur.
- **`construction`** : un clic dans le vide crée ou complète un triangle ; un
  clic sur une entité existante ne modifie pas la sélection et le déplacement
  n'est pas activé.
- **`selection`** : un clic dans le vide ne crée jamais de géométrie ; la
  sélection et le déplacement se font selon `state.selectionMode`.

Le bouton `#editMode` et le raccourci `E` cyclent `edition → construction →
selection`. Le bouton porte directement le libellé court du mode actif (`É`, `C`
ou `S`) et son intitulé accessible décrit le cycle complet. Les actions de suppression, fusion et sélection
globale sont disponibles dans `edition` et `selection`, mais restent bloquées
en `construction`.

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
| **vertex**  | Point le + proche dans un rayon de `POINT_HIT_RADIUS_PX` pixels écran | Cluster de refs partageant cette position                         |
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
ajoutés. En mode `vertex`, le cluster de références partageant la position est
ajouté sans doublon.

Implémentation : `processMouseUpSelection` reçoit uniquement le geste gauche
et neutralise Ctrl/Cmd pour les appels de sélection ; le geste
`Ctrl/Cmd + clic droit` passe par `selectAtRightClick` dans `editor.js`, puis
`beginGrabbing` retourne immédiatement sans armer `ACTION_GRABBING`.

Le helper `applySelectionModifiers(pointsAtPos, e, ctrlToggles)` reste la
source commune des règles Shift / ajout idempotent. Le Shift gauche conserve
le toggle de sélection ; le Ctrl/Cmd gauche n'est plus un geste d'ajout.
Sur espace vide, le clic gauche en mode `edition` conserve la création fluide
préexistante ; le clic droit simple efface la sélection s'il ne trouve aucune
entité. Le mode `construction` reste le geste dédié à la création seule.

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
