import { state } from './state.js'
import {
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    CIRCLE_MIN_SEGMENTS, CIRCLE_MAX_SEGMENTS, CIRCLE_SEGMENTS_STORAGE_KEY,
    RETICLE_MODE_STORAGE_KEY, SELECTION_MODE_STORAGE_KEY, SELECTION_MODES,
    EDITING_MODE_STORAGE_KEY, EDITING_MODES,
    CONSOLE_VISIBLE_STORAGE_KEY,
    FPS_VISIBLE_STORAGE_KEY,
} from './constants.js'
import { drawBoard, requestDraw, consumeDrawStats } from './draw.js'
import { screenToModel } from './geometry.js'
import { updateGridButtonText, updateReticleButton, updateSelectionModeButton, updateSelectionHud, updateConsoleButton, updateColorButtonState, updateShapesButton } from './hud.js'
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
//
// Rationale : voir DESIGN.md §2.4 — ce HUD mesure la CHARGE DE RENDU
// EFFECTIVE (appels a drawBoard et re-renders offscreen), pas la
// frequence rAF/vsync du navigateur. Le but est de valider que le
// canvas n'est repeint que quand c'est utile : en idle, redraws/s
// doit tomber a 0 ; en drag/zoom, doit plafonner au vsync (preuve du
// rAF coalescing) ; offscreen/s doit rester << redraws en pratique
// (preuve de l'efficacite du cache de scene). Un compteur base sur
// requestAnimationFrame mentirait sur l'idle (rAF ticks toujours a
// 60 Hz meme quand drawBoard = 0).
//
// Le polling 250 ms (= 4 Hz) sert uniquement a eviter le thrash
// textContent du DOM — les valeurs reelles remontent depuis draw.js
// par consumeDrawStats() (cf. §2.4). Pas de condition sur
// state.fpsVisible dans drawBoard (cout microscopique : deux
// increments par repaint). Le polling ne tourne que quand le HUD est
// actif, donc cout total en idle = 0 (independamment des compteurs
// toujours presents dans draw.js).
//
// PAS DE SEUIL data-perf : la metrique est volontairement neutre.
// L'attribut data-perf="good" reste statique dans le markup HTML
// (couleur verte permanente) ; pas de bascule "warn" auto qui
// pourrait mentir sur un cas limite. La regle CSS [data-perf="warn"]
// reste dormante dans main.html — reservee pour evolution future si
// on decide d'ajouter un seuil.

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
        // Sortie silencieuse : stopFpsMonitor annule deja le rAF
        // chain quand state.fpsVisible passe a false, ce guard n'est
        // qu'une defense en profondeur.
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
    // Drain les compteurs accumules pendant l'idle (ou pendant que
    // le HUD etait OFF) : evite qu'un long gap apparaisse comme un
    // burst de redraws au premier intervalle. Pas de sauvegarde de
    // l'etat pre-drain — interessant uniquement si on dive dans
    // stats-detail (pas prevu).
    consumeDrawStats()
    fpsRafId = requestAnimationFrame(fpsSampleLoop)
}

const stopFpsMonitor = () => {
    if (!fpsRafId) return
    cancelAnimationFrame(fpsRafId)
    fpsRafId = 0
    fpsLastDisplayUpdate = 0
    // Drain final pour eviter qu'au prochain ON les compteurs
    // accumules (long gap = un grand nombre) apparaissent comme
    // donnees fraiches dans le premier intervalle.
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

// ===== Preview (mode visualisation seule) =====
//
// Rationale : voir DESIGN.md §2.6
//
// Vue transitoire de focus : bascule state.previewMode et applique la
// classe body.preview-mode (cf. CSS dans main.html) qui masque la
// chrome (toolbar, console, HUD bas-gauche, sceneStatus, panneau de
// couleur, modales). Le rendu canvas est nettoye cote draw.js (pas de
// grille / axes / points de controle / overlays transitoires).
//
// PAS de persistance localStorage : a la difference des toggles de
// prefs (grille, reticule, fps, console), la preview est un etat de
// focus passager. Un reload en preview laisserait l'utilisateur sans
// boutons (masques) — seule la sortie clavier (P / Echap) resterait
// dispo, et l'etat d'edition par defaut au boot est plus sur.

export const applyPreviewMode = () => {
    const body = state.body
    if (body) body.classList.toggle('preview-mode', !!state.previewMode)
    if (state.previewMode) {
        // Nettoie les gestes en cours (lasso en cours de drag, hover
        // fantome) pour ne rien laisser transiter d'un mode a l'autre.
        // Le grab est deja inatteignable : le mousedown droit est
        // ignore en preview (cf. main.js), mais le reset reste gratuit
        // et defensif.
        state.isSelectingBox = false
        state.selectionBoxStart = undefined
        state.selectionBoxCurrent = undefined
        state.nearestPoint = undefined
        state.nearestLine = undefined
        state.nearestTriangle = undefined
        // Un trace de cercle / anneau ou de forme en cours ne doit pas
        // survivre a l'entree en preview : a la sortie, on retomberait
        // sur une ancre fantome. L'outil lui-meme reste arme (toggle
        // de vue), seul le geste est abandonne.
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
    // force le re-render offscreen : la scene stable (grille / axes /
    // points de controle) change avec previewMode, il faut donc
    // invalider le cache, pas juste blitter.
    requestDraw()
}

export const updatePreviewButton = () => {
    const btn = document.querySelector('#preview')
    if (!btn) return
    btn.classList.toggle('preview-active', !!state.previewMode)
    btn.setAttribute('aria-pressed', state.previewMode ? 'true' : 'false')
}

export const togglePreview = () => {
    // Filet : ne pas basculer en pleine gesture de grab (clic droit +
    // drag en cours, P/Echap enfonce pendant le drag). Sans ce garde,
    // resolveMouseMoveOnBoard continuerait de muter la scene sous la
    // preview jusqu'au mouseup. La gesture se termine au release ; un
    // nouveau P / Echap bascule alors. Le bouton toolbar est inatteign-
    // able dans ce cas (souris occupee sur le canvas), le clavier est
    // la seule voie d'entree.
    if (grabbed()) return
    state.previewMode = !state.previewMode
    updatePreviewButton()
    applyPreviewMode()
    log(state.previewMode
        ? 'Preview active - P, Echap ou clic gauche pour sortir (molette = zoom, clic milieu = pan)'
        : 'Preview desactivee')
}

export const wirePreviewControl = () => {
    const btn = document.querySelector('#preview')
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        togglePreview()
    })
}

// ===== Wheel handler (sur board) =====

// Reglage du nombre de cotes du cercle. Partage par la molette sur le
// canvas en mode cercle (onBoardWheel) ET par la molette sur le
// bouton #shapes actif (wireCircleWheelControl — le bouton affiche
// « cercle N ») — un seul chemin de verite pour le clamp et le
// refresh (compteur du bouton + preview renderTransient).
const adjustCircleSegments = (delta) => {
    state.circleSegments = Math.min(
        CIRCLE_MAX_SEGMENTS,
        Math.max(CIRCLE_MIN_SEGMENTS, state.circleSegments + delta),
    )
    updateShapesButton()
    requestDraw()
    // Preference persistée (comme le pas de grille) : le choix de
    // l'utilisateur survit au rechargement. Ecriture directe (meme
    // pattern que FPS_VISIBLE_STORAGE_KEY dans toggleFps) — pas de
    // transit par persistState, le reglage est volontairement hors du
    // wire format des fichiers exportes.
    try { localStorage.setItem(CIRCLE_SEGMENTS_STORAGE_KEY, String(state.circleSegments)) } catch (e) { /* ignore */ }
}

// Restaure le nombre de cotes mémorisé (preference de session, comme
// reticleMode / FPS) : valeur stockée clampée dans les bornes
// [CIRCLE_MIN_SEGMENTS, CIRCLE_MAX_SEGMENTS] ; sinon le defaut
// CIRCLE_DEFAULT_SEGMENTS (déjà posé dans state.js) reste applique.
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

// Molette sur le bouton #shapes (qui affiche « cercle N » quand le
// mode cercle est actif) : reglage du nombre de cotes — meme langage
// que la molette sur le bouton grille pour le pas (sans effet hors
// mode). `{ passive: false }` pour pouvoir preventDefault (sinon le
// scroll vertical de la toolbar avalerait l'evenement).
export const wireCircleWheelControl = () => {
    const btn = document.querySelector('#shapes')
    if (!btn) return
    btn.addEventListener('wheel', (e) => {
        // Mode cercle OU anneau : le compteur de cotes est partage
        // (state.circleSegments), le bouton affiche « cercle N » /
        // « anneau N ».
        if (!state.circleMode && !state.annulusMode) return
        e.preventDefault()
        adjustCircleSegments(e.deltaY < 0 ? 1 : -1)
    }, { passive: false })
}

export const onBoardWheel = (e) => {
    e.preventDefault()
    if (!state.board) return
    const boardRect = state.board.getBoundingClientRect()
    const cursorScreen = { x: e.x - boardRect.x, y: e.y - boardRect.y }
    // Mode cercle / anneau : la molette regle le nombre de cotes du
    // polygone genere (au lieu de zoomer/pivoter). Meme langage que le
    // reglage du pas de grille a la molette : retour immediat via la
    // preview (draw.js renderTransient) + le libellé « cercle N » /
    // « anneau N » du bouton #shapes. Desactive en preview (la molette
    // y zoome toujours, cf. §2.6).
    if ((state.circleMode || state.annulusMode) && !state.previewMode) {
        adjustCircleSegments(e.deltaY < 0 ? 1 : -1)
        return
    }
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    // Preview = visualisation seule : la molette NE PEUT PAS muter la
    // scene. On bloque les deux chemins de rotation (AltGr = tourner
    // chaque forme, selection >= 2 points = pivoter la selection) pour
    // que la molette zoome TOUJOURS en preview — meme si la selection
    // n'est pas vide (elle reste masquee mais toujours dans l'etat).
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
