import { state } from './state.js'
import { MAX_HISTORY, ACTION_NONE } from './constants.js'
import { updateUndoRedoHud, updateSelectionHud, updateShapeHud, updateColorButtonState } from './hud.js'
import { drawBoard } from './draw.js'
import { updateMouseHover } from './editor.js'
import { persistState } from './io.js'

// ===== Clonage =====

export const cloneTriArray = (triArray) => {
    const pointMap = new Map()
    return triArray.map(t => {
        const nt = {}
        if (t.p1) {
            if (!pointMap.has(t.p1)) pointMap.set(t.p1, { x: t.p1.x, y: t.p1.y })
            nt.p1 = pointMap.get(t.p1)
        }
        if (t.p2) {
            if (!pointMap.has(t.p2)) pointMap.set(t.p2, { x: t.p2.x, y: t.p2.y })
            nt.p2 = pointMap.get(t.p2)
        }
        if (t.p3) {
            if (!pointMap.has(t.p3)) pointMap.set(t.p3, { x: t.p3.x, y: t.p3.y })
            nt.p3 = pointMap.get(t.p3)
        }
        if (t.fill !== undefined) nt.fill = t.fill
        return nt
    })
}

export const cloneScene = (shapesArray) => {
    return shapesArray.map(s => ({ triangles: cloneTriArray(s.triangles) }))
}

// ===== Pile d'historique =====

export const saveState = () => {
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
    drawBoard()
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
    drawBoard()
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
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    updateColorButtonState()
}
