// Rationale : voir DESIGN.md §1.2

import { state } from './state.js'

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
    if (countEl) countEl.textContent = state.selectedPoints.length
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

export const updateEditingModeButton = () => {
    const btn = document.querySelector('#editMode')
    const text = document.querySelector('#editModeText')
    const labels = { edition: 'édition', construction: 'construction', selection: 'sélection' }
    const names = { edition: 'édition', construction: 'construction', selection: 'sélection' }
    const mode = names[state.editingMode] ? state.editingMode : 'edition'
    if (btn) {
        btn.classList.toggle('editing-mode-active', mode !== 'edition')
        btn.removeAttribute('aria-pressed')
        btn.setAttribute('aria-label', `Mode d'édition actif : ${names[mode]}. Cliquer pour passer au mode suivant.`)
    }
    if (text) text.textContent = labels[mode]
}

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

export const updateSceneStatus = () => {
    const status = document.querySelector('#sceneStatus')
    if (!status) return
    status.textContent = state.sceneDirty ? 'modifiée' : 'sauvegardée'
    status.dataset.dirty = state.sceneDirty ? 'true' : 'false'
    status.setAttribute('aria-label', state.sceneDirty ? 'Scène modifiée' : 'Scène sauvegardée')
}

export const updateColorButtonState = () => {
    const btn = document.querySelector('#triangleColor')
    if (!btn) return
    const ready = state.selectionMode === 'triangle' && (state.selectedTriangles && state.selectedTriangles.length > 0)
    btn.disabled = !ready
    btn.classList.toggle('color-ready', ready)
    if (!ready) btn.classList.remove('color-panel-open')
}
