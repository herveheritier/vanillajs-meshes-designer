// Rationale : voir DESIGN.md §7.2 (history stack) + modifyShapeModel-spec §3.8
// (cloneShape schema post-{pointList, tris}).

import { state } from './state.js'
import { MAX_HISTORY, ACTION_NONE } from './constants.js'
import { updateUndoRedoHud, updateSelectionHud, updateShapeHud, updateColorButtonState, updateSceneStatus } from './hud.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateMouseHover } from './editor.js'
import { persistState } from './io.js'

// ===== Clonage =====

// (modifyShapeModel-spec §3.8) : deep-clone canonique aligne sur
// { pointList, tris }. Le pointList est duplique par entree — chaque
// coord est une copie peu profonde des {x, y} ; les references partagees
// avec l_origine sont rompees (une mutation ulterieure de la scene
// n_affecte pas l_entry de l_historique). Les tris conservent leurs
// indices tels quels (pas de dedup de pointMap comme dans l_ancien
// cloneTriArray : les indices suffisent, la canonique du pointList
// est deja dedupliquee par invariant I3 post-spec-merge-compact). Q1b : les
// slots `undefined` (triangles partiels) restent `undefined` —
// invariant I5 preserve.
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

// remplace l_ancien cloneScene qui encapsulait cloneTriArray
// (clone sur API inline-coord). Maintient la signature (input
// shapesArray, output shapes clones) pour ne pas impacter les call
// sites (saveState, undo, redo).
export const cloneScene = (shapesArray) => {
    if (!Array.isArray(shapesArray)) return []
    return shapesArray.map(cloneShape)
}

// ===== Pile d'historique =====

// saveState clone la scene via cloneScene (deep-clone
// aligne). Maintient entry.version === undefined (forward-compat
// pour Phase 4 si on veut un entry.version = SCENE_FORMAT_VERSION).
export const saveState = () => {
    state.sceneDirty = true
    updateSceneStatus()
    state.historyStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex,
    })
    if (state.historyStack.length > MAX_HISTORY) {
        state.historyStack.shift()
    }
    state.redoStack = []
    updateUndoRedoHud()
}

export const undo = () => {
    if (state.historyStack.length === 0) return
    state.currentAction = ACTION_NONE
    state.redoStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex,
    })
    const entry = state.historyStack.pop()
    state.shapes = entry.shapes
    state.activeShapeIndex = entry.activeShapeIndex
    if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
        state.activeShapeIndex = 0
    }
    clearEditingTransientState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    persistState()
}

export const redo = () => {
    if (state.redoStack.length === 0) return
    state.currentAction = ACTION_NONE
    state.historyStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex,
    })
    const entry = state.redoStack.pop()
    state.shapes = entry.shapes
    state.activeShapeIndex = entry.activeShapeIndex
    if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
        state.activeShapeIndex = 0
    }
    clearEditingTransientState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
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
    updateColorButtonState()
}
