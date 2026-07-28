// Module hud.js : fonctions de mise a jour du DOM HUD (les
// "pilules" read-only et le style des boutons).
//
// Dependances :
//   - state.js : state.shapes, state.activeShapeIndex, state.selectedPoints,
//     state.historyStack, state.redoStack, state.reticleMode,
//     state.activeGrid, state.GRID_STEP, state.consoleVisible,
//     state.messageBoard
//
// Convention : chaque query DOM est toleree a l'absence (retour
// silencieux) pour ne pas crasher dans des contextes partiels
// (ancien HTML, tests headless). Idiomatique au codebase.

import { state } from './state.js'

// Pilule "forme N/total" : mise a jour a chaque switch de forme
// (goToShape, undo/redo, applyImport, resetAll, doit).
export const updateShapeHud = () => {
    const label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = `${state.activeShapeIndex + 1}/${state.shapes.length}`
}

// Compteur annulable : #undoCount refleche la profondeur de
// historyStack ; les boutons #undo/#redo recoivent disabled=true
// quand leur pile respective est vide. Appelee depuis saveState
// (mute les deux piles), undo/redo (pop + push croises),
// applyImport.resetEphemeralState et resetAll (clear applique),
// et au boot (etat initial "(0)").
export const updateUndoRedoHud = () => {
    const countEl = document.querySelector('#undoCount')
    const undoEl = document.querySelector('#undo')
    const redoEl = document.querySelector('#redo')
    if (countEl) countEl.textContent = `(${state.historyStack.length})`
    if (undoEl) undoEl.disabled = state.historyStack.length === 0
    if (redoEl) redoEl.disabled = state.redoStack.length === 0
}

// Pilule selection : reflete state.selectedPoints.length. Appelee
// a chaque mutation de state.selectedPoints.
export const updateSelectionHud = () => {
    const countEl = document.querySelector('#selectionCount')
    if (countEl) countEl.textContent = state.selectedPoints.length
}

// Bouton grille : texte du pas + classe .grid-active. Idempotent
// avec le HTML par defaut (qui laisse le <span> vide).
export const updateGridButtonText = () => {
    const gridText = document.querySelector('#gridText')
    const gridBtn = document.querySelector('#grid')
    if (!gridText || !gridBtn) return
    gridText.textContent = `${state.GRID_STEP}px`
    gridBtn.classList.toggle('grid-active', !!state.activeGrid)
}

// Bouton reticule : classe .reticle-active si mode >= 1, texte
// "1"/"2" sinon vide.
export const updateReticleButton = () => {
    const btn = document.querySelector('#reticle')
    const text = document.querySelector('#reticleText')
    if (btn) btn.classList.toggle('reticle-active', state.reticleMode >= 1)
    if (text) text.textContent = state.reticleMode === 0 ? '' : String(state.reticleMode)
}

// Bouton console : aria-pressed + display de #messageBoard.
export const updateConsoleButton = () => {
    const btn = document.querySelector('#toggleConsole')
    if (!btn) return
    btn.classList.toggle('console-active', !!state.consoleVisible)
    btn.setAttribute('aria-pressed', state.consoleVisible ? 'true' : 'false')
    if (state.messageBoard) state.messageBoard.style.display = state.consoleVisible ? '' : 'none'
}
