// Rationale : voir DESIGN.md §1.2

import { state } from './state.js'
import { SHAPE_DEFS } from './constants.js'

export const updateShapeHud = () => {
    const label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = `${state.activeShapeIndex + 1}/${state.shapes.length}`
}

export const updateUndoRedoHud = () => {
    const countEl = document.querySelector('#undoCount')
    const undoEl = document.querySelector('#undo')
    const redoEl = document.querySelector('#redo')
    if (countEl) countEl.textContent = `(${state.historyStack.length})`
    if (undoEl) undoEl.disabled = state.historyStack.length === 0
    if (redoEl) redoEl.disabled = state.redoStack.length === 0
}

export const updateSelectionHud = () => {
    const countEl = document.querySelector('#selectionCount')
    if (!countEl) return
    countEl.textContent = state.selectedPoints.length
}

export const updateGridButtonText = () => {
    const gridText = document.querySelector('#gridText')
    const gridBtn = document.querySelector('#grid')
    if (!gridText || !gridBtn) return
    gridText.textContent = `${state.GRID_STEP}px`
    gridBtn.classList.toggle('grid-active', !!state.activeGrid)
}

export const updateReticleButton = () => {
    const btn = document.querySelector('#reticle')
    const text = document.querySelector('#reticleText')
    if (btn) btn.classList.toggle('reticle-active', state.reticleMode >= 1)
    if (text) text.textContent = state.reticleMode === 0 ? '' : String(state.reticleMode)
}

export const updateCircleButton = () => {
    const btn = document.querySelector('#circle')
    const text = document.querySelector('#circleText')
    if (btn) {
        btn.classList.toggle('circle-active', !!state.circleMode)
        btn.setAttribute('aria-pressed', state.circleMode ? 'true' : 'false')
    }
    // Compteur de cotes affiche seulement quand le mode est actif
    // (meme langage que #gridText pour le pas de grille) : vide
    // sinon. textContent (pas innerHTML) car on injecte un entier.
    if (text) text.textContent = state.circleMode ? String(state.circleSegments) : ''
}

export const updateSelectionModeButton = () => {
    const btn = document.querySelector('#selectionMode')
    const text = document.querySelector('#selectionModeText')
    // Libellé français aligné sur le title="sommet / segment / triangle" du bouton.
    const labels = { vertex: 'sommet', segment: 'segment', triangle: 'triangle' }
    const label = labels[state.selectionMode] || ''
    if (btn) btn.classList.toggle('selection-mode-active', state.selectionMode !== 'vertex')
    if (text) text.textContent = label
}

export const updateConsoleButton = () => {
    const btn = document.querySelector('#toggleConsole')
    if (!btn) return
    btn.classList.toggle('console-active', !!state.consoleVisible)
    btn.setAttribute('aria-pressed', state.consoleVisible ? 'true' : 'false')
    if (state.messageBoard) state.messageBoard.style.display = state.consoleVisible ? '' : 'none'
}

export const updateAccessibilityLabels = () => {
    document.querySelectorAll('#toolbar button, .modal button, #triangleColorPanel button').forEach((button) => {
        if (!button.getAttribute('aria-label')) {
            const label = button.getAttribute('title') || button.textContent.trim()
            if (label) button.setAttribute('aria-label', label)
        }
    })
}

// Marqueur visuel de non-sauvegarde : caractère bullet (U+2022)
// accolé au nom quand la scène a été mutée depuis le dernier
// save persistant. Le choix du bullet (vs asterisk ou +) tient en
// qu'il reste lisible même en petite taille (11px monospace)
// tout en étant sémantiquement neutre (pas un operateur de
// modification publique comme `*` qui pourrait évoquer un éditeur
// de texte WISIWYG). Le leading space isole le bullet du nom pour
// qu'il soit clairement perçu comme une annotation.
// Cf. spec utilisateur : « si la scène est modifiée alors mettre
// un indicateur de non sauvegarde à côté de son nom ».
const SCENE_DIRTY_INDICATOR = ' •'
const SCENE_DIRTY_INDICATOR_FOR_ARIA = ' (non sauvegardée)'

export const updateSceneStatus = () => {
    const status = document.querySelector('#sceneStatus')
    if (!status) return
    const baseName = (typeof state.sceneName === 'string' && state.sceneName.length > 0)
        ? state.sceneName
        : 'nouvelleScene'
    const displayText = state.sceneDirty ? baseName + SCENE_DIRTY_INDICATOR : baseName
    status.textContent = displayText
    status.dataset.dirty = state.sceneDirty ? 'true' : 'false'
    const ariaLabel = state.sceneDirty ? baseName + SCENE_DIRTY_INDICATOR_FOR_ARIA : baseName
    status.setAttribute('aria-label', ariaLabel)
    // Title (tooltip) reflete l'etat courant en francais.
    // Approfondit l'info aria pour les lecteurs d'ecran ET le
    // survol souris : « nouvelleScene non sauvegardée » /
    // « mesh-wail sauvegardée ».
    status.setAttribute('title', ariaLabel)
}

export const updateShapesButton = () => {
    const btn = document.querySelector('#shapes')
    const text = document.querySelector('#shapesText')
    if (btn) {
        // Deux etats distincts : panneau ouvert (bordure inset, comme
        // #triangleColor.color-panel-open) et outil arme (accent vert
        // + libellé, comme #circle.circle-active).
        btn.classList.toggle('shapes-panel-open', !!state.shapesPanelOpen)
        btn.classList.toggle('shapes-armed', state.shapeKind !== undefined)
        btn.setAttribute('aria-pressed', state.shapesPanelOpen ? 'true' : 'false')
    }
    // Libellé de la forme armee a cote de l'icone (meme langage que
    // #circleText pour le nombre de cotes) ; vide quand rien n'est
    // arme. textContent (pas innerHTML) : chaine statique.
    if (text) {
        const def = state.shapeKind !== undefined ? SHAPE_DEFS[state.shapeKind] : undefined
        text.textContent = def ? def.label : ''
    }
}

export const updateColorButtonState = () => {
    const btn = document.querySelector('#triangleColor')
    if (!btn) return
    const ready = state.selectionMode === 'triangle' && (state.selectedTriangles && state.selectedTriangles.length > 0)
    btn.disabled = !ready
    btn.classList.toggle('color-ready', ready)
    if (!ready) btn.classList.remove('color-panel-open')
}
