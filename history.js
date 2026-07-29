// Module history.js : undo/redo pour l'editeur.
//
// Dependances strictes (sens du flux d'imports, pas de cycle) :
//   - state.js pour l'etat mutable (historyStack, redoStack, etc.)
//   - constants.js pour MAX_HISTORY + ACTION_NONE
//   - hud.js pour updateUndoRedoHud (sync du compteur HTML)
//   - draw.js pour drawBoard (rendu apres restore)
//   - editor.js pour updateMouseHover (rafraichir le hover apres
//     restoration d'un etat precedent)
//   - shapes.js pour updateShapeHud (compteur de forme)
//
// Pas de dep sur io.persistState : la persistance est geree par
// les callers (editions, drags, rotations), pas par
// saveState/undo/redo eux-memes. Separation des responsabilites.

import { state } from './state.js'
import { MAX_HISTORY, ACTION_NONE } from './constants.js'
import { updateUndoRedoHud, updateSelectionHud, updateShapeHud } from './hud.js'
import { drawBoard } from './draw.js'
import { updateMouseHover } from './editor.js'
import { persistState } from './io.js'

// ===== Clonage =====

// Clone profond d'un tableau de triangles. Preserve le partage
// des references de point entre triangles d'un meme tableau (un
// meme point physique reste un seul objet apres clonage).
// Utilise une Map pour dedupliquer les points partages : si
// t1.p1 === t2.p2 (meme reference), le clone garde un seul
// objet copie.
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
        return nt
    })
}

// Clone toute la scene (toutes les formes + index actif).
// Chaque forme est clonee avec ses propres points ; AUCUN
// partage entre formes apres clonage, ce qui empeche une
// future modification de fuiter entre formes via une
// reference commune.
export const cloneScene = (shapesArray) => {
    return shapesArray.map(s => ({ triangles: cloneTriArray(s.triangles) }))
}

// ===== Pile d'historique =====

// Push un snapshot dans historyStack ; vide redoStack.
// updateUndoRedoHud : toute mutation des deux piles synchronise
// le HUD (#undoCount + disabled sur #undo/#redo).
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

// Restaure l'etat precedent en depilant historyStack, et
// empile l'etat courant dans redoStack.
// L'entree empilee par saveState est `{shapes, activeShapeIndex}`
// (PAS un `{state: {...}}`). Cette lecture `entry.state.shapes`
// etait un bug latent qui n'avait jamais fired en pratique (les
// tests browser du refactor ES6 ne touchaient pas undo/redo).
// Le refactor a fait remonter l'erreur en mode strict ; fixe
// ici.
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

// Meme symetrie que undo : push courant dans historyStack, pop
// la redoStack, restore l'etat.
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

// Helper prive : remet a zero les Etats ephemeres lies a
// l'edition (selection, hover, drag en cours, timers de
// rotation). Centralise car undo/redo l'appellent tous les
// deux pour garantir que la scene restauree est dans un
// etat coherent, identique a un swap de forme (goToShape).
const clearEditingTransientState = () => {
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    state.grabbedGroup = []
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
}
