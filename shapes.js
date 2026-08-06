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

// (évolution « boutons pour gérer l'ordre des formes ») — déplacement
// de la forme active dans l'ordre du tableau. L'ordre EST la sémantique
// des plans : dans la vue plans (cf. DESIGN.md §2.6), drawShapes
// rend les formes dans l'ordre du tableau — forme n = plan n, la forme
// d'indice le plus haut est dessinée en dernier donc recouvre les
// précédentes. MONTER la forme = augmenter son indice (elle passe
// au-dessus, plan n → plan n+1, le compteur monte : 1/3 → 2/3),
// DESCENDRE = diminuer son indice (elle passe en dessous). La forme
// active suit son déplacement (activeShapeIndexPatch accolé au
// shapeMovePatch : l'undo/redo restaure aussi l'index actif).
//
// Un déplacement = une entry undo (2 patches : shapeMove + index),
// comme addShape/performDeleteShape. Le splice en mémoire est le miroir
// exact de l'applicateur history.js applyShapeMove (même direction
// forward : remove at from, insert at to). goToShape(to) réutilise le
// nettoyage d'état transitoire (sélection, hover, HUDs) du même chemin
// que prevShape/nextShape.
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
    // (évolution « commentaire dans le HUD ») — logique prospective :
    // après un déplacement d'ordre, le toast invite à continuer avec le
    // même raccourci (Alt+↑/↓) et rappelle l'annulation. Le compteur
    // (n/m) reste lisible dans le HUD forme (#shapeLabel).
    showActionComment(
        `Ctrl+Z pour annuler — Alt+↑ / Alt+↓ pour continuer à réordonner`
    )
    persistState()
}

export const moveShapeUp = () => {
    if (state.shapes.length <= 1) return
    // Défense en profondeur (le bouton est déjà grisé à cette borne) :
    // un appel programmatique sur la dernière forme ne doit pas faire
    // de splice hors bornes (ex. index+1 = length → splice invalide).
    if (state.activeShapeIndex >= state.shapes.length - 1) return
    moveShape(state.activeShapeIndex, state.activeShapeIndex + 1)
}

export const moveShapeDown = () => {
    if (state.shapes.length <= 1) return
    // Défense en profondeur (le bouton est déjà grisé à cette borne) :
    // un appel programmatique sur la 1re forme ne doit pas faire un
    // splice à l'index -1 (qui retirerait le DERNIER élément — bug
    // attrapé par smoke-shapeorder).
    if (state.activeShapeIndex <= 0) return
    moveShape(state.activeShapeIndex, state.activeShapeIndex - 1)
}

export const addShape = () => {
    // (delta) shapeArrayPatch.insert : new empty shape at end
    // of state.shapes + activeShapeIndexPatch from current to new.
    // Insert ≈ 200 B vs full cloneScene ≈ O(scene) — gain typique.
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
    // (évolution « commentaire dans le HUD ») — logique prospective :
    // la nouvelle forme est vide et active (goToShape) ; le toast guide
    // le tout premier geste à faire sur elle.
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

    // (delta) shapeArrayPatch.remove : shape supprimé à l'index
    // courant + sa valeur pré-mut (pour pouvoir le restaurer à
    // l'undo). On capture aussi activeShapeIndex pour la nouvelle
    // valeur (post-splice).
    const removedIndex = state.activeShapeIndex
    const removedShape = state.shapes[removedIndex]
    const newActiveIndex = state.shapes.length === 1
        ? 0
        : (removedIndex >= state.shapes.length - 1
            ? state.shapes.length - 2
            : removedIndex)

    if (state.shapes.length === 1) {
        // Cas spécial : une seule forme → on la REMPLACE par une
        // forme vide (re-place au lieu de remove-then-insert pour
        // éviter d'avoir à gérer une transition activeShapeIndex
        // bizarre). Patch replace : before = old, after = empty.
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
        // Forward direction = remove : before = removedShape, after = null.
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
