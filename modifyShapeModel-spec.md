# `modifyShapeModel` — Spec

> **Branche** : `feature/modifyShapeModel`
> **Objectif** : aligner `state.shapes[*]` sur le schéma `{ pointList, tris }`
> déjà utilisé par le wire format (`serializeState`/`buildShapesFromPayload`).
> Coords et topologie séparées → manipulations de points
> (déplacement d'un sommet partagé, fusion de doublons, déplacement de
> clusters) en O(1) plutôt qu'en O(N) sites de triangulation.

## §0. Contexte et motivation

L'éditeur expose aujourd'hui deux représentations divergentes de la
même scène :

- **Wire format** (`io.js:shapeToMesh`) : `{ pointList: [{x,y}, ...], tris: [{p1,p2,p3 (indices)}, ...] }`. Coordonnées dédupliquées par clé `x + ',' + y`.
- **Runtime** (`state.shapes[*].triangles[*].{p1,p2,p3}`) : coords inline, chaque slot triangle tient un *objet JS Point* distinct référencé **par identité**. Un sommet partagé entre 2 triangles = 2 objets distincts.

La conséquence est que toute opération de manipulation de sommets
(`applyGrabToPoint`, `mergeSelectedPoints`, `addPoint` post-Q5, etc.)
doit itérer sur N sites et propager N mutations. La règle §3.6.1
(cluster = 0 ou 1 coord unique) doit son existence à cette hétérogénéité.

Le format saveant/chargeant est déjà indexé ; le runtime ne l'est pas.
La refactor elimine cet écart.

Hors scope : cross-shape sharing, normals, layers, transformations
affines persistées — voir §8.

## §1. Decisions snapshot

Issue de 3 rounds d'interview avec l'auteur :

| #  | Question                                           | Choix retenu                                                     |
| -- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 1a | Scope de `pointList`                               | **Per-shape** (chaque `state.shapes[i]` a sa propre `pointList`) |
| 1b | Représentation des triangles partiels              | **Slot `undefined` autorisé** (`{p1: 3, p2: 7, p3: undefined}`)  |
| 1c | Contenu de `state.selectedPoints`                  | **Indices par forme** (`[3, 7]` dans l'active shape)             |
| 2a | Politique d'orphelins après `mergeSelectedPoints`  | **Compactage immédiat** (les slots sans `tris.pid` sont retirés, indices ré-écrits) |
| 2b | `addPoint` à < 1 px d'un sommet existant          | **Skip silencieux** (parité stricte avec l'UX actuelle)          |
| 2c | `grabbedGroup[i].selectedPointRef`                 | **Tout sur indices** (suppression du suivi dual)                 |
| 3a | `SCENE_FORMAT_VERSION`                             | **Reste à v1** (le wire format n'a pas changé côté JSON)         |
| 3b | Back-compat importer (legacy `shape.triangles` inline-coord) | **Conservée silencieusement** (les deux formes acceptées)        |
| 3c | Helper `validateShape(shape)`                      | **Helper dev-only** (log orphelins / out-of-bounds / cohérence)  |

## §2. Modèle : aujourd'hui vs cible

### §2.1 Runtime aujourd'hui

```js
state.shapes = [
    {
        triangles: [
            { p1: {x: 0, y: 0}, p2: {x: 1, y: 0}, p3: {x: 0, y: 1} },
            //  p1/p2/p3 = POINTEURS JS vers des objets Point créés sur addPoint
            //  plusieurs triangles peuvent référencer des objets distincts au même coord
        ]
    },
    // ...autres formes, indépendantes
]
state.activeConstructionTriangle // triangle partiel en cours de construction (1 seul à la fois)
```

Le wire format sérialise en dédupliquant les coords par `x + ',' + y` :

```js
{ shapes: [{ pointList: [{x,y}, ...], tris: [{p1:0, p2:1, p3:2, fill?}, ...] }] }
```

### §2.2 Runtime cible

```js
state.shapes = [
    {
        pointList: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 0, y: 1}],
        tris: [
            { p1: 0, p2: 1, p3: 2 },
            // p1/p2/p3 = INDICES dans pointList (entiers >= 0)
            // OU undefined si triangle partiel en cours de dessin
            // {p1: 0, p2: 1, p3: undefined}
        ]
    },
]
// invariants :
//   • tris[i].pX ∈ [0, pointList.length-1] si défini
//   • actif shape uniquement : pointList.length reflète les sommets logiques
//     actifs (toute entrée inutilisée = orpheline → merge compacte les purge)
state.activeConstructionTriangle // référence vers state.shapes[i].tris[k] partielle
```

Wire format : identique au runtime — `serializeState` perd son étape
`shapeToMesh` (le collapse inlined-coord → indexed devient trivial).

### §2.3 Diff conceptuel

| Aspect                          | Avant                           | Après                                       |
| ------------------------------- | ------------------------------- | ------------------------------------------- |
| Identité d'un sommet partagé    | N objects JS distincts          | 1 entrée dans `pointList` + N indices      |
| Déplacement d'un sommet partagé | N mutations de `.x`/`.y`        | 1 mutation de `pointList[idx].x`            |
| Fusion                          | `t.pid = target` (rebind) + centroid writeback ; orphelins GC implicite | `t.pid = min(selectedIndices)` + **re-index complet** de pointList, orphelins purgés |
| `cloneScene`                    | Map dedup inline + clone refs   | `pointList.map(({x,y}) => ({x,y}))` + `tris.map(...)`           |
| `applyGrabToPoint`              | `tri[item.pointId] = targetPos; item.selectedPointRef.x = targetPos.x` | `pointList[item.pointIndex].x = target.x`    |
| `addPoint` dédup                | `adjacentPoints(point, tri.pX, 1)` retourne early | idem (parité, pas de changement UX)          |
| `selectedPoints`                | array de Point-refs             | array d'indices (per active shape)          |
| `grabbedGroup[i].selectedPointRef` | champ annexe pour coherence   | **supprimé** (single source of truth = index) |

## §3. Touchpoints par fichier

Liste exhaustive des zones à modifier, avec le contour de la
modification attendue. Aucun code ici — la liste sert pour
l'estimation et la découpe en commits.

### §3.1 `state.js`

- `state.shapes` initial value : `[{ triangles: [] }]` → `[{ pointList: [], tris: [] }]`.
- Nouveaux champs :
  - `state.activePointList` (raccourci optionnel vers
    `state.shapes[state.activeShapeIndex].pointList`) — pour limiter la
    verbosité ; à valider en phase 1 si l'on garde cette indirection.
- Inchangés : tous les autres champs (`selectedPoints`, `grabbedGroup`, etc.).

### §3.2 `shapes.js`

- `addShape` : `state.shapes.push({ triangles: [] })` →
  `state.shapes.push({ pointList: [], tris: [] })`.
- `performDeleteShape` : idem.
- `resetAll` (importé indirectement via `io.js`) — formes réinitialisées
  avec la même structure (voir §3.4).
- Plus de référence à `.triangles` array à plat : navigation par
  `.tris`.

### §3.3 `geometry.js`

- Refonte conceptuelle des helpers « vertex-aware » :
  - `getAllVertices()` : devient trivial `activeShape().pointList.slice()` —
    désormais un alias si la fonction est conservée pour back-compat
    API. Si on la retire, mettre à jour les 3 call sites :
    `selectAllPoints`, `applyGrabTriangleSync` (via `grabPoints.every(...)`),
    `updateMouseHover` (via `getVertexIndex`).
  - `getPointsAtSamePosition(p)` : scan `pointList`, filtre par
    `adjacentPoints(p, p2, 0.01)`. Plus de traversée des triangles —
    O(pointList.length) au lieu de O(tris * 3).
  - `getVertexIndex(p)` : devient `pointList.findIndex(p2 => adjacentPoints(p, p2, 0.01))`.
  - `getStackTriangleRefs(p)` : itère `tris` ; pour chaque tri i, pousse
    `({ triangleIndex: i, slotId: 'pX' })` si `tris[i].pX` est défini ET
    `adjacentPoints(p, pointList[idx], 0.01)`. Sans scan inconditionnel
    des slots, on évite l'ambiguïté du code actuel sur les slots undefined.
- `activeTriangles()` : renommage conceptuel vers `activeTris()` ?
  À voir. Si conservé `activeTriangles()` retourne `shape.tris`, le nom
  prête à confusion — recommandé : créer `activeTris()` qui retourne
  `shape.tris`, déprécier `activeTriangles()` (ou renommer en place).
- `isSceneEmpty()` : itère `s.tris.length === 0` (au lieu de `s.triangles`).

### §3.4 `io.js`

- **Hydratation** (`buildShapesFromPayload`) :
  - Cas separated (`shape.pointList` + `shape.tris`) : produit *directement*
    `{ pointList: [...], tris: [...] }` (étape collapse supprimée).
  - Cas legacy (`shape.triangles` inline-coord) : passe par `shapeToMesh`
    pour le collapse, puis produit `{ pointList: [...], tris: [...] }` —
    back-compat préservée (decision Q3b).
- **Sérialisation** (`serializeState` pour `state.shapes.map(shapeToMesh)`) :
  tests à blanc de `shapeToMesh` pour le runtime aligned. En réalité,
  après refactor, `serializeState` peut **éviter** `shapeToMesh` et
  faire `state.shapes.map(s => ({ pointList: [...s.pointList], tris: [...s.tris] }))` — léger gain en clarté ; conservation de `shapeToMesh`
  pour la conversion *legacy → runtime* seulement.
- `validateScenePayload` : valider OUT_OF_BOUNDS pour les indices
  (`tris.pid < shape.pointList.length`). Garde anti-fuite déjà active
  (DESIGN §4.4) sur triangles partiels.
- `applyPendingRotationToShapes` : itère `pointList[idx]` au lieu de
  `t.pX` pour mutation.
- `onBeforeUnload` : inchangé structurellement, déjà par `serializeState`.

### §3.5 `geometry.js` — helpers additionnels candidats

Plusieurs nouveaux helpers à introduire pour réduire la duplication :

- `pointsOf(shape)` → `shape.pointList`.
- `getPoint(shape, idx)` → `shape.pointList[idx]` + garde `idx >= 0 && idx < shape.pointList.length` (defense).
- `findTriangleAtCoord(shape, p, tol)` → index dans `shape.tris`
  dont les 3 sommets sont adjacents au coord `p` (tolérance).
  Réutilisable dans `addPoint`, `merge` (cases « conflit avec
  multiplicité »).
- `validateShape(shape)` (Q3c) :
  ```js
  // dev-only helper, appelable depuis console devtools
  // retourne { ok: true } ou { ok: false, errors: [...] }
  // categorize les erreurs : out_of_bounds / orphan / partial_unfinished / duplication.
  ```
  Stratégie : à l'intérieur d'une garde `if (typeof window !== 'undefined' && window.location.search.includes('debug=1'))` —
  ou exposé en module exporté non-importé ailleurs.

### §3.6 `editor.js`

C'est le fichier où la majorité des modifications s'applique. Liste non
exhaustive :

- `findNearestPoint(point)` :
  - Avant : balaye `tris[*].{p1,p2,p3}` à la recherche du point coord le
    plus proche.
  - Après : balaye `pointList[*]` directement. Retourne
    `{ pointIndex, distance, point: pointList[idx] }` au lieu de
    `{ ..., triangleIndex, pointId, point: <JS ref> }`. Le
    `triangleIndex`/`pointId` ne sont plus nécessaires pour la lecture
    (la cible est un index dans `pointList`).
  - Backward : il reste utile d'avoir `pointIndex` car `addPoint` doit
    décider si l'index existe déjà dans `pointList`.

- `findNextNearestPoint` : itère depuis `state.nearestPoint.triangleIndex + 1` —
  devient `state.nearestPoint.pointIndex + 1` (boucle sur `pointList`).
  Si l'index espace est `n + 1` dans `pointList` directement, plus de
  parcours `tris`.

- `findNearestTriangle(point)` : itère `tris` mais accède via
  `pointList[tris[i].p1]` etc. pour le calcul centroid et
  `pointInsideTriangle`. Retourne `{ triangleIndex, triangle: tris[i] }`
  sans plus stocker les 3 point-refs (ils sont déduits à la lecture).

- `findSelectedLine(point)` : idem, accès par index.

- `selectAllPoints()` :
  - Itère `pointList[*]`, construit `selectedPoints = pointList.map((_,i) => i)`.
  - En mode `triangle`, `selectedTriangles` = tous les indices de tris
    dont les **3 indices distincts pointList** sont aussi en sélection
    (équivalent « tous les triangles sont inside »).

- `applyGrabToPoint(item, targetPos)` :
  - Avant : `tri[item.pointId] = targetPos; item.selectedPointRef.x = targetPos.x ...`
  - Après : `pointList[item.shapeIndex][item.pointIndex] = targetPos`
    (mutation directe de l'entrée pointList). Plus besoin de mettre à
    jour un `selectedPointRef` puisque `selectedPoints` contient les
    **indices** et que la mutation de `pointList[idx]` se propage
    automatiquement aux références implicites (les `tris[*].pidx`
    restent des indices, non des refs).

- `buildGrabbedGroupFromSelection()` :
  - Retourne `[{shapeIndex, pointIndex, triangleIndex, slotId, startX, startY, fill?, drawState}, ...]`.
  - `selectedPointRef` **supprimé** (Q2c).

- `beginGrabbing(e)` (la pre-branch §3.6.1 sparse-replace, mode-aware) :
  les `sparseCursorGrabIndices` sont un array d'indices ; le replace
  fait `selectedPoints = [...newIndices]`. La predicate
  `isSelectionSparse()` (ajoutée post-spec, refinement Phase 2 tardif)
  couvre les 3 modes : **vertex** = cluster physique (tol 0.01 §3.2) ;
  **segment** = ≤ 1 edge couverte par `selectedPoints` avec dédup par
  paire non ordonnée (sinon une edge partagée entre N tris serait
  comptée N fois) ; **triangle** = ≤ 1 triangle dont les 3 slots sont
  dans `selectedPoints`. Anti-flicker inchangé (`!sparseCursorGrabIndices.every(idx => state.selectedPoints.includes(idx))`
  fonctionne tel quel sur les 3 modes). Sémantique exacte de
  `isPointSelected` post-refactor : voir le commentaire inline de
  `isSelectionSparse()` dans `editor.js`. Sans cette généralisation,
  le pre-branch §3.6.1 ne se déclenchait effectivement qu'en mode
  vertex (les predicates vertex-only classaient segment/triangle
  « sparsity » comme « not sparse »).

- `deleteSelected{Point,Segment,Triangle}` : itèrent `tris[*]` et
  filtrent. Suppression d'un sommet = retirer le row `pointList[idx]` et
  re-indecer les `tris[*].pX` > idx (Q2a : compactage immédiat).
  Note : si la suppression d'un sommet est globale (partagé N fois), la
  nouvelle sémantique collapse immediate → état canonique préservé.

- `mergeSelectedPoints()` : 
  - `selectedIndices` = intersection `selectedPoints` ∪ `getPointsAtSamePosition(...)` par index (cluster semantics).
  - Cible = `pointList[Math.min(...selectedIndices)]` (préserve l'index
    le plus bas pour stabilité des indices des autres triangles).
  - Reassign `tris[*].pX` aux autres slots concernés.
  - **Compactage** : retirer les entrées pointList plus utilisées et
    décalage d'indices `tris[*].pX -= 1` pour les indices retirés à
    valeur > supprimé.
  - Réécrire `selectedPoints` avec les nouveaux indices post-compactage.

- `addPoint(point)` : pas de changement de contrat (Q2b) — continue à
  filtrer via `adjacentPoints(point, pointList[idx], 1)`. Si le filter
  ne déclenche pas et que `tris.at(-1)` est un triangle partiel validé
  (cf. §4.4 anti-leak), on pousse le coord dans `pointList` et on
  assigne `tris.at(-1).pX = newIdx`. Si nouveau triangle complet sur
  edge, on enregistre les 3 indices (2 existants + 1 nouveau).

### §3.7 `draw.js`

- `drawShape(shape, isActive)` : pour chaque tri, récupère les 3 points
  via `shape.pointList[tri.p1]` etc., délègue à `drawTriangle(p1, p2, p3, ...)`
  avec les 3 points (compat signature).
- `drawTriangle(p1, p2, p3, pattern, color, fill)` : signature inchangée,
  reçois les point-refs résolus par le call site.
- `drawSelectedPoints` : itère `state.selectedPoints` qui contient des
  indices → `state.shapes[state.activeShapeIndex].pointList[idx]`.
- `drawVertexLabel`, `drawStackList` : inchangés en signature, mais les
  coordonnées passées proviennent toutes de `pointList[idx]` (via
  `updateMouseHover`).

### §3.8 `history.js`

- `cloneTriArray` supprimé ; nouvelle `cloneTris(shape)` qui :
  - `pointList: shape.pointList.map(p => ({ x: p.x, y: p.y }))`
  - `tris: shape.tris.map(t => ({ p1: t.p1, p2: t.p2, p3: t.p3, fill: t.fill }))`
- `cloneScene(shapesArray)` : `shapesArray.map(s => cloneShape(s))`.
- Pas de version tag sur les entries — l'historique est jeté au reload
  (`resetEphemeralState` à `loadState`). Si on en veut un (forward-compat
  post-refactor possible) : ajouter `entry.version = SCENE_FORMAT_VERSION`.

### §3.9 `merge.js`

- `mergeSelectedPoints` : voir §3.6 (editor.js). Le helper
  `computeMergeCentroid` continue à fonctionner sur les coords ;
  simplification possible (centroïde = moyenne des coords distinctes
  dans `pointList`, même algo mais en `[3, 7] → coord`).
- `findMergeConflicts` : itère `tris` et teste si ≥2 indices sont dans
  `selectedPoints`. Si oui, l'index du triangle est en conflit.

### §3.10 `convert.js` (meshes-format → JSON)

- Inchangé structurellement — produit déjà `{pointList, tris}` (separated) ;
  le résultat est passé à `importMeshFromText` qui passe par
  `buildShapesFromPayload`. L'impact est sur ce dernier (voir §3.4).

### §3.11 `main.html`

- L'aide / tooltips mentionnent « triangle ». Après refactor, ajouter
  un court glossaire « sommet = entrée d'une forme partageable entre
  triangles de cette forme ».

### §3.12 `DESIGN.md`

Sections à mettre à jour après la refactor (cohérence doc-code) :

- §1.1 (rôle responsabilité) : ajout d'une phrase sur le rôle
  explicite du `pointList` comme liste canonique des sommets de la
  forme.
- §3.2 (sémantique par mode) : reformuler « cluster de refs partageant
  cette position » en « ensemble des indices `pointList[*]` partageant
  ce coord ».
- §3.6 (modificateurs de clic) : reformuler les exemples en termes
  d'indices `pointList[*]`.
- §3.6.1 : reformuler « length === 1 » en « un unique index distinct »
  (post-decision Q1c + Q2c).
- §4.1 (règle par mode) : reformuler « le point des slots ... » en
  « l'index du `pointList` ... ».
- §4.4 : inchangé (la règle reste valide pour triangles partiels).
- §7.8 : reformuler `getVertexIndex` en `pointList.findIndex(...)`.
- §7.9 : idem (la liste des slot refs devient la liste des slot indices).

## §4. Phases de migration (suggérées)

L'auteur choisi la stratégie d'implémentation. Proposition par défaut —
phases incrémentales avec branches courtes :

### Phase 0 — Spec (cette PR)

Ce fichier. Lecture seule. Aucun code modifié.

### Phase 1 — Runtime aligned, hydratation aligned

- `state.shapes` initial value passe à `{ pointList: [], tris: [] }`.
- `addShape`, `performDeleteShape`, `resetAll` : alignés.
- `buildShapesFromPayload` produit la nouvelle structure
  directement depuis `pointList+tris`.
- Legacy `triangles` continu d'être accepté via la conversion
  `shapeToMesh`.
- Hydratation validée ; double-écriture local storage (charger un
  ancien, immédiat, charger un nouveau, immédiat).
- **Pas encore** : `mergeSelectedPoints`, `applyGrabToPoint`, `addPoint`,
  `delete*`, draw/shape rendering — restent à l'ancienne structure
  via une couche d'adaptation fine (`tri` wrapper).

Critère de validation : un fichier legacy chargé, un fichier séparé
chargé, les deux déserialisent en mémoire avec le nouveau shape ;
draw.js les affiche encore correctement via adaptateur.

### Phase 2 — Manipulation côté editor.js

- `findNearest{Point,Line,Triangle}` : accès par index.
- `addPoint`, `processMouseUpSelection`, `selectAllPoints`,
  `deleteSelected{Point,Segment,Triangle}`, `mergeSelectedPoints` :
  tous migrés sur la nouvelle structure.
- Compactage immédiat (Q2a) validé.
- `selectedPoints` = indices.
- `grabbedGroup` : sans `selectedPointRef`.

Critère de validation : tests manuels sur les flux de base
(create→select→drag→delete→merge→undo), aucune régression via
browser smoke test.

### Phase 3 — draw.js, history.js, geometry.js

- `geometry.js` : helpers réécrits pour le modèle indexé.
- `draw.js` : accès par index (`pointList[idx]`).
- `history.js` : `cloneScene` + `cloneShape` alignés.
- `merge.js` : migré.

Critère de validation : undo/redo fonctionne (50 snapshots max),
draw latence non impactée.

### Phase 4 — Validate + observability

- `validateShape(shape)` (Q3c) : dev-only helper.
- Tests additionnels (typ. tests de bornes sur addPoint).
- DESIGN.md sections mises à jour selon §3.12.

Critère de validation : pas de régression sur import legacy,
logging de `validateShape` muet sur scenes valides.

### Phase 5 — Cleanup (optionnel, post-merge)

- Suppression des helpers `activeTriangles`, `cloneTriArray` dépréciés
  si non-référencés.
- Suppression de l'adaptateur legacy dans `buildShapesFromPayload`
  (avec message de log sur fichier legacy détecté) — décision reportée
  à Q3b : conserver legacy silencieusement, **pas** supprimer.

## §5. Invariants post-refactor

Toute implémentation DOIT préserver ces invariants en runtime :

| #  | Invariant                                                                                   | Mesure de garde                                  |
| -- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| I1 | Pour toute forme `s` : `s.tris[*].pX ∈ [0, s.pointList.length - 1] ∪ {undefined}`            | `validateShape()` + filtres `addPoint`/`merge`   |
| I2 | Aucune entrée orpheline : `∀ idx ∈ [0, s.pointList.length), ∃ t.pX === idx`                  | Compactage immédiat (Q2a) — pas de zombies       |
| I3 | Pour toute forme active, les coords dédupliquées : pas deux `pointList[i1], pointList[i2]` adjacents au sens §3.2 (tolérance 0.01) | `addPoint` tolère 1 px ; si merge, deduplication centroid（post-merge normalement déjà OK) |
| I4 | `selectedPoints ⊆ [0, activeShape.pointList.length)`                                        | `goToShape` clear + reset compactage             |
| I5 | Si `t.p3 === undefined` (tri partiel) → `t.p1`, `t.p2` toujours définis                      | `addPoint` garantit l'invariant ; validation     |
| I6 | Au plus 1 triangle partiel dans la forme active (= `state.activeConstructionTriangle`)      | `addPoint` et `deleteSelected*` maintiennent     |
| I7 | Toutes les formes sont indépendantes : pas de partage cross-shape de pointList (Q1a)         | `addShape` crée nouveau `pointList` vide         |
| I8 | `historyStack[i].shapes === cloneShape(scope(state).shapes)` à l'instant `i`                 | `cloneScene` deep-clone `pointList` et `tris`    |

L'invariant I2 combiné avec I3 implique qu'on ne peut pas avoir
deux `pointList` distincts au même coord dans la même forme active ;
le merge garantit ça en supprimant les doublons pré-fusion.

## §6. Edge cases connus

### §6.1 World import mixing formats

`buildShapesFromPayload` reçoit :
- Cas `data.shapes[*].pointList + .tris` → runtime aligned direct (Phase 1).
- Cas `data.shapes[*].triangles` legacy → passe par `shapeToMesh` puis
  alignment.
- Mix dans un même fichier (pointList sur certaines formes, triangles
  sur d'autres) : géré case-by-case. Validé aujourd'hui par
  `validateScenePayload` mais à reconfirmer Phase 1.

### §6.2 `activeConstructionTriangle` après compactage

Si compactage immédiat (Q2a) est appliqué à un instant où
`activeConstructionTriangle` existe, faut-il re-indecer ses `.pX` ?
Réponse : oui, le compactage DOIT être transactionnel (sur le tri en
cours inclus). Le `activeConstructionTriangle` reste la même référence
JS mais son contenu est ré-indexé. À tester en Phase 2.

### §6.3 `selectedTriangles` (mode triangle) post-refactor

`state.selectedTriangles` reste un array d'indices de `tris[*]`. Pas
d'impact direct par compactage (les indices de tris ne sont pas
re-numérotés lors d'un compactage de pointList — seul `tris[*].pX`
peut changer). À valider Phase 4.

### §6.4 Sauvegarde d'un état `activeConstructionTriangle` partiel

Avant restart : si un triangle partiel est en cours (sérialisation via
`shapeToMesh`), la frontière io applique déjà l'anti-leak §4.4 → pas de
tris partiel dans le local storage. À la lecture Phase 1, le runtime
est aligné (pas de `activeConstructionTriangle` rechargé — initialisé
à `undefined` après reload). Confirmé.

### §6.5 Drag d'un sommet partagé avec N slots

Aujourd'hui : `applyGrabToPoint` écrit dans le slot du tri ET dans le
`selectedPointRef`. Après : `pointList[idx].x = targetX`. Tous les
`tris[*].pX === idx` voient le coord mis à jour en O(1). Suppression
du `selectedPointRef` n'a aucune incidence visible.

### §6.6 Lasso selectAllPoints et effet sur pointList size

`selectAllPoints` produit `selectedPoints` = tous les indices 0..N-1
de `pointList`. Coût O(N) au lieu de O(N+M) (avant : clusters O(M)).
Sélection span toujours active shape (Q1a, Q1c) — pas de cross-shape
sélection. Documenter la sémantique en §3.6 du DESIGN.md.

## §7. Risques ouverts

- **Migration `tris` legacy** : si un fichier legacy en cours d'édition
  au moment du upgrade tombe sur la Phase 5 cleanup (suppression legacy),
  l'utilisateur perd sa scène. À éviter en restant sur l'acceptation
  legacy silencieuse (Q3b).
- **Compactage et undo granularity** : si l'utilisateur drag + merge +
  undo, l'undo saute par-dessus le merge → les indices drag pré-merge
  ne sont plus valides. Solution : clone isolation fine — chaque
  entry истории snapshot possède ses propres `pointList` ET `tris`,
  donc l'undo restaure un état pleinement indexé. Robustesse à valider
  Phase 3.
- **`applyGrabTriangleSync` re-coupling** : la fonction teste tous
  les triangles dont les 3 sommets matchent `state.selectedPoints`.
  Avec indices, le test devient : tous les `tri.pX` ∈ `selectedPoints`.
  Plus rapide qu'avant (index-array.includes au lieu de coord-tolérance).
- **`getVertexIndex` index dérive après undo** : si l'utilisateur draw,
  delete-via-merge, undo, le sommet revient à un *autre* index
  qu'avant (compactage change l'index). Edge case rare mais à
  documenter Phase 4.

## §8. Out of scope (delibéré)

- Cross-shape sharing (`pointList` scène-level) — rejeté en Q1a.
- Layers, groupes, hierarchies de formes — non demandé.
- Normals, edges weights, uv coords — hors-scope du projet actuel.
- Transformations affines persistées (matrices par forme) — non demandé.
- Refonte de la sérialisation `meshes-format` (parser déjà séparé).
- Tooling externe basé sur `pointList/tris` — pas d'API publique, pas
  d'engagement de compat.

## §9. Plan de validation

### §9.1 Validation syntaxique

```sh
for f in editor.js main.js viewport.js hud.js merge.js constants.js \
         state.js history.js draw.js convert.js io.js shapes.js \
         geometry.js log.js modals.js console_overlay.js; do
    node --check "$f"
done
```

Critère : zéro `SyntaxError`. Voir aussi `knowledge.md` ligne « Quickstart / Test ».

### §9.2 Validation fonctionnelle (browser smoke)

Cible : `python3 test_server.py` (port 8000) + Chrome 1280x900.

Scenarios manuels :

| #  | Scenario                                            | Attendu                                                |
| -- | --------------------------------------------------- | ------------------------------------------------------ |
| S1 | Charger `assets/mesh-wail.json` (separated)         | Scène'affiche, labels §7.8 + §7.9 opérationnels         |
| S2 | Charger `assets/mesh-complex-shape.json` (legacy)   | Mêmes garanties                                        |
| S3 | Create 3 triangles via clic-gauche purs             | Affiche 3 triangles, pointList cohérent (3-9 vertices) |
| S4 | Sélectionner puis drag un sommet partagé (3 tri)    | Sommet partagé se déplace O(1) (visible)               |
| S5 | Sélectionner 3 points au même coord (cluster) → Backspace merge | 1 sommet, pointList compact                          |
| S6 | Drag puis Undo (50 history entries)                 | Snapshot complet restauré, indices préservés           |
| S7 | Save/load JSON legacy puis new (round-trip)         | Aucune perte visible, indices reconstructibles        |
| S8 | AltGr drag rotationnel                              | Tous les sommets bougent en sync (per-shape array)     |
| S9 | Lasso + Ctrl+A + multi-select + delete              | selectAllPoints retient tous les indices              |

### §9.3 Validation des invariants

Par Phase 4 : ajouter `window.validateShape(shape)` (dev-only)
appelable depuis la console devtools qui retourne :
```js
{ ok: true }
```
ou
```js
{
  ok: false,
  errors: [
    { kind: 'out_of_bounds', triIndex: 3, slotId: 'p1', index: 7, size: 4 },
    { kind: 'orphan', pointIndex: 5, refCount: 0 },
  ],
}
```

Critère : sur scenes valides, `ok: true` ; sur scenes altérées à la
main (devtools), `errors` cohérents avec la modification.

### §9.4 Validation cross-plateforme (legacy retain)

S'assurer que :
- Un fichier JSON legacy (avec `.triangles` inline-coord) charge
  sans modification utilisateur (Q3b back-compat).
- Un fichier JSON separated charge sans conversion legacy.
- `serializeState` écrit du separated, prêt pour reload Phase 1+.

## §A. Appendix — proposition `validateShape`

```js
// dev-only — exporte depuis geometry.js OU io.js
// appelé depuis console devtools window.validateShape(state.shapes[0])
// ou en interne après chaque mutation lourde (merge, delete repeated)
export const validateShape = (shape) => {
    const errors = []
    if (!shape || typeof shape !== 'object') {
        return { ok: false, errors: [{ kind: 'shape_missing' }] }
    }
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    // I1 : out_of_bounds
    tris.forEach((t, ti) => {
        ;['p1','p2','p3'].forEach((pid) => {
            const idx = t[pid]
            if (idx === undefined) return
            if (!Number.isInteger(idx) || idx < 0 || idx >= pointList.length) {
                errors.push({ kind: 'out_of_bounds', triIndex: ti, slotId: pid, index: idx, size: pointList.length })
            }
        })
    })
    // I2 : orphelin
    const refs = new Set()
    tris.forEach((t) => {
        ;['p1','p2','p3'].forEach((pid) => {
            if (t[pid] !== undefined) refs.add(t[pid])
        })
    })
    pointList.forEach((_, idx) => {
        if (!refs.has(idx)) errors.push({ kind: 'orphan', pointIndex: idx, refCount: 0 })
    })
    // I3 : dedup tolérance 0.01
    for (let i = 0; i < pointList.length; i++) {
        for (let j = i + 1; j < pointList.length; j++) {
            if (adjacentPoints(pointList[i], pointList[j], 0.01)) {
                errors.push({ kind: 'duplication', pointIndexA: i, pointIndexB: j })
            }
        }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
```

Pas d'appel automatique (coût O(N²) pour I3) — dev-only, console
devtools à la demande.

## §B. Recap décisions vs risks — table récapitulative

| Decision                        | Risk surface                                          |
| ------------------------------- | ------------------------------------------------------ |
| Per-shape pointList (Q1a)       | Faible — déjà adossé à la persistance                 |
| Slot undefined (Q1b)            | Moyen — `applyGrabToPoint` doit tester `t.pX !== undefined` avant d'accéder |
| Indices dans selectedPoints (Q1c)| Moyen — `isPointSelected` re-implémenté ; helpers de cluster à adapter  |
| Compactage immédiat (Q2a)       | Moyen — coût O(N) sur chaque merge ; risque bug actif-construction re-indecé |
| Skip silencieux addPoint (Q2b)  | Faible — parité stricte, aucun changement UX         |
| Tout sur indices (Q2c)          | Faible — supprime une dualité, clarifie le cheminement |
| Format v1 silent (Q3a)          | Nul — wire format inchangé                            |
| Back-compat legacy (Q3b)        | Faible — `shapeToMesh` reste pour le legacy seulement |
| Helper dev-only (Q3c)           | Faible — pas de coût runtime en prod                  |
| §3.6.1 mode-aware (post-spec extens.) | Faible — helper `isSelectionSparse()` O(N) avec dédup edge-pair en mode segment ; aligne la parité click/drag WYSIWYG sur les 3 modes (vertex cluster / segment edge-pair / triangle exact-3-slot). |

## §C. Liens vers les sections DESIGN.md existantes à mettre à jour post-refactor

(Pour traçabilité post-Phase 5.)

| DESIGN.md section | Nature de la mise à jour                                        |
| ----------------- | --------------------------------------------------------------- |
| §1.1              | Mention du `pointList` comme liste canonique des sommets logiques |
| §3.2              | Reformulation cluster : « ensemble d'indices pointList partageant coord » |
| §3.6              | Exemples de modificateurs en termes d'indices                  |
| §3.6.1            | Reformulation « length === 1 » → « un unique index distinct »  |
| §4.1              | Reformulation « point des slots » → « index pointList »        |
| §4.4              | Inchangé (l'anti-leak reste applicable)                         |
| §7.8              | Reformulation `getVertexIndex` ⇒ `pointList.findIndex(...)`    |
| §7.9              | Mention du format indexé pour `getStackTriangleRefs`           |

## §D. Estimation

- Phase 1 : 1-2 commits atomiques, ~150-250 lignes impactées.
- Phase 2 : 2-4 commits, ~400-800 lignes impactées (editor.js est le
  fichier central).
- Phase 3 : 1-2 commits, ~150-300 lignes impactées.
- Phase 4 : 1 commit, ~80-100 lignes (validateShape + DESIGN.md).
- Phase 5 : 0-1 commit, ~30-50 lignes si cleanup léger.

Total estimé : **5-10 commits atomiques**, **1000-1900 lignes impactées**
sur ~6 fichiers. Aucun nouveau fichier en Phase 1-3 ; Phase 4 introduit
le helper `validateShape` dans `geometry.js` (export existant) — pas de
nouveau fichier module obligatoire.

---

> **Status** : spec validé par 3 rounds d'interview. Prêt pour Phase 1
> quand l'auteur donne le feu vert (commit séparé pour chaque phase).
