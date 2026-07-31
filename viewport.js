import { state } from './state.js'
import {
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    RETICLE_MODE_STORAGE_KEY, SELECTION_MODE_STORAGE_KEY, SELECTION_MODES,
    EDITING_MODE_STORAGE_KEY, EDITING_MODES,
    CONSOLE_VISIBLE_STORAGE_KEY,
} from './constants.js'
import { drawBoard } from './draw.js'
import { screenToModel } from './geometry.js'
import { updateGridButtonText, updateReticleButton, updateEditingModeButton, updateSelectionModeButton, updateSelectionHud, updateConsoleButton, updateColorButtonState } from './hud.js'
import { persistState, snapZoom } from './io.js'
import { log } from './log.js'
import {
    rotateEachShapeAroundPivot,
    rotateSelectedPoints,
    updateMouseHover,
} from './editor.js'

// ===== Zoom display =====

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

export const toggleGrid = () => {
    state.activeGrid = !state.activeGrid
    updateGridButtonText()
    drawBoard()
    persistState()
}

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

// ===== Editing mode =====

export const toggleEditingMode = () => {
    const idx = EDITING_MODES.indexOf(state.editingMode)
    state.editingMode = EDITING_MODES[(idx + 1) % EDITING_MODES.length]
    state.selectedPoints = []
    state.selectedTriangles = []
    updateEditingModeButton()
    updateSelectionHud()
    updateColorButtonState()
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    try { localStorage.setItem(EDITING_MODE_STORAGE_KEY, state.editingMode) } catch (e) { /* ignore */ }
    log(`Editing mode -> ${state.editingMode}`)
}

export const restoreEditingMode = () => {
    try {
        const stored = localStorage.getItem(EDITING_MODE_STORAGE_KEY)
        if (stored && EDITING_MODES.includes(stored)) state.editingMode = stored
    } catch (e) { /* ignore */ }
}

export const wireEditingModeControl = () => {
    const btn = document.querySelector('#editMode')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleEditingMode()
    })
}

// ===== Selection mode =====

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

export const toggleConsole = () => {
    state.consoleVisible = !state.consoleVisible
    updateConsoleButton()
    localStorage.setItem(CONSOLE_VISIBLE_STORAGE_KEY, state.consoleVisible ? '1' : '0')
}

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

export const zoomCenteredOnCursor = (cursorScreen, deltaY) => {
    const oldZoom = state.ctx.zoomLevel
    const factor = deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR
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

export const endPan = () => {
    if (!state.isPanning) return
    state.isPanning = false
    state.panStartMouse = undefined
    state.panStartViewCenter = undefined
    persistState()
}
