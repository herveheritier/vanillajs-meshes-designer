// Rationale : voir DESIGN.md §1.2

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

// Bouton mode de selection : 3 etats cycliques (vertex /
// segment / triangle). Comme le reticule, on affiche TOUJOURS
// un texte ("0"/"1"/"2") et on met le bouton en etat actif
// SAUF en mode vertex (mode par defaut). Le label "0" sur
// vertex respecte la convention visuelle deja etablie par
// #reticleText : "rien/etat 1/etat 2" -> "rien/etat 1/etat 2".
// Justification du choix "toujours afficher le chiffre" :
// la fonction de cycle est la meme que le reticule (clic = etat
// suivant), et cacher le 0 sur vertex laisserait l'utilisateur
// deviner "deux positions cliquables de plus" sans repere.
export const updateSelectionModeButton = () => {
    const btn = document.querySelector('#selectionMode')
    const text = document.querySelector('#selectionModeText')
    const idx = (
        state.selectionMode === 'segment' ? 1 :
        state.selectionMode === 'triangle' ? 2 : 0
    )
    if (btn) btn.classList.toggle('selection-mode-active', idx > 0)
    if (text) text.textContent = String(idx)
}

// Bouton console : aria-pressed + display de #messageBoard.
export const updateConsoleButton = () => {
    const btn = document.querySelector('#toggleConsole')
    if (!btn) return
    btn.classList.toggle('console-active', !!state.consoleVisible)
    btn.setAttribute('aria-pressed', state.consoleVisible ? 'true' : 'false')
    if (state.messageBoard) state.messageBoard.style.display = state.consoleVisible ? '' : 'none'
}

// Bouton Colorier : gere l'etat actif/inactif selon 2
// pre-requis simultanes :
//   1) selectionMode === 'triangle' (la feature n'a de sens
//      qu'en mode triangle, cf. state.js).
//   2) state.selectedTriangles.length > 0 (au moins 1 triangle
//      selectionne : on ne sait pas colorier "rien").
// Si l'un manque : bouton disabled (pilule grissee via le
// theme global .disabled). Si les 2 sont reunis : retire
// disabled, ajoute la classe .color-ready (vert accent via
// CSS main.html) et, si le panneau est actuellement ouvert,
// conserve la classe .color-panel-open pour le ring d'etat.
// Appelee depuis editor.js apres chaque mutation de
// state.selectedTriangles, et depuis viewport.js apres un
// changement de mode (toggleSelectionMode). Idempotent :
// peut etre appele plusieurs fois / frame sans risque.
export const updateColorButtonState = () => {
    const btn = document.querySelector('#triangleColor')
    if (!btn) return
    const ready = state.selectionMode === 'triangle' && (state.selectedTriangles && state.selectedTriangles.length > 0)
    btn.disabled = !ready
    btn.classList.toggle('color-ready', ready)
    if (!ready) btn.classList.remove('color-panel-open')
}
