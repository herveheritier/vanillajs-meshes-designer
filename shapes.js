// Module shapes.js : gestion des formes (CRUD) + modale dediee
// a la suppression d'une forme.
//
// Dependances :
//   - state.js : state.shapes, state.activeShapeIndex, etc.
//   - constants.js : ACTION_NONE
//   - hud.js : updateShapeHud, updateSelectionHud
//   - draw.js : drawBoard (redraw apres switch de forme)
//   - history.js : saveState (snapshot avant add/delete)
//   - io.js : persistState (sauvegarde apres mutation)
//   - log.js : journal (log pur)
//   - geometry.js : activeTriangles (rare, mais evite les cycles)
//
// Sans dep circulaire : shapes.js n'est importe PAR personne.
// main.js importe les fonctions ci-dessous pour le wiring de
// la toolbar (boutons prev/next/new/delete) et de la modale
// dediee (le cancel/validate des boutons de la modale).
//
// Note : updateMouseHover est rappele au switch de forme pour
// rafraichir le hover apres changement de la geometrie visible.
// Pas de cycle : editor.js ne depend pas de shapes.js (pas de
// CRUD depuis l'editeur direct).

import { state } from './state.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard } from './draw.js'
import { updateShapeHud, updateSelectionHud, updateColorButtonState } from './hud.js'
import { saveState } from './history.js'
import { persistState } from './io.js'
import { log } from './log.js'
import { updateMouseHover } from './editor.js'

// Helper : change la forme active proprement. Annule toute action
// en cours, vide la selection, recalcule le hover et le HUD.
// Centralise toute la logique de bascule entre formes ; prev/next/
// delete y arrivent via un index passe en argument.
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
    // Selection de triangles invalidee : les indices stockes
    // referencent des positions dans l'ancienne forme ; vider
    // pour eviter une application de couleur cross-form.
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

// Ouvre la modale de confirmation (memes charte que
// resetModal / importModal). Le message d'info est adapte
// dynamiquement dans showDeleteShapeModal selon qu'on
// supprime la derniere forme ou une parmi plusieurs. La
// suppression effective est deferree a performDeleteShape,
// appelee par le bouton primary de la modale.
export const deleteShape = () => {
    showDeleteShapeModal()
}

// Logique de suppression effective : extraite de l'ancien
// deleteShape (qui utilisait des confirm() natifs) pour etre
// appelable depuis le bouton primary de la modale. La logique
// "derniere forme => creer une scene vide" reste identique a
// avant, juste enveloppe dans une fonction distincte.
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
    // Invalider la selection de triangles : les indices
    // precedents referencent l'ANCIEN shapes[] qui vient d'etre
    // splice ou remplace par une forme vide. Sans ce reset, un
    // applyColor ulterieur (apres deleteShape) ciblerait des
    // indices stale -> dessin incoherent ou index out of range.
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

// Affiche la modale de suppression de forme avec un message
// dynamique : si c'est la derniere forme, on va creer une
// scene vide en remplacement (l'utilisateur ne peut pas finir
// avec 0 formes, sinon la scene est indefinie). Sinon on
// supprime juste la forme active.
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

// Wiring de la modale dediee : escape via main.js, mais les
// boutons Cancel/Validate + le clic sur le backdrop sont
// attaches ici en co-localisation avec la logique.
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
