// Rationale : voir DESIGN.md §4.1

import { state, initDomRefs } from './state.js'
import { drawBoard, requestDraw, getDevicePixelRatio } from './draw.js'
import { CANVAS_BACKGROUND } from './constants.js'
import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateConsoleButton,
    updateSelectionModeButton, updateColorButtonState, updateAccessibilityLabels, updateSceneStatus,
    updateCircleButton, updateShapesButton,
} from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import {
    selectAllPoints, deleteSelectedPoint, deleteSelectedSegment, deleteSelectedTriangle,
    endGrabbing, grabbed, resolveMouseMoveOnBoard, beginGrabbing,
    processMouseUpSelection, processRightClickSelection, wireBoardDrop,
    wireTriangleColorPanel, hideTriangleColorPanel,
    toggleCircleMode, beginCircleGesture, commitCircleGesture, cancelCircleGesture, exitCircleMode,
    wireShapesPanel, beginShapeGesture, commitShapeGesture, cancelShapeGesture,
    disarmShapeTool, closeShapesPanel,
} from './editor.js'
import { undo, redo } from './history.js'
import {
    importMeshFromFile, saveMesh, loadState, resetAll, wireBeforeUnload,
} from './io.js'
import { importMeshesFromFile } from './convert.js'
import {
    restoreReticleMode, wireReticleControl, wireConsoleToggle, restoreConsoleVisible,
    wireBoardWheel, toggleGrid, toggleReticle, resetZoom,
    startPan, updatePan, endPan,
    restoreEditingMode, restoreSelectionMode, wireSelectionModeControl,
    restoreFpsVisible, wireFpsControl, toggleFps, updateFpsButton,
    wireGridControl, togglePreview, wirePreviewControl, wireCircleWheelControl,
    restoreCircleSegments,
} from './viewport.js'
import { wireConsoleOverlay, wireClearConsole, applyConsoleFrame } from './console_overlay.js'
import { showHelp, hideHelp, wireHelpModal, showResetModal, hideResetModal, wireResetModal } from './modals.js'
import {
    prevShape, nextShape, addShape, deleteShape, hideDeleteShapeModal, wireDeleteShapeModal,
} from './shapes.js'
import { mergeSelectedPoints, wireMergeErrorModal, hideMergeErrorModal } from './merge.js'
import { log } from './log.js'

// ===== Init DOM refs et canvas =====

initDomRefs()
state.body.style.overflow = 'hidden'
state.board.style.border = 'solid 1px black'
state.board.style.width = '99vw'
state.board.style.height = '99vh'
// Bitmap en pixels PHYSIQUES (CSS x devicePixelRatio) pour un rendu
// net sur ecrans HiDPI. Toutes les coords internes (souris,
// hit-testing, center) restent en pixels CSS — la conversion se fait
// ici (taille du bitmap) et dans draw.js (transform dpr au rendu).
// Rationale : voir DESIGN.md §2.7
const bootRect = state.board.getBoundingClientRect()
const bootDpr = getDevicePixelRatio()
state.board.width = Math.round(bootRect.width * bootDpr)
state.board.height = Math.round(bootRect.height * bootDpr)
state.board.style.cursor = 'none'
state.ctx.center.x = bootRect.width / 2
state.ctx.center.y = bootRect.height / 2
state._ctx = state.board.getContext('2d')
// fillRect du boot : sous transform IDENTITE (la transform dpr n'est
// posee qu'au premier drawBoard, cf. §2.7) — les dimensions physiques
// remplissent donc exactement le bitmap.
state._ctx.fillStyle = CANVAS_BACKGROUND
state._ctx.fillRect(0, 0, state.board.width, state.board.height)

// ===== Resize navigateur : resync du bitmap sans stretch =====
//
// Rationale : la taille CSS du canvas suit la fenetre (99vw/99vh,
// posee au boot ci-dessus) mais le bitmap interne (attributs
// width/height du canvas) etait fige une fois pour toutes. Apres un
// resize du navigateur, le navigateur etire le bitmap fixe pour
// remplir la nouvelle taille CSS => geometrie distordue (cercles
// ovalises, grille non-carree). Ce handler resynchronise le bitmap
// sur la taille PHYSIQUE reelle (CSS x devicePixelRatio, cf. §2.7)
// a chaque resize puis repaint.
//
// La garde (taille inchangee => return) evite de resetter le bitmap
// (operation qui efface la surface canvas) pour un evenement resize
// sans changement effectif — les navigateurs en emettent pour d'autres
// raisons (zoom, apparition de scrollbars, etc.). La comparaison se
// fait sur la valeur arrondie : l'attribut canvas est un entier, le
// rect est un float. Le dpr est relu a chaque evenement : un passage
// de fenetre entre deux ecrans de densites differentes change le
// bitmap sans que la taille CSS bouge (le guard passe alors).
//
// `center` (position pixel de l'origine modele) est recentre sur le
// nouveau milieu du canvas en pixels CSS : ca preserve l'invariant
// pose au boot « viewCenter = point modele centre a l'ecran », sur
// lequel les maths de zoom/pan de viewport.js s'appuient (elles
// travaillent en CSS px, comme toutes les coords internes). Artefact
// accepte : un geste en cours (grab/lasso) au moment du resize voit
// les points engages « sauter » par rapport au curseur (les coords
// d'interaction passent par modelToScreen/screenToModel, qui
// dependent de center) — rare et transitoire, inherent a tout
// recentrage. requestDraw suffit pour le repaint : il invalide la
// scene offscreen et syncOffscreenSize (draw.js) resynchronise la
// taille du cache sur le nouveau bitmap.
// Rationale : voir DESIGN.md §2.7
const resizeCanvasToFitBrowser = () => {
    const rect = state.board.getBoundingClientRect()
    const dpr = getDevicePixelRatio()
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    // Garde double : le bitmap (w/h) ET le centre dérivé du CSS
    // (rect.width/2). Cas tordu couvert : fenetre dragee entre deux
    // ecrans de densites differentes avec taille CSS qui change et
    // taille physique qui coïnciderait (cssW × dpr identique) — le
    // centre CSS changerait sans que w/h bouge, le recentrage serait
    // alors indispensable.
    if (
        w === state.board.width &&
        h === state.board.height &&
        rect.width / 2 === state.ctx.center.x &&
        rect.height / 2 === state.ctx.center.y
    ) return
    state.board.width = w
    state.board.height = h
    state.ctx.center.x = rect.width / 2
    state.ctx.center.y = rect.height / 2
    requestDraw()
}
window.addEventListener('resize', resizeCanvasToFitBrowser)

// ===== Restore localStorage + wire UI controls =====

restoreReticleMode()
    restoreEditingMode()
    restoreSelectionMode()
    restoreConsoleVisible()
    restoreFpsVisible()
    restoreCircleSegments()

// ===== Branchement des listeners "locaux" =====

wireGridControl()
    wireCircleWheelControl()
    wireReticleControl()
    wireSelectionModeControl()
    wireConsoleToggle()
    wireFpsControl()
    wirePreviewControl()
    wireConsoleOverlay()
    wireClearConsole()
wireHelpModal()
wireResetModal(() => resetAll())
wireDeleteShapeModal()
wireMergeErrorModal()
wireBoardDrop()
wireBoardWheel()
wireBeforeUnload()
wireTriangleColorPanel()
wireShapesPanel()

// ===== Toolbar buttons =====

const wireButton = (id, handler) => {
    const btn = document.querySelector('#' + id)
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        handler()
    })
}

wireButton('export', () => saveMesh())
wireButton('reset', () => showResetModal())
wireButton('selectAll', () => selectAllPoints())
wireButton('helpBtn', () => showHelp())
wireButton('prevShape', () => prevShape())
wireButton('nextShape', () => nextShape())
wireButton('newShape', () => addShape())
wireButton('deleteShape', () => deleteShape())
wireButton('mergePoints', () => mergeSelectedPoints())
wireButton('undo', () => undo())
wireButton('redo', () => redo())
wireButton('circle', () => toggleCircleMode())

const importMeshesBtn = document.querySelector('#importMeshes')
if (importMeshesBtn) {
    importMeshesBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        let input = document.querySelector('#importMeshesFile')
        if (!input) {
            input = document.createElement('input')
            input.type = 'file'
            input.id = 'importMeshesFile'
            input.hidden = true
            document.body.appendChild(input)
            input.addEventListener('change', (evt) => {
                const f = evt.target.files && evt.target.files[0]
                if (f) importMeshesFromFile(f)
                evt.target.value = ''
            })
        }
        input.click()
    })
}

const importJsonBtn = document.querySelector('#importJson')
if (importJsonBtn) {
    importJsonBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        let input = document.querySelector('#importJsonFile')
        if (!input) {
            input = document.createElement('input')
            input.type = 'file'
            input.id = 'importJsonFile'
            input.accept = 'application/json,.json'
            input.hidden = true
            document.body.appendChild(input)
            input.addEventListener('change', (evt) => {
                const f = evt.target.files && evt.target.files[0]
                if (f) importMeshFromFile(f)
                evt.target.value = ''
            })
        }
        input.click()
    })
}

// ===== Event listeners GLOBAUX du document/canvas =====

document.addEventListener('contextmenu', (e) => {
    if (e.target.id === 'board') e.preventDefault()
}, false)

document.addEventListener('mousedown', (e) => {
    if (e.target.id !== 'board') return
    // Preview = visualisation seule : seul le clic milieu reste un
    // geste de navigation (pan). Le clic GAUCHE sort de la preview
    // (« sortir au clic ») : le clic est avalé (return avant de poser
    // la selectionBox) pour ne pas déclencher un lasso / une selection
    // sur le coup qui quitte. Le clic droit reste ignoré (grab).
    // Rationale : voir DESIGN.md §2.6.2
    if (state.previewMode) {
        if (e.button === 0) togglePreview()
        if (e.button !== 1) return
    }
    // Mode cercle : le clic gauche commence un trace (centre), le clic
    // droit annule le trace en cours sans quitter le mode ; le clic
    // milieu garde son role de pan (branche e.button === 1 plus bas).
    if (state.circleMode && !state.previewMode) {
        if (e.button === 0) {
            beginCircleGesture(e)
            return
        }
        if (e.button === 2) {
            cancelCircleGesture()
            return
        }
    }
    // Forme predéfinie armee : le clic gauche commence le trace (ancre
    // = coin pour rect/carre, centre sinon), le clic droit annule le
    // trace en cours sans desarmer ; le clic milieu garde son role de
    // pan (branche e.button === 1 plus bas).
    if (state.shapeKind !== undefined && !state.previewMode) {
        if (e.button === 0) {
            beginShapeGesture(e)
            return
        }
        if (e.button === 2) {
            cancelShapeGesture()
            return
        }
    }
    const mousePos = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    if (e.button === 2) {
        beginGrabbing(e)
    } else if (e.button === 0) {
        // Left drag is reserved for selection/lasso; it never moves geometry.
        state.selectionBoxStart = mousePos
        state.selectionBoxCurrent = mousePos
        state.isSelectingBox = true
    } else if (e.button === 1) {
        startPan(mousePos)
    }
})

document.addEventListener('mousemove', (e) => {
    if (state.isPanning) {
        const mouseScreen = {
            x: e.x - state.board.getBoundingClientRect().x,
            y: e.y - state.board.getBoundingClientRect().y,
        }
        updatePan(mouseScreen)
    }
    if (e.target.id === 'board') resolveMouseMoveOnBoard(e)
})

document.addEventListener('mouseup', (e) => {
    const wasGrabbing = grabbed()
    if (wasGrabbing) endGrabbing(e)
    if (state.isPanning && e.button === 1) endPan()
    // Mode cercle : le relachement du clic gauche commite le cercle
    // (rayon = distance centre -> curseur au release). Retour avant la
    // logique de selection-box (jamais armee en mode cercle).
    if (state.circleMode && !state.previewMode && e.button === 0) {
        commitCircleGesture(e)
        return
    }
    // Forme predéfinie armee : le relachement du clic gauche commite la
    // forme (taille = coin oppose ou rayon au release). Retour avant la
    // logique de selection-box (jamais armee en mode forme).
    if (state.shapeKind !== undefined && !state.previewMode && e.button === 0) {
        commitShapeGesture(e)
        return
    }
    const boardTarget = e.target && e.target.id === 'board'
    if (state.isSelectingBox) {
        if (boardTarget && state.selectionBoxStart && state.selectionBoxCurrent) {
            const dist = Math.hypot(state.selectionBoxCurrent.x - state.selectionBoxStart.x, state.selectionBoxCurrent.y - state.selectionBoxStart.y)
            if (dist < 5) {
                processMouseUpSelection(e)
            }
            // dist >= 5 (lasso) : state.selectedPoints a deja ete mis a
            // jour par resolveMouseMoveOnBoard pendant le drag. On force
            // ici une invalidation finale du cache offscreen pour couvrir
            // le cas ou la derniere mousemove n'a pas eu lieu (release
            // sans mouvement final) ou etait en dehors du canvas de hit.
            // Sans ce requestDraw, renderSceneToOffscreen ne repeint pas
            // la selection et les points engages restent invisibles
            // jusqu'au prochain grab/rotate.
            requestDraw()
            updateSelectionHud()
        }
        // Always clear the gesture, including a release outside the canvas.
        state.isSelectingBox = false
        state.selectionBoxStart = undefined
        state.selectionBoxCurrent = undefined
    }
    if (!wasGrabbing && e.button === 2 && boardTarget && !state.previewMode && !state.circleMode && state.shapeKind === undefined && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        // If no grab target was armed, a plain right click still has
        // selection semantics (including empty-space deselection).
        // En mode cercle / forme armee, le clic droit a deja ete
        // consomme par cancelCircleGesture / cancelShapeGesture
        // (mousedown) : on ne re-selectionne pas.
        processRightClickSelection(e)
    }
})

document.addEventListener('keydown', (e) => {
    // Preview : aucune action d'edition au clavier — meme le
    // Backspace (suppression) est ignore pour ne pas muter la scene
    // qu'on visualise. Les raccourcis P / Echap sortent de la preview
    // (le clic gauche sur le canvas aussi, cf. mousedown §2.6.2).
    // Rationale : voir DESIGN.md §2.6.2
    // Mode cercle : Backspace annule le trace en cours (comme le clic
    // droit) au lieu de supprimer un point — la construction prime.
    if (e.code === 'Backspace' && state.circleMode && !state.previewMode) {
        e.preventDefault()
        cancelCircleGesture()
        return
    }
    // Forme armee : Backspace annule le trace en cours (comme le clic
    // droit) au lieu de supprimer un point — la construction prime.
    if (e.code === 'Backspace' && state.shapeKind !== undefined && !state.previewMode) {
        e.preventDefault()
        cancelShapeGesture()
        return
    }
    if (e.code === 'Backspace' && !state.previewMode) {
        if (e.shiftKey) {
            showResetModal()
        } else if (state.selectionMode === 'segment') {
            deleteSelectedSegment()
        } else if (state.selectionMode === 'triangle') {
            deleteSelectedTriangle()
        } else {
            deleteSelectedPoint()
        }
    }
    const t = e.target
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const inGridBtn = t && typeof t.closest === 'function' && t.closest('#grid')
    const inReticleBtn = t && typeof t.closest === 'function' && t.closest('#reticle')
    if (!typing && !inGridBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        toggleGrid()
    }
    if (!typing && !inReticleBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        toggleReticle()
    }
    const helpM = document.querySelector('#helpModal')
    const isHelpOpen = helpM && !helpM.hidden
    const wantsHelp = !typing && (e.key === '?' || e.code === 'Help')
    if (wantsHelp && !e.repeat) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        else showHelp()
    }
    const resetM = document.querySelector('#resetModal')
    const deleteShapeM = document.querySelector('#deleteShapeModal')
    const mergeErrorM = document.querySelector('#mergeErrorModal')
    const isResetOpen = resetM && !resetM.hidden
    const isDeleteShapeOpen = deleteShapeM && !deleteShapeM.hidden
    const isMergeErrorOpen = mergeErrorM && !mergeErrorM.hidden
    // Escape : en preview, priorite absolue — on quitte la preview
    // avant toute consideration de modale (la chrome est masquee, un
    // modal ouvert n'a pas de sens a l'ecran).
    if (e.code === 'Escape' && !e.repeat && state.previewMode) {
        e.preventDefault()
        togglePreview()
        return
    }
    // Mode cercle : Echap quitte le mode (et efface le trace en
    // cours). Placer apres la branche preview (priorite absolue en
    // preview) et avant les modales (le mode cercle n'est pas un
    // modal).
    if (e.code === 'Escape' && !e.repeat && state.circleMode) {
        e.preventDefault()
        exitCircleMode()
        return
    }
    // Panneau #shapes : Echap ferme le panneau ouvert, sinon désarme
    // l'outil forme (annule le geste sans creer).
    if (e.code === 'Escape' && !e.repeat && (state.shapesPanelOpen || state.shapeKind !== undefined)) {
        e.preventDefault()
        if (state.shapesPanelOpen) closeShapesPanel()
        else disarmShapeTool()
        return
    }
    if (e.code === 'Escape' && !e.repeat && (isHelpOpen || isResetOpen || isDeleteShapeOpen || isMergeErrorOpen)) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        if (isResetOpen) hideResetModal()
        if (isDeleteShapeOpen) hideDeleteShapeModal()
        if (isMergeErrorOpen) hideMergeErrorModal()
    }
    if (e.code === 'Escape' && !e.repeat && state.isTriangleColorPanelOpen && !isHelpOpen && !isResetOpen && !isDeleteShapeOpen && !isMergeErrorOpen) {
        e.preventDefault()
        hideTriangleColorPanel()
    }
    const inFpsBtn = t && typeof t.closest === 'function' && t.closest('#fps')
    if (!typing && !inFpsBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        toggleFps()
    }
    const inPreviewBtn = t && typeof t.closest === 'function' && t.closest('#preview')
    // !e.repeat : maintenir P enfonce ne doit pas faire clignoter la
    // preview on/off (impact visuel beaucoup plus lourd que G/R/F :
    // toute la chrome disparait/reapparait). Même pattern que le '?'
    // et Ctrl+0.
    if (!typing && !inPreviewBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyP' && !e.repeat) {
        e.preventDefault()
        togglePreview()
    }
    const inCircleBtn = t && typeof t.closest === 'function' && t.closest('#circle')
    // C = toggle du mode cercle. !e.repeat : maintenir C enfonce ne
    // doit pas clignoter le mode on/off (impact visuel du bouton + du
    // compteur), meme pattern que P. Le focus sur le bouton lui-meme
    // est exclu (la touche Espace/Entrée y suffit).
    if (!typing && !inCircleBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC' && !e.repeat) {
        e.preventDefault()
        toggleCircleMode()
    }
    // Preview = visualisation seule : undo/redo sont des mutations de
    // scene — elles resteraient invisibles a l'ecran (geometrie
    // masquee) et sont donc ignorees. Ctrl+S (export) et Ctrl+0
    // (reset zoom) restent disponibles : non-mutants de la scene.
    if (!state.previewMode && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        redo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        saveMesh()
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'Digit0' || e.key === '0')) {
        if (e.repeat) return
        e.preventDefault()
        resetZoom()
    }
})

// ===== Apply console frame restored from localStorage =====
applyConsoleFrame()
updateConsoleButton()
updateAccessibilityLabels()
updateSceneStatus()
updateFpsButton()

// ===== Boot =====

const doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
    updateZoomDisplay()
    updateUndoRedoHud()
    updateSelectionHud()
    updateSelectionModeButton()
    updateAccessibilityLabels()
    updateSceneStatus()
    updateColorButtonState()
    updateCircleButton()
    updateShapesButton()
    log('App ready')
}

doit()
