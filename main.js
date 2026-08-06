// Rationale : voir DESIGN.md §4.1

import { state, initDomRefs } from './state.js'
import { drawBoard, requestDraw, getDevicePixelRatio } from './draw.js'
import { CANVAS_BACKGROUND } from './constants.js'
import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateConsoleButton,
    updateSelectionModeButton, updateColorButtonState, updateAccessibilityLabels, updateSceneStatus,
    updateShapesButton,
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
    restoreFpsVisible, wireFpsControl, toggleFps, updateFpsButton,
    wireGridControl, togglePreview, exitPreview, wirePreviewControl, wireCircleWheelControl,
    restoreCircleSegments, wireMergeDropWheelControl, restoreMergeDropRadius,
} from './viewport.js'
import { wireConsoleOverlay, wireClearConsole, applyConsoleFrame } from './console_overlay.js'
import {
    showHelp, hideHelp, wireHelpModal,
    showResetModal, hideResetModal, wireResetModal,
    showSaveModal, hideSaveModal, wireSaveModal,
} from './modals.js'
import {
    prevShape, nextShape, moveShapeUp, moveShapeDown, addShape, deleteShape, hideDeleteShapeModal, wireDeleteShapeModal,
} from './shapes.js'
import { mergeSelectedPoints, wireMergeErrorModal, hideMergeErrorModal, attemptDropMerge } from './merge.js'
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
    restoreMergeDropRadius()
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
// La fenêtre d'enregistrement (évolution « enregistrement scène ») :
// valider transmet le nom choisi à saveMesh, qui télécharge
// « <nom>.json », adopte ce nom de scène et enregistre l'emplacement.
wireSaveModal((name) => saveMesh(name))
wireDeleteShapeModal()
wireMergeErrorModal()
wireBoardDrop()
wireBoardWheel()
wireBeforeUnload()
wireTriangleColorPanel()
wireShapesPanel()
wireAlignPanel()

// ===== Toolbar buttons =====

const wireButton = (id, handler) => {
    const btn = document.querySelector('#' + id)
    if (!btn) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        handler()
    })
}

// La sauvegarde (bouton #export ET Ctrl+S) ouvre la fenêtre de
// sélection de l'emplacement avec renommage (modals.js), positionnée
// sur l'emplacement précédent. En preview la chrome (et donc les
// modales) est masquée : on sort d'abord de la preview pour que la
// fenêtre soit visible — le geste est non-mutant pour la scène.
const openSaveModal = () => {
    // Sortie DIRECTE (exitPreview, pas togglePreview) : depuis l'état
    // plans ou preview simple, on quitte complètement — le cycle
    // off -> preview -> plans -> off est réservé au bouton / P.
    if (state.previewMode) exitPreview()
    showSaveModal()
}

wireButton('export', () => openSaveModal())
wireButton('reset', () => showResetModal())
wireButton('selectAll', () => selectAllPoints())
wireButton('copy', () => copySelection())
wireButton('cut', () => cutSelection())
wireButton('paste', () => pasteClipboard())
// (évolution « boutons pour forcer l'alignement et la répartition des
// points sélectionnés ») le bouton #align est câblé par wireAlignPanel
// (editor.js) qui gère l'ouverture/fermeture + le clic extérieur + les
// 4 actions du panneau. Raccourcis clavier Alt+←/→ / Alt+Shift+←/→
// plus bas (mêmes fonctions que les boutons du panneau).
wireButton('helpBtn', () => showHelp())
wireButton('prevShape', () => prevShape())
wireButton('nextShape', () => nextShape())
wireButton('moveShapeUp', () => moveShapeUp())
wireButton('moveShapeDown', () => moveShapeDown())
wireButton('newShape', () => addShape())
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
    // Preview = visualisation seule : seul le clic milieu reste un
    // geste de navigation (pan). Le clic GAUCHE sort de la preview
    // (« sortir au clic ») : le clic est avalé (return avant de poser
    // la selectionBox) pour ne pas déclencher un lasso / une selection
    // sur le coup qui quitte. Sortie DIRECTE (exitPreview, pas
    // togglePreview) : depuis l'état plans comme depuis la preview
    // simple. Le clic droit reste ignoré (grab).
    // Rationale : voir DESIGN.md §2.6.2
    if (state.previewMode) {
        if (e.button === 0) exitPreview()
        if (e.button !== 1) return
    }
    // Mode cercle : geste en 2 temps (orientation par souris) —
    //   1. 1er mousedown gauche sur board : beginCircleGesture (pose
    //      le centre) ; les mousemove suivants regleront rayon + angle.
    //   2. 2e mousedown gauche sur board : commitCircleGesture (valide
    //      le cercle avec le rayon et l'angle courants) +
    //      exitCircleMode (l'utilisateur recommence pour un autre
    //      cercle).
    // Le clic droit annule le trace en cours (centre + rayon + angle)
    // sans quitter le mode, exactement comme avant ; le clic milieu
    // garde son role de pan (branche e.button === 1 plus bas).
    // L'ancien geste « mouseup valide » a ete supprime : voir le
    // handler mouseup plus bas, qui n'a plus de branche circleMode.
    if (state.circleMode && !state.previewMode) {
        if (e.button === 0) {
            if (state.circleCenterModel) {
                // 2e clic : valide le cercle (rayon + angle captures
                // au dernier mousemove, rafralchis sur la position
                // exacte du 2e mousedown dans commitCircleGesture).
                commitCircleGesture(e)
            } else {
                // 1er clic : pose le centre, attend les mousemove
                // (rayon + angle) et le 2e clic validant.
                beginCircleGesture(e)
            }
            return
        }
        if (e.button === 2) {
            cancelCircleGesture()
            return
        }
    }
    // Mode étoile : geste en 3 temps (evolution « meme logique que le
    // cercle + profondeur des branches au 3e clic ») —
    //   1. 1er mousedown gauche : beginStarGesture (pose le centre) ;
    //      les mousemove reglent rayon + angle.
    //   2. 2e mousedown gauche : lockStarRadius (verrouille rayon +
    //      angle, passe en phase profondeur) ; les mousemove reglent
    //      la profondeur des branches (starInnerRatio).
    //   3. 3e mousedown gauche : commitStarGesture (valide l'etoile
    //      avec rayon + angle + profondeur courants) + exitStarMode.
    // Le clic droit annule le trace en cours sans quitter le mode,
    // le clic milieu garde son role de pan (branche e.button === 1
    // plus bas).
    if (state.starMode && !state.previewMode) {
        if (e.button === 0) {
            if (!state.starCenterModel) {
                // 1er clic : pose le centre.
                beginStarGesture(e)
            } else if (state.starPhase === 1) {
                // 3e clic : valide l'etoile (rayon + angle + profondeur).
                commitStarGesture(e)
            } else {
                // 2e clic : verrouille rayon + angle, phase profondeur.
                lockStarRadius(e)
            }
            return
        }
        if (e.button === 2) {
            cancelStarGesture()
            return
        }
    }
    // Mode anneau : geste en 3 temps (evolution « création d'un
    // cercle percé d'un trou », meme logique que l'etoile + reglage
    // du trou au 3e clic) —
    //   1. 1er mousedown gauche : beginAnnulusGesture (pose le
    //      centre) ; les mousemove reglent rayon externe + angle.
    //   2. 2e mousedown gauche : lockAnnulusRadius (verrouille rayon
    //      externe + angle, passe en phase trou) ; les mousemove
    //      reglent la taille du trou (annulusInnerRatio).
    //   3. 3e mousedown gauche : commitAnnulusGesture (valide
    //      l'anneau avec rayon externe + angle + trou courants) +
    //      exitAnnulusMode.
    // Le clic droit annule le trace en cours sans quitter le mode,
    // le clic milieu garde son role de pan (branche e.button === 1
    // plus bas).
    if (state.annulusMode && !state.previewMode) {
        if (e.button === 0) {
            if (!state.annulusCenterModel) {
                // 1er clic : pose le centre.
                beginAnnulusGesture(e)
            } else if (state.annulusPhase === 1) {
                // 3e clic : valide l'anneau (rayon externe + angle + trou).
                commitAnnulusGesture(e)
            } else {
                // 2e clic : verrouille rayon externe + angle, phase trou.
                lockAnnulusRadius(e)
            }
            return
        }
        if (e.button === 2) {
            cancelAnnulusGesture()
            return
        }
    }
    // Forme predéfinie armee : geste en 2 temps sur le modele du
    // cercle (evolution « generaliser la creation des formes ») —
    //   1. 1er mousedown gauche = ancre (1er coin pour rect/carre,
    //      centre pour les polygones) ; les mousemove reglent taille
    //      + orientation.
    //   2. 2e mousedown gauche = commitShapeGesture (valide la forme
    //      avec taille + orientation courantes) + disarmShapeTool.
    // Le relâchement du 1er clic ne cree rien (le mouseup n'a plus de
    // branche forme, cf. plus bas). Le clic droit annule le trace en
    // cours sans desarmer ; le clic milieu garde son role de pan
    // (branche e.button === 1 plus bas).
    if (state.shapeKind !== undefined && !state.previewMode) {
        if (e.button === 0) {
            if (state.shapeAnchorModel) {
                // 2e clic : valide la forme.
                commitShapeGesture(e)
            } else {
                // 1er clic : pose l'ancre, attend les mousemove.
                beginShapeGesture(e)
            }
            return
        }
        if (e.button === 2) {
            cancelShapeGesture()
            return
        }
    }
    // Pinceau de coloration (palette #triangleColor ouverte et
    // armée) : clic gauche sur un triangle = peintresTriangleAtCursor.
    // On court-circuite la branche lasso / selection-box et la
    // création de points (resolveMouseClickOnBoard). Le clic droit
    // et le clic milieu ne sont PAS affectés — le cahier des charges
    // de l'évolution précise que le bouton droit garde la sémantique
    // de déplacement du mode courant ; le bouton milieu reste le
    // pan. Si brushMode est false (palette ouverte mais Reset
    // cliqué, ou palette fermée), on laisse le comportement normal
    // (lasso / selection / création) filer vers la branche du bas.
    if (state.brushMode && !state.previewMode && e.button === 0) {
        paintTriangleAtCursor(e)
        return
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
    const grabMoved = wasGrabbing ? endGrabbing(e) : false
    // Fusion par déplacement (2e fonction du bouton Fusionner, cf.
    // DESIGN.md §7.11) : après un drag droit qui a RÉELLEMENT bougé le
    // point sélectionné unique (mode armé), le relâchement tente la
    // fusion avec le point le plus proche dans la limite prédéfinie.
    // endGrabbing retourne movedScene pour exclure le clic droit simple
    // (sélection pure, qui aurait pu changer la sélection avant ce point).
    if (wasGrabbing && grabMoved) attemptDropMerge()
    if (state.isPanning && e.button === 1) endPan()
    // Mode cercle : le mouseup gauche NE valide plus le cercle (cf.
    // evolution orientation par souris : c'est le 2e mousedown qui
    // valide, pas le relachement du 1er). On ne fait donc rien ici en
    // mode cercle : le mousedown handler global a deja aiguille le
    // 2e clic vers commitCircleGesture, et le 1er clic vers
    // beginCircleGesture (avec mouseup no-op entre les deux — l'angle
    // de depart se fige sur la derniere valeur du curseur observee
    // avant le relachement, ce qui est la semantique souhaitee par le
    // cahier des charges).
    // Forme predéfinie armee : le relachement du clic gauche ne commite
    // PLUS la forme (evolution « generaliser la creation des formes » :
    // le geste suit le modele du cercle en 2 clics — le 1er clic pose
    // l'ancre, le 2e mousedown valide, cf. mousedown ci-dessus). Le
    // mouseup est donc noop en mode forme, comme en mode cercle/
    // étoile/anneau. Retour avant la logique de selection-box (jamais
    // armee en mode forme).
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
    if (!wasGrabbing && e.button === 2 && boardTarget && !state.previewMode && !state.circleMode && !state.starMode && !state.annulusMode && state.shapeKind === undefined && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        // If no grab target was armed, a plain right click still has
        // selection semantics (including empty-space deselection).
        // En mode cercle / étoile / anneau / forme armee, le clic droit
        // a deja ete consomme par cancelCircleGesture / cancelStarGesture
        // / cancelAnnulusGesture / cancelShapeGesture (mousedown) : on ne
        // re-selectionne pas.
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
    // Mode étoile : Backspace annule le trace en cours (comme le clic
    // droit) au lieu de supprimer un point — la construction prime.
    if (e.code === 'Backspace' && state.starMode && !state.previewMode) {
        e.preventDefault()
        cancelStarGesture()
        return
    }
    // Mode anneau : Backspace annule le trace en cours (comme le clic
    // droit) au lieu de supprimer un point — la construction prime.
    if (e.code === 'Backspace' && state.annulusMode && !state.previewMode) {
        e.preventDefault()
        cancelAnnulusGesture()
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
    const saveM = document.querySelector('#saveModal')
    const isResetOpen = resetM && !resetM.hidden
    const isDeleteShapeOpen = deleteShapeM && !deleteShapeM.hidden
    const isMergeErrorOpen = mergeErrorM && !mergeErrorM.hidden
    const isSaveOpen = saveM && !saveM.hidden
    // Escape : en preview, priorite absolue — on quitte la preview
    // avant toute consideration de modale (la chrome est masquee, un
    // modal ouvert n'a pas de sens a l'ecran). Sortie DIRECTE
    // (exitPreview, pas togglePreview) : Echap ferme depuis l'etat
    // plans comme depuis la preview simple.
    if (e.code === 'Escape' && !e.repeat && state.previewMode) {
        e.preventDefault()
        exitPreview()
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
    // Mode étoile : Echap quitte le mode (et efface le trace en
    // cours), meme contrat que le cercle.
    if (e.code === 'Escape' && !e.repeat && state.starMode) {
        e.preventDefault()
        exitStarMode()
        return
    }
    // Mode anneau : Echap quitte le mode (et efface le trace en
    // cours), meme contrat que le cercle / l'etoile.
    if (e.code === 'Escape' && !e.repeat && state.annulusMode) {
        e.preventDefault()
        exitAnnulusMode()
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
    // Panneau #align (aligner / répartir, évolution « boutons pour
    // forcer l'alignement et la répartition des points sélectionnés ») :
    // Echap ferme le panneau (même contrat que #shapesPanel — placé
    // juste après pour partager la même priorité Echap avant les
    // modales).
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
    // Palette : Echap en mode edition (double-clic sur un swatch) =
    // annuler l'edition (retour a la couleur d'origine) SANS fermer
    // le panneau — il ne se ferme qu'au second Echap. Gere AVANT la
    // branche hideTriangleColorPanel pour intercepter le premier
    // Echap.
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
    // preview on/off (impact visuel beaucoup plus lourd que G/R/F :
    // toute la chrome disparait/reapparait). Même pattern que le '?'
    // et Ctrl+0.
    if (!typing && !inPreviewBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyP' && !e.repeat) {
        e.preventDefault()
        togglePreview()
    }
    // C = toggle du mode cercle (le cercle se choisit aussi dans le
    // panneau Formes). !e.repeat : maintenir C enfonce ne doit pas
    // clignoter le mode on/off (impact visuel du bouton + du compteur),
    // meme pattern que P.
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC' && !e.repeat) {
        e.preventDefault()
        toggleCircleMode()
    }
    // Ordre des formes (évolution « boutons pour gérer l'ordre des
    // formes ») : Alt+Flèche Haut / Bas déplacent la forme active d'un
    // plan (mêmes fonctions que les boutons #moveShapeUp /
    // #moveShapeDown). Gardes : typing (ne pas voler la saisie dans
    // un champ — même politique que Ctrl+C/X/V), preview (visualisation
    // seule, aucune édition — même politique que undo/redo), AltGr
    // détecté via e.ctrlKey (AltGr = Alt+Ctrl, cf. §3.6 : la
    // combinaison ne doit PAS déclencher le déplacement), et e.repeat
    // filtré pour un déplacement par frappe (maintenir Alt+Flèche ne
    // doit pas faire défiler l'ordre en boucle). Les bornes sont gérées
    // par moveShapeUp/Down eux-mêmes (no-op hors bornes) + l'état
    // disabled des boutons.
    if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.code === 'ArrowUp') {
        e.preventDefault()
        moveShapeUp()
    } else if (!typing && !state.previewMode && !e.ctrlKey && !e.metaKey && e.altKey && !e.repeat && e.code === 'ArrowDown') {
        e.preventDefault()
        moveShapeDown()
    }
    // Alignement / répartition des points sélectionnés (évolution
    // « boutons pour forcer l'alignement et la répartition des points
    // sélectionnés », cf. DESIGN.md §7.14) : Alt+← / Alt+→ alignent
    // sur le premier point sélectionné (ancre), Alt+Shift+← /
    // Alt+Shift+→ répartissent uniformément entre les extrêmes — mêmes
    // fonctions que les 4 boutons du panneau #align. Gardes
    // identiques à l'ordre des formes : typing, preview (aucune
    // édition), AltGr via !e.ctrlKey (AltGr = Alt+Ctrl), !e.repeat.
    // e.shiftKey distingue répartir (Shift+) d'aligner ; les actions
    // sont no-op si la sélection est trop petite (align < 2 points,
    // répartir < 3).
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
    // Preview = visualisation seule : undo/redo sont des mutations de
    // scene — elles resteraient invisibles a l'ecran (geometrie
    // masquee) et sont donc ignorees. Ctrl+0 (reset zoom) reste
    // disponible (non-mutant). Ctrl+S sort d'abord de la preview pour
    // ouvrir la fenêtre d'enregistrement (la chrome — et donc les
    // modales — est masquée en preview, cf. openSaveModal).
    if (!state.previewMode && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        redo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
    } else if (!state.previewMode && (e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
    // Presse-papiers interne (évolution « couper, copier, coller les
    // éléments sélectionnés ») : Ctrl+C / Ctrl+X / Ctrl+V, mêmes
    // fonctions que les boutons #copy / #cut / #paste. La garde `typing`
    // est INDISPENSABLE pour Ctrl+V : sans elle, le coller interne
    // intercepte la frappe dans un champ (ex. renommage de la fenêtre
    // d'enregistrement) et casserait le collage natif du navigateur.
    // Ignorés en preview (mutations de scène, même politique que
    // undo/redo).
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
