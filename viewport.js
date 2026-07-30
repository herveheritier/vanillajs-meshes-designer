// Module viewport.js : gestion du viewport (zoom, pan, grille,
// reticule) et du toggle console.
//
// Domaine : tout ce qui touche au REPERE D'AFFICHAGE sans
// modifier la geometrie de la scene. Les rotations runtime
// sont exposees par editor.js et appelees d'ici via le wheel
// handler (AltGr + wheel / selection 2+ + wheel).
//
// Dependances (sens du flux, sans cycle) :
//   - state, constants, draw, hud
//   - console_overlay.js : persistConsoleFrame (mutation
//     partagee avec le toggle console)
//   - editor.js : rotateEachShapeAroundPivot, rotateSelectedPoints,
//     updateMouseHover (refresh du hover apres zoom/pan)
//   - io.js : persistState (zoom, pan, AltGr rotation)
//   - log.js
//
// Convention ES6 : toutes les references en `const`. Pas de
// cycle : editor.js ne depend pas de viewport.js.

import { state } from './state.js'
import {
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    RETICLE_MODE_STORAGE_KEY, SELECTION_MODE_STORAGE_KEY, SELECTION_MODES,
    CONSOLE_VISIBLE_STORAGE_KEY,
} from './constants.js'
import { drawBoard } from './draw.js'
import { screenToModel } from './geometry.js'
import { updateGridButtonText, updateReticleButton, updateSelectionModeButton, updateSelectionHud, updateConsoleButton, updateColorButtonState } from './hud.js'
import { persistState, snapZoom } from './io.js'
import { log } from './log.js'
import {
    rotateEachShapeAroundPivot,
    rotateSelectedPoints,
    updateMouseHover,
} from './editor.js'



// ===== Zoom display =====

// Format compact affiche dans le HUD bas-gauche (#zoomDisplay) :
// "1.2x pos(45, -30)" + "rot 45°" si la scene est pivotee.
// textContent pour eviter un reflow a chaque tick.
export const updateZoomDisplay = () => {
    const div = document.querySelector('#zoomDisplay')
    if (!div) return
    const vc = state.ctx.viewCenter
    let text = state.ctx.zoomLevel.toFixed(1) + 'x  pos(' +
        Math.round(vc.x) + ', ' + Math.round(vc.y) + ')'
    if (state.ctx.rotationTracking !== 0) {
        const deg = Math.round(state.ctx.rotationTracking * 180 / Math.PI)
        text += `  rot ${deg}\u00b0`
    }
    div.textContent = text
}

// ===== Zoom reset (Ctrl+0) =====

// Reinitialise zoom + viewCenter + rotationTracking a 0. Memo
// pour eviter un double-fire sur repeat clavier. Apres le
// reset, on redessine et on met a jour le HUD pour que
// l'indicateur tombe a "1.0x rot 0".
export const resetZoom = () => {
    state.ctx.zoomLevel = 1
    state.ctx.viewCenter.x = 0
    state.ctx.viewCenter.y = 0
    state.ctx.rotationTracking = 0
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
    persistState()
}

// ===== Grille =====

// Toggle la grille (utilise par le clic sur le bouton et par
// le raccourci clavier 'g'). Centralise pour eviter la
// divergence entre les deux points d'entree.
export const toggleGrid = () => {
    state.activeGrid = !state.activeGrid
    updateGridButtonText()
    drawBoard()
    persistState()
}

// Mousedown handler sur le bouton #grid : on capture le
// wheel et l'auxclick pour ajuster / reinitialiser le pas ;
// le mousedown du milieu est preventDefault pour eviter le
// scroll natif.
// Le bouton #grid peut etre absent dans tests headless : tous
// les querySelector sont tolerees.
export const wireGridControl = () => {
    const gridBtn = document.querySelector('#grid')
    if (!gridBtn) return

    gridBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleGrid()
    })

    gridBtn.addEventListener('wheel', (e) => {
        if (!state.activeGrid) return
        e.preventDefault()
        if (e.deltaY < 0) {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, state.GRID_STEP + 4)
        } else if (e.deltaY > 0) {
            state.GRID_STEP = Math.max(MIN_GRID_STEP, state.GRID_STEP - 4)
        }
        updateGridButtonText()
        drawBoard()
        persistState()
    }, { passive: false })

    gridBtn.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault()
            if (!state.activeGrid) return
            state.GRID_STEP = DEFAULT_GRID_STEP
            updateGridButtonText()
            drawBoard()
            persistState()
        }
    })

    gridBtn.addEventListener('mousedown', (e) => {
        if (e.button === 1) e.preventDefault()
    })
}

// ===== Reticule =====

// Toggle cycle 0->1->2->0 (off / simple / symetrique).
// Persiste en localStorage (cf. RETICLE_MODE_STORAGE_KEY) :
// preference UI, pas un contenu de scene.
export const toggleReticle = () => {
    state.reticleMode = (state.reticleMode + 1) % 3
    updateReticleButton()
    drawBoard()
    persistState()
}

export const restoreReticleMode = () => {
    try {
        const stored = localStorage.getItem(RETICLE_MODE_STORAGE_KEY)
        if (stored !== null) {
            const parsed = parseInt(stored)
            if (parsed === 0 || parsed === 1 || parsed === 2) state.reticleMode = parsed
        }
    } catch (e) { /* ignore */ }
}

export const wireReticleControl = () => {
    const reticleBtn = document.querySelector('#reticle')
    if (!reticleBtn) return
    reticleBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleReticle()
    })
}

// ===== Selection mode =====

// Cycle vertex -> segment -> triangle -> vertex. Mode par
// defaut 'vertex' (cf. state.js initial). Le nouveau mode est
// persiste en localStorage (cf. SELECTION_MODE_STORAGE_KEY)
// pour survivre aux reloads comme le reticule.
// Vide la selection au switch pour eviter que des points
// "orphelins" d'un mode precedent polluent le nouveau mode
// (un segment selectionne en mode segment -> passage en mode
// triangle : les 2 sommets ne representent plus rien de
// coherent dans le nouveau mode ; vider explicitement est
// plus safe que de laisser une selection potentiellement
// bizarre).
export const toggleSelectionMode = () => {
    const idx = SELECTION_MODES.indexOf(state.selectionMode)
    const next = SELECTION_MODES[(idx + 1) % SELECTION_MODES.length]
    state.selectionMode = next
    state.selectedPoints = []
    state.selectedTriangles = []
    updateSelectionHud()
    updateSelectionModeButton()
    updateColorButtonState()
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    try { localStorage.setItem(SELECTION_MODE_STORAGE_KEY, next) } catch (e) { /* ignore */ }
    log(`Selection mode -> ${next}`)
}

export const restoreSelectionMode = () => {
    try {
        const stored = localStorage.getItem(SELECTION_MODE_STORAGE_KEY)
        if (stored && SELECTION_MODES.indexOf(stored) !== -1) {
            state.selectionMode = stored
        }
    } catch (e) { /* ignore */ }
}

export const wireSelectionModeControl = () => {
    const btn = document.querySelector('#selectionMode')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleSelectionMode()
    })
}

// ===== Toggle console =====

// Preference persistee a part de la scene : l'overlay est
// ephemere, pas lie aux formes. Cle separee CONSOLE_VISIBLE_STORAGE_KEY.
export const toggleConsole = () => {
    state.consoleVisible = !state.consoleVisible
    updateConsoleButton()
    localStorage.setItem(CONSOLE_VISIBLE_STORAGE_KEY, state.consoleVisible ? '1' : '0')
}

// Restoration depuis localStorage au chargement : cle "0" -> cache.
export const restoreConsoleVisible = () => {
    if (localStorage.getItem(CONSOLE_VISIBLE_STORAGE_KEY) === '0') {
        state.consoleVisible = false
    }
}

export const wireConsoleToggle = () => {
    const consoleBtn = document.querySelector('#toggleConsole')
    if (!consoleBtn) return
    consoleBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleConsole()
    })
}

// ===== Wheel handler (sur board) =====

// Trois branches dans l'ordre :
//   (1) AltGr + wheel : rotation de TOUTES les formes autour
//       du curseur (le pivot modele est re-evalue a chaque
//       tick depuis screenToModel).
//   (2) 2+ points selectionnes = rotation des points
//       selectionnes autour du curseur.
//   (3) sinon : zoom centre sur le curseur.
// Le pan du viewCenter se fait separement, via clic-milieu
// (button===1) sur le board (cf. wireBoardPan du main.js : le
// mousedown du milieu appelle startPan ici).
export const onBoardWheel = (e) => {
    e.preventDefault()
    if (!state.board) return
    const boardRect = state.board.getBoundingClientRect()
    const cursorScreen = { x: e.x - boardRect.x, y: e.y - boardRect.y }
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    if (isAltGrDown) {
        state.altGrRotationPivot = screenToModel(cursorScreen)
        const angle = e.deltaY < 0 ? -ROTATE_STEP : ROTATE_STEP
        rotateEachShapeAroundPivot(state.altGrRotationPivot, angle)
        return
    }
    if (state.altGrRotationPivot) state.altGrRotationPivot = undefined
    const canRotate = state.selectedPoints.length >= 2 && !state.isSelectionDimmed
    if (canRotate) {
        const center = screenToModel(cursorScreen)
        const angle = e.deltaY < 0 ? -ROTATE_STEP : ROTATE_STEP
        rotateSelectedPoints(center, angle)
    } else {
        zoomCenteredOnCursor(cursorScreen, e.deltaY)
    }
}

// Zoom centre sur le curseur depuis la molette. Voir le
// commentaire de onBoardWheel pour la derivation
// mathematique. deltaY < 0 -> zoom in ; deltaY > 0 -> zoom out.
export const zoomCenteredOnCursor = (cursorScreen, deltaY) => {
    const oldZoom = state.ctx.zoomLevel
    const factor = deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR
    // Clamp puis snap a 0.1 : cf. snapZoom dans io.js. Maintient
    // l'identite reel == persiste == affiche = 1 decimale.
    const newZoom = snapZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor)))
    if (newZoom === oldZoom) return
    state.ctx.viewCenter.x += (cursorScreen.x - state.ctx.center.x) * (1 / oldZoom - 1 / newZoom)
    state.ctx.viewCenter.y -= (cursorScreen.y - state.ctx.center.y) * (1 / oldZoom - 1 / newZoom)
    state.ctx.zoomLevel = newZoom
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
    persistState()
}

export const wireBoardWheel = () => {
    if (!state.board) return
    state.board.addEventListener('wheel', onBoardWheel, { passive: false })
}

// ===== Pan (clic-milieu + drag) =====

// Debut d'un pan : capture les references initiales (position
// curseur screen + viewCenter courant). Chaque mousemove
// recalcule viewCenter depuis ces refs (pas d'accumulation :
// meme si un event est rate, le tick suivant produit la
// position correcte).
export const startPan = (mouseScreen) => {
    state.isPanning = true
    state.panStartMouse = mouseScreen
    state.panStartViewCenter = { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y }
}

// Rationale : voir DESIGN.md §2.3
export const updatePan = (mouseScreen) => {
    if (!state.isPanning) return
    const dx = mouseScreen.x - state.panStartMouse.x
    const dy = mouseScreen.y - state.panStartMouse.y
    state.ctx.viewCenter.x = state.panStartViewCenter.x - dx / state.ctx.zoomLevel
    state.ctx.viewCenter.y = state.panStartViewCenter.y + dy / state.ctx.zoomLevel
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

// Fin du pan (clic-milieu relache). Persist pour eviter
// qu'une scene non persistee soit perdue apres une
// fermeture rapide du tab, meme si l'utilisateur n'a pas
// bouge entre mousedown et mouseup.
export const endPan = () => {
    if (!state.isPanning) return
    state.isPanning = false
    state.panStartMouse = undefined
    state.panStartViewCenter = undefined
    persistState()
}
