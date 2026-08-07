// Pile d'historique en **entries delta** : chaque patch est une diff
// (before / after) applicable dans les deux directions, la memoire par
// entry est proportionnelle a la tranche modifiee (cf. DESIGN.md §8).
// Snapshot full en fallback (path legacy / callers sans patches).

import { state } from './state.js'
import { MAX_HISTORY, ACTION_NONE } from './constants.js'
import { updateUndoRedoHud, updateSelectionHud, updateShapeHud, updateColorButtonState, updateSceneStatus, showActionComment } from './hud.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateMouseHover } from './editor.js'
import { persistState, recomputeSceneDirty, markUndoPersistDirty } from './io.js'

// ===== Snapshot fallback =====

// Deep-clone { pointList, tris } : coords dupliquees (rupture des refs
// avec la scene), tris avec leurs indices, slots undefined conserves.
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

// Fallback snapshot : clone profond de la scene entiere.
export const cloneScene = (shapesArray) => {
    if (!Array.isArray(shapesArray)) return []
    return shapesArray.map(cloneShape)
}

// Exporte pour les call sites replaceShapePatch (source unique de
// verite pour les invariants fill/partial).
export { cloneShape }

// Seuil de bascule delta -> snapshot : estimation conservatrice par objet.
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
// Chaque patch = `{ kind, ... }` + donnees before/after pour
// applyForward (rejouer) et applyInverse (annuler) sans re-capture.

// 1) movePoints : coords changees (grab, rotate). Le plus econome.
//    before / after = [{ s, i, x, y }, ...]
export const movePointsPatch = (before, after) => ({
    kind: 'movePoints',
    before,
    after,
})

// 2) insertPoint : push d'un point + update/remplace/append du dernier
//    tri (addPoint). triDelta : 0 = modif in-place, 1 = push d'un tri
//    (inverse : pop). lastTriIndexBefore = -1 si shape vide avant.
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

// 3) replaceShape : remplacement complet pointList + tris d'un shape
//    (delete+compact, merge). Stocke 2 × (pointList + tris).
export const replaceShapePatch = (shapeIdx, pointListBefore, trisBefore, pointListAfter, trisAfter) => ({
    kind: 'replaceShape',
    shapeIdx,
    pointListBefore,
    trisBefore,
    pointListAfter,
    trisAfter,
})

// 4) setFills : fill change (set/clear). Tres compact.
export const setFillsPatch = (before, after) => ({
    kind: 'setFills',
    before,  // [{ s, t, fill }, ...]
    after,   // [{ s, t, fill }, ...]
})

// 5) shapeArray : plan insere ou retire a un index (addShape,
//    performDeleteShape). before/after = plan ou null.
export const shapeArrayPatch = (shapeIndex, before, after) => ({
    kind: 'shapeArray',
    shapeIndex,
    before,
    after,
})

// 6) activeShapeIndex : changement du plan actif.
export const activeShapeIndexPatch = (from, to) => ({
    kind: 'activeShapeIndex',
    from,
    to,
})

// 7) shapeMove : plan deplace de `from` a `to` (ordre des plans) ;
//    seuls les indices bougent (≈ 16 B), splice dans les deux sens.
//    Le call site accole un activeShapeIndexPatch pour l'undo.
export const shapeMovePatch = (from, to) => ({
    kind: 'shapeMove',
    from,
    to,
})

// ===== Patch resolution =====
// Pattern **deferred** : un patch passe avec `after` = null voit son
// slot rempli depuis le live state au saveState (gestes longs : grab,
// rotation wheel — l'etat post-mutation n'est connu qu'a la release).
// Cf. DESIGN.md §8.

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
        // Push du point + transformation du last tri selon triDelta
        // (1 = push d'un tri, 0 = modif in-place a lastTriIndexAfter).
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
    } else {
        // Inverse : pop du point ; triDelta 1 -> pop du tri, 0 -> restauration.
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
            // replace (deleteShape sur le dernier plan)
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

const applyShapeMove = (patch, direction) => {
    if (direction === 'forward') {
        const [moved] = state.shapes.splice(patch.from, 1)
        state.shapes.splice(patch.to, 0, moved)
    } else {
        const [moved] = state.shapes.splice(patch.to, 1)
        state.shapes.splice(patch.from, 0, moved)
    }
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
        case 'shapeMove':
            applyShapeMove(patch, direction)
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

// Applique les patches d'une entry ('forward' = redo, 'inverse' = undo) ;
// fallback snapshot (entry.snapshotShapes). activeShapeIndex : un patch
// explicite prime ; sinon `entry.activeShapeIndex` sert de filet.
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

// Reconstruit l'etat PRE-mutation (cible d'undo) en rejouant l'inverse
// des patches sur un clone. Les call sites appellent saveState APRES
// la mutation ; exception : insertPoint et shapeMove (saveState AVANT)
// sont sautes car la scene courante est deja pre-mutation.
const snapshotBeforeState = (patches) => {
    const liveShapes = state.shapes
    const liveActiveIndex = state.activeShapeIndex
    const rebuilt = cloneScene(liveShapes)
    state.shapes = rebuilt
    try {
        for (const p of patches) {
            if (p.kind === 'insertPoint') continue
            if (p.kind === 'shapeMove') continue
            applyPatch(p, 'inverse')
        }
    } finally {
        // Restaure l'etat live meme si un patch leve (garde defensive).
        state.shapes = liveShapes
        state.activeShapeIndex = liveActiveIndex
    }
    return rebuilt
}

// Bascule en snapshot si la taille cumulee estimee depasse ~2× celle
// d'un clone complet (le delta est plus economique structurellement).
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
        } else if (p.kind === 'shapeMove') {
            estBytes += 16
        } else if (p.kind === 'activeShapeIndex') {
            estBytes += 8
        }
    }
    // ×2 : snapshot est structurellement plus simple (pas de redondance before/after).
    return estBytes > snapshotByteSize(shapes) * 2
}

// ===== Pile d'historique =====

// saveState() = snapshot full (fallback) ; saveState({ patches }) =
// entry delta (preferred, cf. DESIGN.md §8) ; saveState({ snapshot: true })
// force le snapshot.
export const saveState = (opts) => {
    state.sceneDirty = true
    updateSceneStatus()

    let entry
    if (opts && Array.isArray(opts.patches) && opts.patches.length > 0) {
        resolveDeferredAfter(opts.patches)
        if (shouldUseSnapshot(opts.patches, state.shapes)) {
            entry = {
                // Le snapshot stocke l'etat PRE-mutation (cible de
                // l'undo), pas l'etat courant post-saveState.
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
    markUndoPersistDirty()
    updateUndoRedoHud()
}

// Transfere une entry entre historyStack et redoStack ; ne re-capture
// que activeShapeIndex (etat post-mutation courant).
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
    // Capture de l'etat courant (redo target) puis transfert vers redoStack.
    state.redoStack.push(transferEntry(entry, state.activeShapeIndex))
    markUndoPersistDirty()
    applyEntry(entry, 'inverse')
    clearEditingTransientState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    showActionComment('Ctrl+Shift+Z (ou Ctrl+Y) pour rétablir')
    // dirty = false si l'undo ramene l'etat courant au baseline
    // (dernier save/import/load connu), sinon true — la baseline
    // reflete le dernier save, pas forcement le bottom de la pile.
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
    showActionComment('Ctrl+Z pour annuler à nouveau')
    // Symetrique : dirty = false si l'etat post-redo matche encore la baseline.
    recomputeSceneDirty()
    persistState()
}

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
    // Filet : purge des patchs deferred non committes (undo mid-grab).
    state._pendingGrabPatch = null
    state._pendingEachShapeRotatePatch = null
    state._pendingSelectedRotatePatch = null
    updateColorButtonState()
}
