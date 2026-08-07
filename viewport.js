import { state } from './state.js'
import {
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    CIRCLE_MIN_SEGMENTS, CIRCLE_MAX_SEGMENTS, CIRCLE_SEGMENTS_STORAGE_KEY,
    MERGE_DROP_RADIUS_DEFAULT_PX, MERGE_DROP_RADIUS_MIN_PX, MERGE_DROP_RADIUS_MAX_PX,
    MERGE_DROP_RADIUS_STEP_PX, MERGE_DROP_RADIUS_STORAGE_KEY,
    RETICLE_MODE_STORAGE_KEY, SELECTION_MODE_STORAGE_KEY, SELECTION_MODES,
    EDITING_MODE_STORAGE_KEY, EDITING_MODES,
    CONSOLE_VISIBLE_STORAGE_KEY,
    FPS_VISIBLE_STORAGE_KEY,
    ALL_FILLS_STORAGE_KEY,
} from './constants.js'
import { drawBoard, requestDraw, consumeDrawStats } from './draw.js'
import { screenToModel } from './geometry.js'
import { updateGridButtonText, updateReticleButton, updateSelectionModeButton, updateSelectionHud, updateConsoleButton, updateColorButtonState, updateShapesButton, updateMergeButtonState, updateAllFillsButton, showActionComment } from './hud.js'
import { persistState, snapZoom } from './io.js'
import { log } from './log.js'
import {
    rotateEachShapeAroundPivot,
    rotateSelectedPoints,
    updateMouseHover,
    grabbed,
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
// Mesure la charge de rendu EFFECTIVE (drawBoard / re-renders offscreen,
// cf. DESIGN.md §2.4), pas la frequence rAF : en idle redraws/s = 0, en
// drag plafond vsync (preuve du rAF coalescing). Polling 250 ms, valeurs
// via consumeDrawStats() ; pas de seuil data-perf (metrique volontairement neutre).

// ===== FPS display =====
let fpsLastDisplayUpdate = 0
let fpsRafId = 0

const FPS_DISPLAY_INTERVAL_MS = 250

export const updateFpsDisplay = (redraws, offscreen) => {
    const div = document.querySelector('#fpsDisplay')
    if (!div) return
    div.textContent = `${Math.round(redraws)} redraws/s (${Math.round(offscreen)} offscreen)`
}

export const updateFpsButton = () => {
    const btn = document.querySelector('#fps')
    const display = document.querySelector('#fpsDisplay')
    if (btn) btn.classList.toggle('fps-active', !!state.fpsVisible)
    if (display) display.hidden = !state.fpsVisible
}

const fpsSampleLoop = (now) => {
    if (!state.fpsVisible) {
        // Defense en profondeur : stopFpsMonitor annule deja le rAF chain.
        return
    }
    if (now - fpsLastDisplayUpdate >= FPS_DISPLAY_INTERVAL_MS) {
        const elapsed = now - fpsLastDisplayUpdate
        const stats = consumeDrawStats()
        const factor = elapsed > 0 ? 1000 / elapsed : 0
        updateFpsDisplay(stats.redraws * factor, stats.offscreen * factor)
        fpsLastDisplayUpdate = now
    }
    fpsRafId = requestAnimationFrame(fpsSampleLoop)
}

const startFpsMonitor = () => {
    if (fpsRafId) return
    fpsLastDisplayUpdate = 0
    // Drain les compteurs accumules pour eviter un faux burst au 1er intervalle.
    consumeDrawStats()
    fpsRafId = requestAnimationFrame(fpsSampleLoop)
}

const stopFpsMonitor = () => {
    if (!fpsRafId) return
    cancelAnimationFrame(fpsRafId)
    fpsRafId = 0
    fpsLastDisplayUpdate = 0
    // Drain final : eviter qu'un long gap ressorte comme donnees fraiches au prochain ON.
    consumeDrawStats()
    const div = document.querySelector('#fpsDisplay')
    if (div) div.textContent = '0 redraws/s (0 offscreen)'
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

// Migration silencieuse d'anciennes sessions ('construction'/'selection') :
// seule 'edition' est acceptee, plus de toggle UI a persister.
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

// ===== Preview (mode visualisation seule) =====
// Vue transitoire de focus (cf. DESIGN.md §2.6) : masque la chrome via
// body.preview-mode, sauf le bouton #preview qui flotte pour le cycle
// off -> preview -> plans -> off. Jamais persistee (un reload en
// preview laisserait l'utilisateur sans boutons).

export const applyPreviewMode = () => {
    const body = state.body
    if (body) body.classList.toggle('preview-mode', !!state.previewMode)
    if (state.previewMode) {
        // Reset defensif des gestes en cours (lasso, hover, traces
        // cercle/anneau/forme) : l'outil reste arme, seul le geste
        // est abandonne.
        state.isSelectingBox = false
        state.selectionBoxStart = undefined
        state.selectionBoxCurrent = undefined
        state.nearestPoint = undefined
        state.nearestLine = undefined
        state.nearestTriangle = undefined
        state.circleCenterModel = undefined
        state.circleRadiusModel = 0
        state.circleOffsetAngle = 0
        state.annulusCenterModel = undefined
        state.annulusOuterRadiusModel = 0
        state.annulusOffsetAngle = 0
        state.annulusPhase = 0
        state.annulusInnerRatio = 0
        state.shapeAnchorModel = undefined
        state.shapeCurrentModel = undefined
        state.shapeRadiusModel = 0
    }
    // La scene stable change avec previewMode : invalider le cache offscreen.
    requestDraw()
}

export const updatePreviewButton = () => {
    const btn = document.querySelector('#preview')
    if (!btn) return
    const plans = !!state.previewPlans
    btn.classList.toggle('preview-active', !!state.previewMode)
    btn.classList.toggle('preview-plans', plans)
    btn.setAttribute('aria-pressed', state.previewMode ? 'true' : 'false')
    // Libellé du sous-état : vide hors plans, « plans » en 2e état.
    const text = btn.querySelector('#previewText')
    if (text) text.textContent = plans ? 'plans' : ''
    // Tooltip : décrit le cycle en 3 états.
    btn.setAttribute('title', plans
        ? 'Prévisualisation plans : tous les plans affichés dans leur ordre. P ou clic pour revenir à la preview simple, Échap ou clic gauche pour quitter.'
        : 'Prévisualiser la scène (P / Échap / clic gauche pour quitter) : masque points de contrôle, axes, grille, HUD et boutons ; un 2e clic affiche tous les plans dans leur ordre')
}

export const togglePreview = () => {
    // Filet : ne pas basculer en pleine gesture de grab (la souris
    // muterait la scene sous la preview jusqu'au mouseup).
    if (grabbed()) return
    // Cycle en 3 états : off -> preview -> plans -> off (cf. DESIGN.md §2.6).
    if (!state.previewMode) {
        state.previewMode = true
        state.previewPlans = false
    } else if (!state.previewPlans) {
        state.previewPlans = true
    } else {
        state.previewMode = false
        state.previewPlans = false
    }
    updatePreviewButton()
    applyPreviewMode()
    log(state.previewMode
        ? (state.previewPlans
            ? 'Plans actifs : tous les plans dans leur ordre - P ou clic pour revenir a la preview simple, Echap ou clic gauche pour quitter'
            : 'Preview active - P ou clic pour afficher tous les plans dans leur ordre, Echap ou clic gauche pour sortir (molette = zoom, clic milieu = pan)')
        : 'Preview desactivee')
}

// Sortie DIRECTE (Echap, clic gauche sur le canvas, openSaveModal) : on
// sort toujours complètement, des deux états (contrairement à
// togglePreview qui cycle).
export const exitPreview = () => {
    if (grabbed()) return
    if (!state.previewMode) return
    state.previewMode = false
    state.previewPlans = false
    updatePreviewButton()
    applyPreviewMode()
    log('Preview desactivee')
}

export const wirePreviewControl = () => {
    const btn = document.querySelector('#preview')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        togglePreview()
    })
}

// ===== Mode d'affichage « toutes couleurs » (cf. DESIGN.md §7.18) =====
// Bouton du groupe Canvas ops (apres #preview) : cycle standard /
// toutes couleurs — TOUS les plans remplis de leurs couleurs de
// triangles pendant l'edition (le plan actif garde son rendu actif).
// Preference de vue persistee (meme statut que le reticule) : cle
// dediee, jamais dans le wire format, jamais dirty.

export const toggleAllFills = () => {
    state.showAllFills = !state.showAllFills
    updateAllFillsButton()
    requestDraw()
    // Preference persistee en ecriture directe (hors du wire format).
    try { localStorage.setItem(ALL_FILLS_STORAGE_KEY, state.showAllFills ? '1' : '0') } catch (e) { /* ignore */ }
}

export const restoreAllFills = () => {
    if (localStorage.getItem(ALL_FILLS_STORAGE_KEY) === '1') {
        state.showAllFills = true
    }
}

export const wireAllFillsControl = () => {
    const btn = document.querySelector('#showAllFills')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleAllFills()
    })
}

// ===== Kiosque de sélection des plans (cf. EVOLUTIONS.md) =====
// Mode transitoire (jamais persisté, comme la preview) : chaque plan
// est rendu comme une carte inclinée autour d'un axe vertical virtuel
// (draw.js drawKiosk) ; la position horizontale du pointeur pilote
// l'inclinaison et met un plan en avant. Un clic sur une carte la
// sélectionne comme plan actif et sort du mode (main.js) ; Échap ou
// clic droit annulent. La chrome est masquée via body.kiosk-mode (seul
// le bouton #kiosk flotte, le toast #actionComment reste visible).

export const updateKioskButton = () => {
    const btn = document.querySelector('#kiosk')
    if (!btn) return
    btn.classList.toggle('kiosk-active', !!state.kioskMode)
    btn.setAttribute('aria-pressed', state.kioskMode ? 'true' : 'false')
}

const applyKioskMode = () => {
    const body = state.body
    if (body) body.classList.toggle('kiosk-mode', !!state.kioskMode)
    // Reset defensif des gestes en cours (meme contrat qu'applyPreviewMode) :
    // le kiosque consomme la souris, aucun geste (lasso, hover, traces
    // cercle/anneau/forme) ne doit survivre a la bascule.
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.nearestTriangle = undefined
    state.circleCenterModel = undefined
    state.circleRadiusModel = 0
    state.circleOffsetAngle = 0
    state.annulusCenterModel = undefined
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = 0
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    updateKioskButton()
    requestDraw()
}

export const toggleKiosk = () => {
    if (state.shapes.length <= 1) return
    if (state.kioskMode) {
        exitKiosk()
        return
    }
    if (state.previewMode) exitPreview()
    state.kioskMode = true
    applyKioskMode()
    showActionComment('Survolez les plans : le pointeur fait varier l\'inclinaison — cliquez pour sélectionner le plan mis en avant, Échap pour annuler')
    log('Kiosque de sélection des plans activé')
}

export const exitKiosk = () => {
    if (!state.kioskMode) return
    state.kioskMode = false
    applyKioskMode()
    showActionComment('◀ ▶ pour naviguer entre les plans — Alt+↑/↓ pour l\'ordre des plans')
    log('Kiosque désactivé')
}

export const wireKioskControl = () => {
    const btn = document.querySelector('#kiosk')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleKiosk()
    })
}

// ===== Wheel handler (sur board) =====

// Reglage du nombre de cotes du cercle, partage entre la molette sur le
// canvas (mode cercle) et celle sur le bouton #shapes : un seul chemin
// de verite pour le clamp et le refresh.
const adjustCircleSegments = (delta) => {
    state.circleSegments = Math.min(
        CIRCLE_MAX_SEGMENTS,
        Math.max(CIRCLE_MIN_SEGMENTS, state.circleSegments + delta),
    )
    updateShapesButton()
    requestDraw()
    // Preference persistee en ecriture directe (hors du wire format des fichiers).
    try { localStorage.setItem(CIRCLE_SEGMENTS_STORAGE_KEY, String(state.circleSegments)) } catch (e) { /* ignore */ }
}

// Restaure le nombre de cotes mémorisé (clampé dans les bornes), sinon defaut.
export const restoreCircleSegments = () => {
    try {
        const stored = localStorage.getItem(CIRCLE_SEGMENTS_STORAGE_KEY)
        if (stored !== null) {
            const parsed = parseInt(stored, 10)
            if (Number.isInteger(parsed)) {
                state.circleSegments = Math.min(
                    CIRCLE_MAX_SEGMENTS,
                    Math.max(CIRCLE_MIN_SEGMENTS, parsed),
                )
            }
        }
    } catch (e) { /* ignore */ }
}

// Molette sur #shapes : reglage des cotes quand le mode cercle/anneau
// est actif. `{ passive: false }` pour pouvoir preventDefault (sinon
// le scroll vertical de la toolbar avalerait l'evenement).
export const wireCircleWheelControl = () => {
    const btn = document.querySelector('#shapes')
    if (!btn) return
    btn.addEventListener('wheel', (e) => {
        if (!state.circleMode && !state.annulusMode) return
        e.preventDefault()
        adjustCircleSegments(e.deltaY < 0 ? 1 : -1)
    }, { passive: false })
}

// ===== Rayon de la fusion par déplacement (molette sur #mergePoints) =====

// Reglage du rayon de fusion (cf. DESIGN.md §7.11) via la molette sur
// #mergePoints quand le mode est armé : un seul chemin de verite pour
// le clamp et le refresh (libellé + title via updateMergeButtonState).
const adjustMergeDropRadius = (delta) => {
    state.mergeDropRadius = Math.min(
        MERGE_DROP_RADIUS_MAX_PX,
        Math.max(MERGE_DROP_RADIUS_MIN_PX, state.mergeDropRadius + delta),
    )
    updateMergeButtonState()
    requestDraw()
    // Preference persistee en ecriture directe (hors du wire format).
    try { localStorage.setItem(MERGE_DROP_RADIUS_STORAGE_KEY, String(state.mergeDropRadius)) } catch (e) { /* ignore */ }
}

// Restaure le rayon mémorisé (clampé dans les bornes), sinon defaut.
export const restoreMergeDropRadius = () => {
    try {
        const stored = localStorage.getItem(MERGE_DROP_RADIUS_STORAGE_KEY)
        if (stored !== null) {
            const parsed = parseInt(stored, 10)
            if (Number.isInteger(parsed)) {
                state.mergeDropRadius = Math.min(
                    MERGE_DROP_RADIUS_MAX_PX,
                    Math.max(MERGE_DROP_RADIUS_MIN_PX, parsed),
                )
            }
        }
    } catch (e) { /* ignore */ }
}

// Molette sur #mergePoints quand la fusion par déplacement est armée :
// reglage du rayon (8-64 px). `{ passive: false }` pour pouvoir
// preventDefault (sinon le scroll de la toolbar avalerait l'evenement).
export const wireMergeDropWheelControl = () => {
    const btn = document.querySelector('#mergePoints')
    if (!btn) return
    btn.addEventListener('wheel', (e) => {
        if (!state.mergeOnDropActive) return
        e.preventDefault()
        adjustMergeDropRadius(e.deltaY < 0 ? MERGE_DROP_RADIUS_STEP_PX : -MERGE_DROP_RADIUS_STEP_PX)
    }, { passive: false })
}

export const onBoardWheel = (e) => {
    e.preventDefault()
    if (!state.board) return
    // Kiosque : la molette ne fait rien (selection par clic uniquement).
    if (state.kioskMode) return
    const boardRect = state.board.getBoundingClientRect()
    const cursorScreen = { x: e.x - boardRect.x, y: e.y - boardRect.y }
    // Mode cercle/anneau (hors preview) : la molette regle les cotes au lieu de zoomer.
    if ((state.circleMode || state.annulusMode) && !state.previewMode) {
        adjustCircleSegments(e.deltaY < 0 ? 1 : -1)
        return
    }
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    // En preview la molette zoome TOUJOURS : les chemins de rotation
    // (AltGr / selection >= 2) sont bloques car ils muteraient la scene.
    if (isAltGrDown && !state.previewMode) {
        state.altGrRotationPivot = screenToModel(cursorScreen)
        const angle = e.deltaY < 0 ? -ROTATE_STEP : ROTATE_STEP
        rotateEachShapeAroundPivot(state.altGrRotationPivot, angle)
        return
    }
    if (state.altGrRotationPivot) state.altGrRotationPivot = undefined
    const canRotate = !state.previewMode && state.selectedPoints.length >= 2 && !state.isSelectionDimmed
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
