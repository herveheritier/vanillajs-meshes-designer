// Rationale : voir DESIGN.md §7.2 (history stack) + §8 (delta storage) +
// modifyShapeModel-spec §3.8 (cloneShape schema post-{pointList, tris}).
//
// La pile d'historique stocke des **entries delta** plutôt que des
// clones complets de la scène. Une entry est
// `{ activeShapeIndex, patches: [Patch, ...] }` où chaque patch
// représente la diff entre deux états (before / after) et sait
// s'appliquer dans les deux directions. La mémoire par entry est
// proportionnelle à la **taille de la tranche modifiée** (points
// déplacés, indices touchés, fills changés), pas à la scène entière.
// Un snapshot full reste disponible en fallback (path legacy /
// callers qui ne capturent pas encore de patches).

import { state } from './state.js'
import { MAX_HISTORY, ACTION_NONE } from './constants.js'
import { updateUndoRedoHud, updateSelectionHud, updateShapeHud, updateColorButtonState, updateSceneStatus } from './hud.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateMouseHover } from './editor.js'
import { persistState, recomputeSceneDirty, markUndoPersistDirty } from './io.js'

// ===== Snapshot fallback =====

// (modifyShapeModel-spec §3.8) : deep-clone canonique aligné sur
// { pointList, tris }. Le pointList est dupliqué par entrée — chaque
// coord est une copie peu profonde des {x, y} ; les références
// partagées avec l'origine sont rompues (une mutation ultérieure de
// la scène n'affecte pas l'entry de l'historique). Les tris conservent
// leurs indices tels quels (pas de dedup de pointMap comme dans
// l'ancien cloneTriArray : les indices suffisent, la canonique du
// pointList est déjà dedupliquée par invariant I3). Q1b : les slots
// `undefined` (triangles partiels) restent `undefined` — invariant I5
// préservé.
const cloneShape = (shape) => {
    if (!shape) return shape
    return {
        pointList: Array.isArray(shape.pointList)
            ? shape.pointList.map((p) => ({ x: p.x, y: p.y }))
            : [],
        tris: Array.isArray(shape.tris)
            ? shape.tris.map((t) => ({
                p1: Number.isInteger(t.p1) ? t.p1 : undefined,
                p2: Number.isInteger(t.p2) ? t.p2 : undefined,
                p3: Number.isInteger(t.p3) ? t.p3 : undefined,
                fill: typeof t.fill === 'string' ? t.fill : undefined,
            }))
            : [],
    }
}

// Clone profond de la scène entière. Utilisé comme **fallback
// snapshot** quand un call site n'exprime pas sa mutation comme un
// patch (chemin legacy, ou chemin pathologique où le patch serait
// plus gros que la scène). Conservé public pour rétrocompat (le
// writer de patch peut l'utiliser pour son seuil de bascule
// snapshot).
export const cloneScene = (shapesArray) => {
    if (!Array.isArray(shapesArray)) return []
    return shapesArray.map(cloneShape)
}

// Clone profonde d'un seul shape. Exporté pour réutilisation par les
// call sites `replaceShapePatch` (deleteSelectedPoint/Segment/Triangle
// dans editor.js, mergeSelectedPoints dans merge.js) afin d'éviter
// que la même logique de deep-clone (pointList.map + tris.map) soit
// dupliquée 4× dans 2 fichiers (source unique de vérité = single
// point de maintenance pour les invariants fill/partial).
export { cloneShape }

// Estimation de la taille mémoire d'une entry `snapshot` (full clone).
// Sert de seuil pour basculer en snapshot si un patch cumulé
// dépasserait la taille d'un clone complet. Comptage conservateur par
// objet du modèle (pas d'overhead hashmap / closures).
const SCENE_BYTE_PER_OBJ = 24  // approx overhead JS object + 2 floats typiques
const snapshotByteSize = (shapesArray) => {
    if (!Array.isArray(shapesArray)) return 0
    let n = 0
    for (const s of shapesArray) {
        if (!s) continue
        if (Array.isArray(s.pointList)) n += s.pointList.length
        if (Array.isArray(s.tris)) n += s.tris.length
    }
    return n * SCENE_BYTE_PER_OBJ
}

// ===== Patch factories =====
//
// Chaque patch est un objet `{ kind, ... }` qui décrit le delta à
// appliquer + les données nécessaires pour applyForward (rejouer la
// mutation) ou applyInverse (annuler la mutation). Le couple
// before / after est conservé pour permettre les deux directions
// sans coût de re-capture à l'undo / redo.

// 1) movePoints : un ensemble de points a vu ses coordonnées changer.
//    Le plus économe (≈ 32 B / point × 2 directions = 64 B).
//    Utilisé pour grab, rotate (sélection ou AltGr global). Le cas
//    AltGr + molette génère une entry unique grossière
//    (O(totalPoints)) mais reste largement < un cloneScene complet
//    (qui clone aussi les tris).
//    before / after = [{ s, i, x, y }, ...]
export const movePointsPatch = (before, after) => ({
    kind: 'movePoints',
    before,
    after,
})

// 2) insertPoint : un point est pushé à la fin de pointList + le
//    dernier tri est soit updated (p2/p3 défini), soit remplacé, soit
//    un nouveau tri créé. Pour annuler on pop le point et on restaure
//    lastTri (si elle existait avant). Très compact (≈ 50 B).
//    Cas d'usage : addPoint (tous les 3 sous-cas convergent vers
//    "push une coord + update/append last tri").
//
//    Convention :
//    - lastTriIndexBefore = -1 si shape vide avant mutation ; sinon
//      index du last tri dans tris (avant mutation).
//    - lastTriBefore = null si triangle vide pré-mutation, sinon
//      deep-cloné du dernier tri.
//    - lastTriAfter = idem pour l'état post-mutation.
//    - lastTriIndexAfter n'est utilisé QUE dans le cas modify. Pour
//      les cas push (empty → 1 tri ou push-new-tri), voir triDelta.
//    - triDelta : 0 = modification in-place du last tri existant,
//      1 = push d'un nouveau tri (forward : tris.push ; inverse :
//      tris.pop). Indispensable pour distinguer addPoint('push'
//      empty) ET addPoint('push-new-tri') du cas modify où
//      lastTriIndexAfter >= 0 mais le tri à cet index est pré-existant.
//      Le pré-fix avec `-1` était ambigu (0 valide mais = "modify at
//      index 0 pas encore créé").
//    - insertedPoint = { x, y } (la coord à push).
export const insertPointPatch = (shapeIdx, lastTriIndexBefore, lastTriBefore, lastTriIndexAfter, lastTriAfter, insertedPoint, triDelta) => ({
    kind: 'insertPoint',
    shapeIdx,
    lastTriIndexBefore,
    lastTriBefore,
    lastTriIndexAfter,
    lastTriAfter,
    insertedPoint,
    triDelta,
})

// 3) replaceShape : wholesale replacement du pointList ET tris d'un
//    seul shape. Utilisé pour delete+compact et merge où l'invariant
//    I2 (re-indexation) rend un patch plus chirurgical compliqué.
//    Stocke 2 × (pointList + tris) — acceptable quand la scène
//    contient plusieurs formes (gain = (N-1)/N). Pour une scène
//    mono-shape, equals `snapshot` ; un appelant avisé peut mesurer
//    et basculer en snapshot dans ce cas (voir shouldUseSnapshot
//    plus bas).
export const replaceShapePatch = (shapeIdx, pointListBefore, trisBefore, pointListAfter, trisAfter) => ({
    kind: 'replaceShape',
    shapeIdx,
    pointListBefore,
    trisBefore,
    pointListAfter,
    trisAfter,
})

// 4) setFills : un ensemble de tris a vu son fill changer (set /
//    clear). Très compact (≈ 24 B par tri × 2 directions).
export const setFillsPatch = (before, after) => ({
    kind: 'setFills',
    before,  // [{ s, t, fill }, ...]
    after,   // [{ s, t, fill }, ...]
})

// 5) shapeArray : une forme est insérée ou retirée à un index donné
//    dans state.shapes. before = la forme à l'index (ou null si
//    insertion), after = pareil (null si removed). Utilisé pour
//    addShape et performDeleteShape.
export const shapeArrayPatch = (shapeIndex, before, after) => ({
    kind: 'shapeArray',
    shapeIndex,
    before,
    after,
})

// 6) activeShapeIndex : changement de la forme active. Trivial.
export const activeShapeIndexPatch = (from, to) => ({
    kind: 'activeShapeIndex',
    from,
    to,
})

// ===== Patch resolution =====
//
// À l'enregistrement (`saveState`), certains patches peuvent être passés
// avec leur slot `after` à `null` (= "complete from live state").
// C'est le pattern **deferred** : l'appelant capture le `before` au
// début d'un geste long (grab, rotation wheel), passe le patch à
// saveState à la fin du geste — le slot `after` est alors rempli en
// lisant les coords live. Évite de re-cloner la scène pour les gestes
// où l'état post-mutation n'est connu qu'à la release.
//
// Cf. §8 DESIGN.md (deferred fill).

const resolveDeferredAfter = (patches) => {
    for (const p of patches) {
        if (!p) continue
        if (p.kind === 'movePoints' && !p.after) {
            p.after = []
            for (const e of p.before) {
                const pt = state.shapes[e.s] && state.shapes[e.s].pointList[e.i]
                if (!pt) {
                    p.after.push({ s: e.s, i: e.i, x: e.x, y: e.y })
                } else {
                    p.after.push({ s: e.s, i: e.i, x: pt.x, y: pt.y })
                }
            }
        }
    }
}

// ===== Patch application =====
//
// Chaque applicateur fait muter `state` en place. Direction =
// 'forward' applique l'état "after" (rejoue la mutation), 'inverse'
// applique l'état "before" (annule la mutation).

const setPointCoords = (shapeIdx, pointIdx, x, y) => {
    const pt = state.shapes[shapeIdx] && state.shapes[shapeIdx].pointList[pointIdx]
    if (!pt) return
    pt.x = x
    pt.y = y
}

const deepClonePointList = (pointList) => Array.isArray(pointList)
    ? pointList.map(p => ({ x: p.x, y: p.y }))
    : []
const deepCloneTri = (t) => ({
    p1: Number.isInteger(t.p1) ? t.p1 : undefined,
    p2: Number.isInteger(t.p2) ? t.p2 : undefined,
    p3: Number.isInteger(t.p3) ? t.p3 : undefined,
    fill: typeof t.fill === 'string' ? t.fill : undefined,
})
const deepCloneTris = (tris) => Array.isArray(tris) ? tris.map(deepCloneTri) : []

const applyMovePoints = (entries) => {
    for (const e of entries) setPointCoords(e.s, e.i, e.x, e.y)
}

const applyInsertPoint = (patch, direction) => {
    const shape = state.shapes[patch.shapeIdx]
    if (!shape) return
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    if (direction === 'forward') {
        // Pousser le point + appliquer la transformation du last tri
        // selon `triDelta`. triDelta===1 : nouveau tri pushé à la fin
        // (cas addPoint 'push' sur shape vide OU 'push-new-tri').
        // triDelta===0 : modification in-place du tri existant à
        // lastTriIndexAfter (cas addPoint 'modify-p2' ou 'modify-p3').
        shape.pointList.push({ x: patch.insertedPoint.x, y: patch.insertedPoint.y })
        if (patch.triDelta === 1) {
            tris.push({
                p1: patch.lastTriAfter.p1,
                p2: patch.lastTriAfter.p2,
                p3: patch.lastTriAfter.p3,
                fill: patch.lastTriAfter.fill,
            })
        } else if (patch.lastTriIndexAfter >= 0) {
            const target = tris[patch.lastTriIndexAfter]
            if (target) {
                target.p1 = patch.lastTriAfter.p1
                target.p2 = patch.lastTriAfter.p2
                target.p3 = patch.lastTriAfter.p3
                target.fill = patch.lastTriAfter.fill
            }
        }
        // Note : on n'indexe PAS explicitement le newPointIdx dans
        // lastTriAfter ; l'appelant (addPoint dans editor.js) stocke
        // lastTriAfter AVEC le bon index (pointList.length au moment
        // du saveState) — utilisé tel quel.
    } else {
        // Inverse : pop le dernier point + défaire la transformation
        // du last tri selon `triDelta`. triDelta===1 : un tri avait
        // été pushé en forward → on le pop. triDelta===0 : on restaure
        // le contenu du last tri à son état pré-mutation.
        shape.pointList.pop()
        if (patch.triDelta === 1) {
            tris.pop()
        } else if (patch.lastTriIndexBefore >= 0) {
            const target = tris[patch.lastTriIndexBefore]
            if (target) {
                target.p1 = patch.lastTriBefore.p1
                target.p2 = patch.lastTriBefore.p2
                target.p3 = patch.lastTriBefore.p3
                target.fill = patch.lastTriBefore.fill
            }
        }
    }
}

const applyReplaceShape = (patch, direction) => {
    const shape = state.shapes[patch.shapeIdx]
    if (!shape) return
    const pointList = direction === 'forward' ? patch.pointListAfter : patch.pointListBefore
    const tris = direction === 'forward' ? patch.trisAfter : patch.trisBefore
    shape.pointList.length = 0
    for (const p of pointList) shape.pointList.push({ x: p.x, y: p.y })
    shape.tris.length = 0
    for (const t of tris) shape.tris.push(deepCloneTri(t))
}

const applySetFills = (entries) => {
    for (const e of entries) {
        const t = state.shapes[e.s] && state.shapes[e.s].tris[e.t]
        if (!t) continue
        if (e.fill === undefined) {
            delete t.fill
        } else {
            t.fill = e.fill
        }
    }
}

const applyShapeArray = (patch, direction) => {
    if (direction === 'forward') {
        // after appliqué
        if (patch.after === null) {
            // remove
            state.shapes.splice(patch.shapeIndex, 1)
        } else if (patch.before === null) {
            // insert
            state.shapes.splice(patch.shapeIndex, 0, {
                pointList: deepClonePointList(patch.after.pointList),
                tris: deepCloneTris(patch.after.tris),
            })
        } else {
            // replace (deleteShape sur dernière forme)
            state.shapes[patch.shapeIndex] = {
                pointList: deepClonePointList(patch.after.pointList),
                tris: deepCloneTris(patch.after.tris),
            }
        }
    } else {
        // before appliqué (inverse)
        if (patch.after === null) {
            // remove → restore
            state.shapes.splice(patch.shapeIndex, 0, {
                pointList: deepClonePointList(patch.before.pointList),
                tris: deepCloneTris(patch.before.tris),
            })
        } else if (patch.before === null) {
            // insert → remove
            state.shapes.splice(patch.shapeIndex, 1)
        } else {
            state.shapes[patch.shapeIndex] = {
                pointList: deepClonePointList(patch.before.pointList),
                tris: deepCloneTris(patch.before.tris),
            }
        }
    }
}

const applyActiveShapeIndex = (idx) => {
    state.activeShapeIndex = idx
}

const applyPatch = (patch, direction) => {
    switch (patch.kind) {
        case 'movePoints':
            applyMovePoints(direction === 'forward' ? patch.after : patch.before)
            return
        case 'insertPoint':
            applyInsertPoint(patch, direction)
            return
        case 'replaceShape':
            applyReplaceShape(patch, direction)
            return
        case 'setFills':
            applySetFills(direction === 'forward' ? patch.after : patch.before)
            return
        case 'shapeArray':
            applyShapeArray(patch, direction)
            return
        case 'activeShapeIndex':
            applyActiveShapeIndex(direction === 'forward' ? patch.to : patch.from)
            return
    }
}

// Clamp activeShapeIndex dans les bornes après chaque undo/redo.
const clampActiveShapeIndex = () => {
    if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
        state.activeShapeIndex = 0
    }
}

// applyEntry : applique toutes les patches d'une entry dans la
// direction `direction` ('forward' = redo, 'inverse' = undo).
// Les entries legacy snapshot sont supportées en fallback
// (entry.snapshotShapes).
//
// Gestion activeShapeIndex : si un patch `activeShapeIndex` est
// présent dans la liste, l'applicateur du patch gère déjà
// l'override (forward `to`, inverse `from`). Le tail n'écrase
// PAS pour éviter les conflits avec ces patches (cf. addShape
// où activeShapeIndex change pendant la mutation). Si aucun
// activeShapeIndexPatch n'est présent, on retombe sur
// `entry.activeShapeIndex` comme filet (utile pour les mutations
// qui n'ont pas mappé activeShapeIndex, ex. deleteSelectedPoint
// où active est resté constant — le tail est idempotent dans ce
// cas).
const applyEntry = (entry, direction) => {
    if (!entry) return
    const hasActiveIndexPatch = Array.isArray(entry.patches)
        && entry.patches.some(p => p.kind === 'activeShapeIndex')
    if (Array.isArray(entry.patches)) {
        for (const patch of entry.patches) applyPatch(patch, direction)
    } else if (entry.snapshotShapes) {
        state.shapes = cloneScene(entry.snapshotShapes)
    }
    if (!hasActiveIndexPatch && Number.isInteger(entry.activeShapeIndex)) {
        state.activeShapeIndex = entry.activeShapeIndex
        clampActiveShapeIndex()
    }
}

const serializeSnapshot = (shapes) => cloneScene(shapes)

// (delta §8.5) Reconstruit l'état PRE-mutation de la scène à partir
// des patches, pour l'entry snapshot du fallback shouldUseSnapshot.
// Les call sites patche-courants (delete*/create*/merge/rotate)
// appellent saveState APRÈS la mutation : la scène courante est
// l'état post-mutation, et la cible d'undo s'obtient en rejouant
// l'inverse des patches sur un clone (les applicateurs ne touchent
// que state.shapes + state.activeShapeIndex, qu'on restaure).
// Exception : addPoint appelle saveState AVANT la mutation
// (insertPoint) — la scène courante EST déjà l'état pré-mutation ;
// rejouer l'inverse dessus détruirait un point/tri pré-existant, on
// laisse donc les patches insertPoint de côté (cas avant-mutation).
const snapshotBeforeState = (patches) => {
    const liveShapes = state.shapes
    const liveActiveIndex = state.activeShapeIndex
    const rebuilt = cloneScene(liveShapes)
    state.shapes = rebuilt
    try {
        for (const p of patches) {
            if (p.kind === 'insertPoint') continue
            applyPatch(p, 'inverse')
        }
    } finally {
        // Garantit la restauration de l'état live même si un patch
        // lève (patch malformé, garde défensive) : sans cela, la
        // scène de travail resterait pointée sur le clone de travail.
        state.shapes = liveShapes
        state.activeShapeIndex = liveActiveIndex
    }
    return rebuilt
}

// Helper : décide si un batch de patches doit être promu en snapshot
// complet. Heuristique pragmatique : si la taille cumulée estimée
// dépasse la taille d'un snapshot, on bascule en snapshot simple.
// Les callers passent les patches et la scène courante pour estimer.
const shouldUseSnapshot = (patches, shapes) => {
    if (!Array.isArray(patches) || patches.length === 0) return true
    let estBytes = 0
    for (const p of patches) {
        if (p.kind === 'movePoints') {
            estBytes += Math.max(p.before.length, p.after.length) * 32
        } else if (p.kind === 'insertPoint') {
            estBytes += 64
        } else if (p.kind === 'replaceShape') {
            estBytes += Math.max(
                (p.pointListBefore.length + p.trisBefore.length) * SCENE_BYTE_PER_OBJ,
                (p.pointListAfter.length + p.trisAfter.length) * SCENE_BYTE_PER_OBJ,
            ) * 2
        } else if (p.kind === 'setFills') {
            estBytes += Math.max(p.before.length, p.after.length) * 24
        } else if (p.kind === 'shapeArray') {
            estBytes += 200
        } else if (p.kind === 'activeShapeIndex') {
            estBytes += 8
        }
    }
    return estBytes > snapshotByteSize(shapes) * 2
        // ×2 tolérance : snapshot est plus simple structurellement
        // (un seul tableau de références, pas de redondance
        // before/after), donc on garde delta tant qu'il ne dépasse
        // pas 2× la taille d'un snapshot.
}

// ===== Pile d'historique =====

// saveState signature :
//   saveState()                            — snapshot full (fallback legacy)
//   saveState({ patches: [...] })          — entry delta
//                                            (preferred, voir §DESIGN.md 8)
//   saveState({ snapshot: true })          — force snapshot full
//
// Invariant : si `patches` est fourni, l'entry stocke la liste
// exactement. Si `snapshot: true` ou `patches` est manquant/array
// vide, on bascule en clone complet.
export const saveState = (opts) => {
    state.sceneDirty = true
    updateSceneStatus()

    let entry
    if (opts && Array.isArray(opts.patches) && opts.patches.length > 0) {
        resolveDeferredAfter(opts.patches)
        if (shouldUseSnapshot(opts.patches, state.shapes)) {
            entry = {
                // (delta §8.5) Le snapshot stocke l'état PRE-mutation
                // (cible de l'undo), pas l'état courant : les call
                // sites patche-courants appellent saveState APRÈS la
                // mutation, et applyEntry('inverse') d'une entry
                // snapshot restaure `snapshotShapes` tel quel — un
                // snapshot post-mutation rendrait l'undo no-op
                // (régression fixée ici).
                snapshotShapes: snapshotBeforeState(opts.patches),
                activeShapeIndex: state.activeShapeIndex,
            }
        } else {
            entry = {
                patches: opts.patches,
                activeShapeIndex: state.activeShapeIndex,
            }
        }
    } else {
        entry = {
            snapshotShapes: serializeSnapshot(state.shapes),
            activeShapeIndex: state.activeShapeIndex,
        }
    }

    state.historyStack.push(entry)
    if (state.historyStack.length > MAX_HISTORY) {
        state.historyStack.shift()
    }
    state.redoStack = []
    // L'historique a change : la prochaine persistState (appelee par
    // le call site juste apres saveState) re-ecrira UNDO_STORAGE_KEY
    // avec le fingerprint de scene courant (cf. io.js persistState).
    markUndoPersistDirty()
    updateUndoRedoHud()
}

// Transfère une entry entre historyStack et redoStack (ou
// l'inverse). Conserve les patches tels quels (ils portent before
// ET after) ; ne capture que activeShapeIndex à l'instant du
// transfert (= état post-mutation courant, qui sera le redo target
// OU l'undo target).
const transferEntry = (entry, activeShapeIndexOverride) => {
    if (Array.isArray(entry.patches)) {
        return { patches: entry.patches, activeShapeIndex: activeShapeIndexOverride }
    }
    return { snapshotShapes: serializeSnapshot(state.shapes), activeShapeIndex: activeShapeIndexOverride }
}

export const undo = () => {
    if (state.historyStack.length === 0) return
    state.currentAction = ACTION_NONE
    const entry = state.historyStack.pop()
    // Sauvegarde de l'état courant (qui sera le redo target) :
    // on capture l'activeShapeIndex post-mutation actuel puis on
    // transfère l'entry vers redoStack. Ses patches restent
    // identiques (before/after conservés) ; la direction est
    // appliquée via 'inverse' ci-dessous puis 'forward' au redo.
    state.redoStack.push(transferEntry(entry, state.activeShapeIndex))
    // Historique transfere : re-ecriture de la cle persiste dans la
    // persistState() ci-dessous (fingerprint = scene post-undo).
    markUndoPersistDirty()
    applyEntry(entry, 'inverse')
    clearEditingTransientState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    // Spec utilisateur : « si on fait un undo complet c'est la
    // même chose [que le chargement : pas d'indicateur de
    // sauvegarde] ». La baseline est capturee sur load/import/
    // save/reset. Si l'undo ramène l'etat courant au baseline
    // (= state.shapes == baselineShapes), dirty = false ; sinon
    // dirty = true (l'undo n'a pas efface completement la
    // divergence). Gere aussi le cas partiel save → modify → undo
    // : la pile contient encore [pre-modify] mais l'etat matche
    // le baseline, donc dirty = false (la baseline reflete le
    // dernier save connu, pas forcement le bottom de la pile).
    recomputeSceneDirty()
    persistState()
}

export const redo = () => {
    if (state.redoStack.length === 0) return
    state.currentAction = ACTION_NONE
    const entry = state.redoStack.pop()
    state.historyStack.push(transferEntry(entry, state.activeShapeIndex))
    // Historique transfere : re-ecriture de la cle persiste dans la
    // persistState() ci-dessous (fingerprint = scene post-redo).
    markUndoPersistDirty()
    applyEntry(entry, 'forward')
    clearEditingTransientState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    // Symetrique du undo : le redo re-applique une mutation
    // preexistante. Si l'etat post-redo matche encore la baseline
    // (= l'undo avait ramene au baseline AVANT le redo, et la
    // mutation annulee puis rejouee est un round-trip neutre),
    // dirty = false. Cas general : dirty = true (la scene a
    // diverge du baseline via cette mutation). Le calcul explicite
    // par comparaison couvre les deux branches.
    recomputeSceneDirty()
    persistState()
}

// Rationale : voir DESIGN.md §7.2
const clearEditingTransientState = () => {
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.nearestTriangle = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    state.grabbedGroup = []
    state.grabHistorySaved = false
    state.hasDragged = false
    state.activeConstructionTriangle = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    // Filet : tout patch deferred non committé (delta §8) doit
    // etre efface pour qu'un nouveau geste reprenne d'un etat
    // propre (un undo mid-grab, par exemple, laisse le gerant
    // orphelin : on l'elimine ici).
    state._pendingGrabPatch = null
    state._pendingEachShapeRotatePatch = null
    state._pendingSelectedRotatePatch = null
    updateColorButtonState()
}
