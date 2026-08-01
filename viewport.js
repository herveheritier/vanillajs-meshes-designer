import { state } from './state.js'
import {
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    RETICLE_MODE_STORAGE_KEY, SELECTION_MODE_STORAGE_KEY, SELECTION_MODES,
    EDITING_MODE_STORAGE_KEY, EDITING_MODES,
    CONSOLE_VISIBLE_STORAGE_KEY,
    FPS_VISIBLE_STORAGE_KEY,
} from './constants.js'
import { drawBoard, requestDraw } from './draw.js'
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

// ===== FPS HUD =====

// (feature/performance — observabilite) : mini-compteur FPS +
// ms-per-frame affiche a gauche du zoom HUD. Pour des raisons de
// cout minimal, on n'utilise PAS de PerfObserver ni de rAF instrumente
// (qui rajouterait du bruit de mesure) : on compte les ticks de
// requestAnimationFrame eux-memes (chaque rAF callback du browser
// = une frame peinte). Le loop ne tourne que quand le HUD est
// visible ; pas de cout en idle.
//
// La cle de sample est rafraichie toutes les 250 ms (= 4 Hz, imper-
// ceptible comme lag d'affichage tout en evitant le thrash DOM
// textContent x60/s). L'affichage combine fps (entier arrondi) et
// ms-per-frame derive (1000/fps, 1 decimale) pour faciliter la
// comparaison cross-machine : un ms bas sur un 60Hz et un ms bas sur
// un 144Hz ne representent pas la meme charge.
// data-perf conditionne la couleur CSS : >50fps en vert, <=50fps
// en ambre. Le seuil 50 (au lieu de 60) absorbe les marges de jitter
// des ecrans 60Hz et donne du sens "ressenti" plus strict qui
// correspond bien aux seuils "fluide / saccade" en UX.

// ===== FPS display =====

let fpsSampleStart = 0
let fpsSampleFrames = 0
let fpsLastDisplayUpdate = 0
let fpsRafId = 0

const FPS_DISPLAY_INTERVAL_MS = 250
const FPS_GOOD_THRESHOLD = 50

export const updateFpsDisplay = (fps) => {
    const div = document.querySelector('#fpsDisplay')
    if (!div) return
    const ms = fps > 0 ? 1000 / fps : 0
    div.textContent = `${fps.toFixed(0)} fps · ${ms.toFixed(1)} ms`
    div.dataset.perf = fps >= FPS_GOOD_THRESHOLD ? 'good' : 'warn'
}

export const updateFpsButton = () => {
    const btn = document.querySelector('#fps')
    const display = document.querySelector('#fpsDisplay')
    if (btn) btn.classList.toggle('fps-active', !!state.fpsVisible)
    if (display) display.hidden = !state.fpsVisible
}

const fpsSampleLoop = (now) => {
    if (!state.fpsVisible) {
        // Sortie silencieuse : stopFpsMonitor annule deja le rAF
        // chain quand state.fpsVisible passe a false, ce guard n'est
        // qu'une defense en profondeur.
        return
    }
    if (fpsSampleStart === 0) fpsSampleStart = now
    fpsSampleFrames++
    if (now - fpsLastDisplayUpdate >= FPS_DISPLAY_INTERVAL_MS) {
        const elapsed = now - fpsSampleStart
        const fps = elapsed > 0 ? (fpsSampleFrames * 1000) / elapsed : 0
        updateFpsDisplay(fps)
        fpsSampleStart = now
        fpsSampleFrames = 0
        fpsLastDisplayUpdate = now
    }
    fpsRafId = requestAnimationFrame(fpsSampleLoop)
}

const startFpsMonitor = () => {
    if (fpsRafId) return
    fpsSampleStart = 0
    fpsSampleFrames = 0
    fpsLastDisplayUpdate = 0
    fpsRafId = requestAnimationFrame(fpsSampleLoop)
}

const stopFpsMonitor = () => {
    if (!fpsRafId) return
    cancelAnimationFrame(fpsRafId)
    fpsRafId = 0
    // Reinitialise le compteur pour eviter qu'au prochain ON on
    // affiche un burst errone si l'utilisateur a attendu longtemps
    // entre deux activations (= les compteurs accumulés incluraient
    // une longue periode idle).
    fpsSampleStart = 0
    fpsSampleFrames = 0
    const div = document.querySelector('#fpsDisplay')
    if (div) div.textContent = '0 fps · 0 ms'
}

export const toggleFps = () => {
    state.fpsVisible = !state.fpsVisible
    updateFpsButton()
    if (state.fpsVisible) startFpsMonitor()
    else stopFpsMonitor()
    try { localStorage.setItem(FPS_VISIBLE_STORAGE_KEY, state.fpsVisible ? '1' : '0') } catch (e) { /* ignore */ }
}

export const restoreFpsVisible = () => {
    if (localStorage.getItem(FPS_VISIBLE_STORAGE_KEY) === '1') {
        state.fpsVisible = true
        // Demarre la boucle d'echantillonnage immediatement si la
        // session precedente avait active le HUD : evite d'attendre un
        // toggle utilisateur pour voir l'indicateur.
        startFpsMonitor()
    }
}

export const wireFpsControl = () => {
    const btn = document.querySelector('#fps')
    if (btn) btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleFps()
    })
}

// ===== Zoom reset (Ctrl+0) =====

export const resetZoom = () => {
    state.ctx.zoomLevel = 1
    state.ctx.viewCenter.x = 0
    state.ctx.viewCenter.y = 0
    state.ctx.rotationTracking = 0
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
    persistState()
}

// ===== Grille =====

export const toggleGrid = () => {
    state.activeGrid = !state.activeGrid
    updateGridButtonText()
    requestDraw()
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
        requestDraw()
        persistState()
    }, { passive: false })

    gridBtn.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault()
            if (!state.activeGrid) return
            state.GRID_STEP = DEFAULT_GRID_STEP
            updateGridButtonText()
            requestDraw()
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
    // Note : le reticule fait partie du calque transitoire (cf.
    // draw.js renderTransient) et est repeint a chaque drawBoard ;
    // un requestDraw suffit.
    requestDraw()
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

// Migration silencieuse : les sessions précédentes pouvaient stocker
// 'construction' ou 'selection' dans localStorage. L'unique mode
// supporté est désormais 'edition' (constante EDITING_MODES dans
// constants.js). Une valeur stockée hors-tableau est ignorée et la
// valeur par défaut 'edition' reste appliquée. Pas d'écriture
// ultérieure : il n'y a plus de toggle UI à persister (cf. §1.3).
export const restoreEditingMode = () => {
    try {
        const stored = localStorage.getItem(EDITING_MODE_STORAGE_KEY)
        if (stored && EDITING_MODES.includes(stored)) state.editingMode = stored
    } catch (e) { /* ignore */ }
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
    requestDraw()
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
    requestDraw()
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
    requestDraw()
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
