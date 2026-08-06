// Rationale : voir DESIGN.md §3.1

import { state } from './state.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateShapeHud, updateSelectionHud, updateColorButtonState, showActionComment } from './hud.js'
import { saveState, shapeArrayPatch, activeShapeIndexPatch, shapeMovePatch, cloneShape } from './history.js'
import { persistState } from './io.js'
import { log } from './log.js'
import { updateMouseHover } from './editor.js'

export const goToShape = (newIndex) => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return
    if (newIndex < 0 || newIndex >= state.shapes.length) return
    if (newIndex === state.activeShapeIndex) return
    state.currentAction = ACTION_NONE
    state.grabbedGroup = []
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    state.activeShapeIndex = newIndex
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    updateColorButtonState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateSelectionHud()
}

export const prevShape = () => {
    if (state.shapes.length <= 1) return
    goToShape((state.activeShapeIndex - 1 + state.shapes.length) % state.shapes.length)
}

export const nextShape = () => {
    if (state.shapes.length <= 1) return
    goToShape((state.activeShapeIndex + 1) % state.shapes.length)
}

// Déplacement de la forme active dans l'ordre du tableau (l'ordre EST
// la sémantique des plans, cf. DESIGN.md §2.6 : monter = indice +1,
// descendre = indice -1 ; la forme active suit). Une entry undo de
// 2 patches (shapeMove + activeShapeIndex) ; le splice est le miroir
// de l'applicateur history.js applyShapeMove.
const moveShape = (from, to) => {
    if (from === to) return
    saveState({
        patches: [
            shapeMovePatch(from, to),
            activeShapeIndexPatch(from, to),
        ],
    })
    const [moved] = state.shapes.splice(from, 1)
    state.shapes.splice(to, 0, moved)
    goToShape(to)
    showActionComment(
        `Ctrl+Z pour annuler — Alt+↑ / Alt+↓ pour continuer à réordonner`
    )
    persistState()
}

export const moveShapeUp = () => {
    if (state.shapes.length <= 1) return
    // Defense en profondeur : le bouton est deja grise a cette borne.
    if (state.activeShapeIndex >= state.shapes.length - 1) return
    moveShape(state.activeShapeIndex, state.activeShapeIndex + 1)
}

export const moveShapeDown = () => {
    if (state.shapes.length <= 1) return
    // Defense en profondeur : splice a l'index -1 retirerait le dernier element.
    if (state.activeShapeIndex <= 0) return
    moveShape(state.activeShapeIndex, state.activeShapeIndex - 1)
}

export const addShape = () => {
    // shapeArrayPatch.insert + activeShapeIndexPatch (delta ~200 B vs clone O(scene)).
    const fromIndex = state.activeShapeIndex
    const newShape = { pointList: [], tris: [] }
    const newIndex = state.shapes.length
    saveState({
        patches: [
            shapeArrayPatch(newIndex, null, newShape),
            activeShapeIndexPatch(fromIndex, newIndex),
        ],
    })
    state.shapes.push(newShape)
    goToShape(newIndex)
    showActionComment(
        `Cette forme est vide : cliquez pour poser le 1er point`
    )
    persistState()
}

export const deleteShape = () => {
    showDeleteShapeModal()
}

export const performDeleteShape = () => {
    hideDeleteShapeModal()

    // shapeArrayPatch.remove : shape + valeur pre-mut, et le nouvel
    // activeShapeIndex (post-splice).
    const removedIndex = state.activeShapeIndex
    const removedShape = state.shapes[removedIndex]
    const newActiveIndex = state.shapes.length === 1
        ? 0
        : (removedIndex >= state.shapes.length - 1
            ? state.shapes.length - 2
            : removedIndex)

    if (state.shapes.length === 1) {
        // Cas special : une seule forme -> remplacement par une forme
        // vide (pas de remove-then-insert a gerer).
        const clonedBefore = cloneShape(removedShape)
        saveState({
            patches: [
                shapeArrayPatch(0, clonedBefore, { pointList: [], tris: [] }),
                activeShapeIndexPatch(removedIndex, 0),
            ],
        })
        state.shapes = [{ pointList: [], tris: [] }]
        state.activeShapeIndex = 0
    } else {
        // Forward = remove : before = removedShape, after = null.
        saveState({
            patches: [
                shapeArrayPatch(removedIndex, removedShape, null),
                activeShapeIndexPatch(removedIndex, newActiveIndex),
            ],
        })
        state.shapes.splice(removedIndex, 1)
        state.activeShapeIndex = newActiveIndex
    }
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    state.grabbedGroup = []
    state.currentAction = ACTION_NONE
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    updateColorButtonState()
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateSelectionHud()
    persistState()
}

export const showDeleteShapeModal = () => {
    const modal = document.querySelector('#deleteShapeModal')
    const info = document.querySelector('#deleteShapeModalInfo')
    if (!modal || !info) return
    state.lastFocusedElement = document.activeElement
    if (state.shapes.length === 1) {
        info.textContent = 'Supprimer la dernière forme et créer une scène vide ?'
    } else {
        info.textContent = 'Supprimer la forme active ?'
    }
    modal.hidden = false
    modal.setAttribute('aria-hidden', 'false')
    const cancelBtn = document.querySelector('#deleteShapeModalCancel')
    if (cancelBtn) cancelBtn.focus()
}

export const hideDeleteShapeModal = () => {
    const modal = document.querySelector('#deleteShapeModal')
    if (modal) {
        modal.hidden = true
        modal.setAttribute('aria-hidden', 'true')
    }
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
    state.lastFocusedElement = undefined
}

export const wireDeleteShapeModal = () => {
    const modal = document.querySelector('#deleteShapeModal')
    const cancelBtn = document.querySelector('#deleteShapeModalCancel')
    const validateBtn = document.querySelector('#deleteShapeModalValidate')
    if (cancelBtn) cancelBtn.addEventListener('click', () => hideDeleteShapeModal())
    if (validateBtn) validateBtn.addEventListener('click', () => performDeleteShape())
    if (modal) modal.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.deleteShapeClose !== undefined) hideDeleteShapeModal()
    })
}
