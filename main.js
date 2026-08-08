// Rationale : voir DESIGN.md §4.1

import { state, initDomRefs, boardOffset } from './state.js'
import { drawBoard, requestDraw, getDevicePixelRatio, kioskSelectedIndex } from './draw.js'
import { CANVAS_BACKGROUND } from './constants.js'
import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateConsoleButton,
    updateSelectionModeButton, updateColorButtonState, updateAccessibilityLabels, updateSceneStatus,
    updateShapesButton, updateAllFillsButton,
} from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import {
    selectAllPoints, deleteSelectedPoint, deleteSelectedSegment, deleteSelectedTriangle,
    endGrabbing, grabbed, resolveMouseMoveOnBoard, beginGrabbing,
    processMouseUpSelection, processRightClickSelection, wireBoardDrop,    wireTriangleColorPanel,
    hideTriangleColorPanel, restoreColorPalette, cancelPaletteEdit,
    paintTriangleAtCursor,
    toggleCircleMode, beginCircleGesture, commitCircleGesture, cancelCircleGesture, exitCircleMode,
    beginStarGesture, lockStarRadius, commitStarGesture, cancelStarGesture, exitStarMode,
    beginAnnulusGesture, lockAnnulusRadius, commitAnnulusGesture, cancelAnnulusGesture, exitAnnulusMode,
    wireShapesPanel, beginShapeGesture, commitShapeGesture, cancelShapeGesture,
    disarmShapeTool, closeShapesPanel,
    copySelection, cutSelection, pasteClipboard,
    wireAlignPanel, closeAlignPanel,
    alignSelectedPointsX, alignSelectedPointsY, distributeSelectedPointsX, distributeSelectedPointsY,
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
    restoreFpsVisible, wireFpsControl, toggleFps, updateFpsButton, startFpsCounter,
    wireGridControl, togglePreview, exitPreview, wirePreviewControl, wireCircleWheelControl,
    restoreCircleSegments, wireMergeDropWheelControl, restoreMergeDropRadius,
    toggleKiosk, exitKiosk, wireKioskControl,
    restoreAllFills, wireAllFillsControl,
} from './viewport.js'
import { wireConsoleOverlay, wireClearConsole, applyConsoleFrame } from './console_overlay.js'
import {
    showHelp, hideHelp, wireHelpModal,
    showResetModal, hideResetModal, wireResetModal,
    showSaveModal, hideSaveModal, wireSaveModal,
} from './modals.js'
import {
    prevShape, nextShape, moveShapeUp, moveShapeDown, addShape, deleteShape, hideDeleteShapeModal, wireDeleteShapeModal,
    goToShape,
} from './shapes.js'
import { mergeSelectedPoints, wireMergeErrorModal, hideMergeErrorModal, attemptDropMerge } from './merge.js'
import { log } from './log.js'

// ===== Init DOM refs et canvas =====

initDomRefs()
state.body.style.overflow = 'hidden'
state.board.style.border = 'solid 1px black'
state.board.style.width = '99vw'
state.board.style.height = '99vh'
// Bitmap en pixels PHYSIQUES (CSS x dpr) ; coords internes en CSS px —
// conversion ici (taille) et dans draw.js (transform dpr).
const bootRect = state.board.getBoundingClientRect()
// Cache du rect pour les handlers souris (perf, cf. boardOffset).
state._boardRect = bootRect
const bootDpr = getDevicePixelRatio()
state.board.width = Math.round(bootRect.width * bootDpr)
state.board.height = Math.round(bootRect.height * bootDpr)
state.board.style.cursor = 'none'
state.ctx.center.x = bootRect.width / 2
state.ctx.center.y = bootRect.height / 2
state._ctx = state.board.getContext('2d')
// fillRect du boot sous transform IDENTITE (dpr non encore pose) :
// les dimensions physiques remplissent exactement le bitmap.
state._ctx.fillStyle = CANVAS_BACKGROUND
state._ctx.fillRect(0, 0, state.board.width, state.board.height)

// ===== Resize navigateur : resync du bitmap sans stretch =====
// Sans ce handler, le navigateur etire le bitmap fige -> geometrie
// distordue apres un resize. Garde « taille inchangee => return » :
// resetter le bitmap efface la surface, et les navigateurs emettent
// des resize pour d'autres raisons (scrollbars, zoom). `center` est
// recentre sur le milieu CSS (invariant « viewCenter = point modele
// centre »). Le dpr est relu a chaque evenement (passage entre deux
// ecrans de densites differentes). cf. DESIGN.md §2.7.
const resizeCanvasToFitBrowser = () => {
    const rect = state.board.getBoundingClientRect()
    // Le rect peut changer sans changer la taille du bitmap (garde ci-dessous).
    state._boardRect = rect
    const dpr = getDevicePixelRatio()
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    // Garde double (bitmap + centre CSS) : couvre le cas ou la taille
    // physique coinciderait (cssW x dpr identique) mais pas le centre.
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
    restoreMergeDropRadius()
    restoreAllFills()
    restoreColorPalette()

// ===== Branchement des listeners "locaux" =====

wireGridControl()
    wireCircleWheelControl()
    wireMergeDropWheelControl()
    wireReticleControl()
    wireSelectionModeControl()
    wireConsoleToggle()
    wireFpsControl()
    wirePreviewControl()
    wireConsoleOverlay()
    wireClearConsole()
wireHelpModal()
wireResetModal(() => resetAll())
// Valider transmet le nom choisi a saveMesh (fichier « <nom>.json »
// + nom de scene adopte + emplacement enregistre).
wireSaveModal((name) => saveMesh(name))
wireDeleteShapeModal()
wireMergeErrorModal()
wireBoardDrop()
wireBoardWheel()
wireBeforeUnload()
wireTriangleColorPanel()
wireShapesPanel()
wireAlignPanel()
wireKioskControl()
wireAllFillsControl()

// ===== Toolbar buttons =====

const wireButton = (id, handler) => {
    const btn = document.querySelector('#' + id)
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        handler()
    })
}

// Ouvre la fenêtre d'enregistrement (positionnée sur l'emplacement
// précédent) ; en preview on sort d'abord (la chrome est masquée).
const openSaveModal = () => {
    // Sortie DIRECTE (exitPreview) : le cycle est réservé au bouton / P.
    if (state.previewMode) exitPreview()
    showSaveModal()
}

wireButton('export', () => openSaveModal())
wireButton('reset', () => showResetModal())
wireButton('selectAll', () => selectAllPoints())
wireButton('copy', () => copySelection())
wireButton('cut', () => cutSelection())
wireButton('paste', () => pasteClipboard())
// Le bouton #align est câblé par wireAlignPanel (editor.js) ; ses
// raccourcis clavier Alt+←/→ / Alt+Shift+←/→ plus bas.
wireButton('helpBtn', () => showHelp())
wireButton('prevShape', () => prevShape())
wireButton('nextShape', () => nextShape())
// Le bouton #kiosk est câblé par wireKioskControl (viewport.js), meme
// pattern que #preview — pas de wireButton ici (double toggle sinon).
wireButton('moveShapeUp', () => moveShapeUp())
wireButton('moveShapeDown', () => moveShapeDown())
// + plan vide : clic GAUCHE = insérer AVANT le plan courant, clic
// DROIT (contextmenu, preventDefault — le listener global ne protège
// que le board) = insérer APRÈS (évolution « intercaler avant/après »,
// cf. DESIGN.md §7.17). Pas de wireButton : le clic droit n'est pas un
// 'click' standard.
const newShapeBtn = document.querySelector('#newShape')
if (newShapeBtn) {
    newShapeBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        addShape('before')
    })
    // e.button === 2 : exclut le contextmenu clavier (Menu / Shift+F10,
    // button 0) — seul le clic droit souris insère.
    newShapeBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        if (e.button === 2) addShape('after')
    })
}
wireButton('deleteShape', () => deleteShape())
wireButton('mergePoints', () => mergeSelectedPoints())
wireButton('undo', () => undo())
wireButton('redo', () => redo())

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
    // Kiosque : le clic gauche sélectionne le plan MIS EN AVANT (même
    // règle linéaire que l'affichage, évaluée à l'abscisse du clic —
    // jamais un plan précédent/suivant quand le pointeur est hors de la
    // carte mise en avant) et sort du mode ; le clic droit annule sans
    // changement ; le milieu est consommé (pas de pan).
    if (state.kioskMode) {
        if (e.button === 0) {
            const mousePos = {
                x: e.x - boardOffset().x,
                y: e.y - boardOffset().y,
            }
            const idx = kioskSelectedIndex(mousePos.x)
            if (idx !== -1) goToShape(idx)
            exitKiosk()
        } else if (e.button === 2) {
            exitKiosk()
        }
        return
    }
    // Preview = visualisation seule : seul le clic milieu panne. Le
    // clic gauche sort (exitPreview, avalé pour ne pas déclencher un
    // lasso) ; le droit reste ignoré.
    if (state.previewMode) {
        if (e.button === 0) exitPreview()
        if (e.button !== 1) return
    }
    // Mode cercle : 1er clic = beginCircleGesture (centre), 2e clic =
    // commitCircleGesture (valide) + exitCircleMode. Clic droit =
    // annule le trace sans quitter le mode ; milieu = pan.
    if (state.circleMode && !state.previewMode) {
        if (e.button === 0) {
            if (state.circleCenterModel) {
                commitCircleGesture(e)
            } else {
                beginCircleGesture(e)
            }
            return
        }
        if (e.button === 2) {
            cancelCircleGesture()
            return
        }
    }
    // Mode étoile (3 clics) : centre, verrou rayon+angle (phase
    // profondeur), validation. Clic droit annule, milieu pan.
    if (state.starMode && !state.previewMode) {
        if (e.button === 0) {
            if (!state.starCenterModel) {
                beginStarGesture(e)
            } else if (state.starPhase === 1) {
                commitStarGesture(e)
            } else {
                lockStarRadius(e)
            }
            return
        }
        if (e.button === 2) {
            cancelStarGesture()
            return
        }
    }
    // Mode anneau (3 clics) : centre, verrou rayon externe + angle
    // (phase trou), validation. Clic droit annule, milieu pan.
    if (state.annulusMode && !state.previewMode) {
        if (e.button === 0) {
            if (!state.annulusCenterModel) {
                beginAnnulusGesture(e)
            } else if (state.annulusPhase === 1) {
                commitAnnulusGesture(e)
            } else {
                lockAnnulusRadius(e)
            }
            return
        }
        if (e.button === 2) {
            cancelAnnulusGesture()
            return
        }
    }
    // Forme armee (2 clics) : ancre (coin ou centre) puis validation.
    // Le mouseup ne cree rien ; clic droit annule sans desarmer, milieu pan.
    if (state.shapeKind !== undefined && !state.previewMode) {
        if (e.button === 0) {
            if (state.shapeAnchorModel) {
                commitShapeGesture(e)
            } else {
                beginShapeGesture(e)
            }
            return
        }
        if (e.button === 2) {
            cancelShapeGesture()
            return
        }
    }
    // Pinceau arme : le clic gauche peint au lieu de lasso/selection ;
    // droit et milieu gardent leur semantique (deplacement, pan).
    if (state.brushMode && !state.previewMode && e.button === 0) {
        paintTriangleAtCursor(e)
        return
    }
    const mousePos = {
        x: e.x - boardOffset().x,
        y: e.y - boardOffset().y,
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
            x: e.x - boardOffset().x,
            y: e.y - boardOffset().y,
        }
        updatePan(mouseScreen)
    }
    if (e.target.id === 'board') resolveMouseMoveOnBoard(e)
})

document.addEventListener('mouseup', (e) => {
    const wasGrabbing = grabbed()
    const grabMoved = wasGrabbing ? endGrabbing(e) : false
    // Fusion par deplacement (cf. DESIGN.md §7.11) : tente la fusion
    // au relachement d'un grab arme ayant reellement bouge la geometrie
    // (movedScene exclut le clic droit simple).
    if (wasGrabbing && grabMoved) attemptDropMerge()
    if (state.isPanning && e.button === 1) endPan()
    // Le mouseup ne valide ni le cercle ni la forme (le 2e mousedown
    // valide, l'angle se fige au relachement du 1er) : no-op en mode
    // cercle/forme, comme en mode etoile/anneau.
    const boardTarget = e.target && e.target.id === 'board'
    if (state.isSelectingBox) {
        if (boardTarget && state.selectionBoxStart && state.selectionBoxCurrent) {
            const dist = Math.hypot(state.selectionBoxCurrent.x - state.selectionBoxStart.x, state.selectionBoxCurrent.y - state.selectionBoxStart.y)
            if (dist < 5) {
                processMouseUpSelection(e)
            }
            // Invalidation finale : couvre le cas d'une derniere
            // mousemove absente (release sans mouvement ou hors canvas).
            requestDraw()
            updateSelectionHud()
        }
        state.isSelectingBox = false
        state.selectionBoxStart = undefined
        state.selectionBoxCurrent = undefined
    }
    if (!wasGrabbing && e.button === 2 && boardTarget && !state.previewMode && !state.circleMode && !state.starMode && !state.annulusMode && state.shapeKind === undefined && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        // Clic droit sans grab = selection (deselection incluse). En
        // mode cercle/etoile/anneau/forme, le clic droit a deja ete
        // consomme au mousedown (cancel*Gesture) : on ne re-selectionne pas.
        processRightClickSelection(e)
    }
})

document.addEventListener('keydown', (e) => {
    // Preview : aucune edition au clavier (Backspace compris).
    // Backspace en mode cercle/etoile/anneau/forme : annule le trace
    // en cours (comme le clic droit) — la construction prime.
    if (e.code === 'Backspace' && state.circleMode && !state.previewMode) {
        e.preventDefault()
        cancelCircleGesture()
        return
    }
    if (e.code === 'Backspace' && state.starMode && !state.previewMode) {
        e.preventDefault()
        cancelStarGesture()
        return
    }
    if (e.code === 'Backspace' && state.annulusMode && !state.previewMode) {
        e.preventDefault()
        cancelAnnulusGesture()
        return
    }
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
    const saveM = document.querySelector('#saveModal')
    const isResetOpen = resetM && !resetM.hidden
    const isDeleteShapeOpen = deleteShapeM && !deleteShapeM.hidden
    const isMergeErrorOpen = mergeErrorM && !mergeErrorM.hidden
    const isSaveOpen = saveM && !saveM.hidden
    // Echap en kiosque : sortie sans changement (le clic sélectionne).
    if (e.code === 'Escape' && !e.repeat && state.kioskMode) {
        e.preventDefault()
        exitKiosk()
        return
    }
    // Echap en preview : priorite absolue, sortie directe des deux etats.
    if (e.code === 'Escape' && !e.repeat && state.previewMode) {
        e.preventDefault()
        exitPreview()
        return
    }
    // Echap en mode cercle : quitte le mode et efface le trace en cours.
    if (e.code === 'Escape' && !e.repeat && state.circleMode) {
        e.preventDefault()
        exitCircleMode()
        return
    }
    if (e.code === 'Escape' && !e.repeat && state.starMode) {
        e.preventDefault()
        exitStarMode()
        return
    }
    if (e.code === 'Escape' && !e.repeat && state.annulusMode) {
        e.preventDefault()
        exitAnnulusMode()
        return
    }
    // Echap : ferme le panneau #shapes, sinon desarme l'outil forme.
    if (e.code === 'Escape' && !e.repeat && (state.shapesPanelOpen || state.shapeKind !== undefined)) {
        e.preventDefault()
        if (state.shapesPanelOpen) closeShapesPanel()
        else disarmShapeTool()
        return
    }
    // Echap : ferme le panneau #align (meme contrat que #shapesPanel).
    if (e.code === 'Escape' && !e.repeat && state.alignPanelOpen) {
        e.preventDefault()
        closeAlignPanel()
        return
    }
    if (e.code === 'Escape' && !e.repeat && (isHelpOpen || isResetOpen || isDeleteShapeOpen || isSaveOpen || isMergeErrorOpen)) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        if (isResetOpen) hideResetModal()
        if (isDeleteShapeOpen) hideDeleteShapeModal()
        if (isSaveOpen) hideSaveModal()
        if (isMergeErrorOpen) hideMergeErrorModal()
    }
    // Echap en mode edition de swatch : annule l'edition sans fermer
    // le panneau (qui ne se ferme qu'au second Echap).
    if (e.code === 'Escape' && !e.repeat && state.colorPaletteEditingIndex != null) {
        e.preventDefault()
        cancelPaletteEdit()
        return
    }
    if (e.code === 'Escape' && !e.repeat && state.isTriangleColorPanelOpen && !isHelpOpen && !isResetOpen && !isDeleteShapeOpen && !isSaveOpen && !isMergeErrorOpen) {
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
    // preview (toute la chrome disparait/reapparait).
    if (!typing && !inPreviewBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyP' && !e.repeat) {
        e.preventDefault()
        togglePreview()
    }
    // C = toggle du mode cercle (aussi dans le panneau Formes) ; !e.repeat.
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC' && !e.repeat) {
        e.preventDefault()
        toggleCircleMode()
    }
    // Alt+K : ouvre / ferme le kiosque de sélection des plans. Gardes :
    // typing, AltGr exclu (!e.ctrlKey), !e.repeat. En preview, toggleKiosk
    // sort d'abord (chrome masquée, le raccourci reste actif).
    if (!typing && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.code === 'KeyK') {
        e.preventDefault()
        toggleKiosk()
    }
    // Alt+↑/↓ : deplace le plan actif d'un rang (memes fonctions que
    // les boutons #moveShapeUp/Down). Gardes : typing, preview, AltGr
    // (!e.ctrlKey), !e.repeat ; bornes gerees par moveShapeUp/Down.
    if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.code === 'ArrowUp') {
        e.preventDefault()
        moveShapeUp()
    } else if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.code === 'ArrowDown') {
        e.preventDefault()
        moveShapeDown()
    }
    // Alt+←/→ alignent sur l'ancre, Alt+Shift+←/→ répartissent entre
    // les extremes (cf. DESIGN.md §7.14). Memes gardes que l'ordre des
    // plans ; no-op si selection trop petite (align < 2, repartir < 3).
    if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.shiftKey && e.code === 'ArrowLeft') {
        e.preventDefault()
        distributeSelectedPointsX()
    } else if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.shiftKey && e.code === 'ArrowRight') {
        e.preventDefault()
        distributeSelectedPointsY()
    } else if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && !e.shiftKey && e.code === 'ArrowLeft') {
        e.preventDefault()
        alignSelectedPointsX()
    } else if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && !e.shiftKey && e.code === 'ArrowRight') {
        e.preventDefault()
        alignSelectedPointsY()
    }
    // Preview : undo/redo ignores (mutations de scene invisibles a
    // l'ecran) ; Ctrl+0 reste dispo ; Ctrl+S sort d'abord de la preview.
    if (!state.previewMode && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        redo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
    // Ctrl+C/X/V = presse-papiers interne (memes fonctions que les
    // boutons). La garde `typing` est INDISPENSABLE pour Ctrl+V (ne
    // pas intercepter le collage natif dans un champ) ; ignores en preview.
    } else if (!state.previewMode && !typing && !e.shiftKey && (e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        copySelection()
    } else if (!state.previewMode && !typing && !e.shiftKey && (e.ctrlKey || e.metaKey) && (e.code === 'KeyX' || e.key === 'x' || e.key === 'X')) {
        e.preventDefault()
        cutSelection()
    } else if (!state.previewMode && !typing && !e.shiftKey && (e.ctrlKey || e.metaKey) && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        pasteClipboard()
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        openSaveModal()
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
updateAllFillsButton()
// Compteur FPS discret (pilule toolbar) : toujours visible, la boucle
// rAF demarre au boot et ne s'arrete jamais (cf. DESIGN.md §2.4.1).
startFpsCounter()

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
    updateShapesButton()
    log('App ready')
}

doit()
