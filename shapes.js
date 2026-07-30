// Rationale : voir DESIGN.md §3.1

import { state } from './state.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard } from './draw.js'
import { updateShapeHud, updateSelectionHud, updateColorButtonState } from './hud.js'
import { saveState } from './history.js'
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
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    updateColorButtonState()
    drawBoard()
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

export const addShape = () => {
    saveState()
    state.shapes.push({ triangles: [] })
    goToShape(state.shapes.length - 1)
    persistState()
}

export const deleteShape = () => {
    showDeleteShapeModal()
}

export const performDeleteShape = () => {
    hideDeleteShapeModal()
    saveState()
    if (state.shapes.length === 1) {
        state.shapes = [{ triangles: [] }]
        state.activeShapeIndex = 0
    } else {
        state.shapes.splice(state.activeShapeIndex, 1)
        if (state.activeShapeIndex >= state.shapes.length) state.activeShapeIndex = state.shapes.length - 1
    }
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.grabbedGroup = []
    state.currentAction = ACTION_NONE
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    updateColorButtonState()
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateSelectionHud()
    persistState()
}

export const showDeleteShapeModal = () => {
    const modal = document.querySelector('#deleteShapeModal')
    const info = document.querySelector('#deleteShapeModalInfo')
    if (!modal || !info) return
    if (state.shapes.length === 1) {
        info.textContent = 'Supprimer la dernière forme et créer une scène vide ?'
    } else {
        info.textContent = 'Supprimer la forme active ?'
    }
    modal.hidden = false
}

export const hideDeleteShapeModal = () => {
    const modal = document.querySelector('#deleteShapeModal')
    if (modal) modal.hidden = true
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
