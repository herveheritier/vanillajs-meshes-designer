// Module main.js : point d'entree / routeur.
//
// Avant le refactor, ce fichier faisait ~2500 LOC et portait
// l'integralite de la logique applicative. Apres, il est un
// thin orchestrateur qui :
//   1. importe les modules metiers ;
//   2. init les refs DOM (state.initDomRefs)
//   3. configure le canvas (_ctx, center, body styles)
//   4. branche les listeners d'evenements GLOBAUX (document et
//      board) qui dispatchent vers les modules ;
//   5. branche les listeners de la toolbar (boutons toolbar) ;
//   6. appelle doit() au boot (loadState + draw initial + HUD).
//
// Convention : main.js est un "routeur". Les listeners
// globaux sont ici parce qu'ils sont partages entre plusieurs
// modules (mousedown sur board -> shape management + grab +
// pan selon le bouton ; keydown -> shortcuts clavier).
// Les listeners locaux a un module vivent dans leur module
// (wireGridControl, wireHelpModal, etc) et sont appeles depuis
// ici.
//
// Flux d'imports : main.js importe TOUT. Les modules
// subordonnees n'importent PAS main.js (pas de cycle).

import { state, initDomRefs } from './state.js'
import { drawBoard } from './draw.js'
import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateConsoleButton, updateSelectionModeButton,
    updateColorButtonState,
} from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import {
    selectAllPoints, deleteSelectedPoint, deleteSelectedSegment, deleteSelectedTriangle,
    endGrabbing, grabbed, resolveMouseMoveOnBoard, beginGrabbing,
    processMouseUpSelection, wireBoardDrop,
    wireTriangleColorPanel, hideTriangleColorPanel,
} from './editor.js'
import { undo, redo } from './history.js'
import {
    importMeshFromFile, saveMesh, loadState, resetAll, wireBeforeUnload,
} from './io.js'
import {
    restoreReticleMode, wireReticleControl, wireConsoleToggle, restoreConsoleVisible,
    wireBoardWheel, toggleGrid, toggleReticle, resetZoom,
    startPan, updatePan, endPan,
    restoreSelectionMode, wireSelectionModeControl,
} from './viewport.js'
import { wireGridControl } from './viewport.js'
import { wireConsoleOverlay, wireClearConsole, applyConsoleFrame } from './console_overlay.js'
import { showHelp, hideHelp, wireHelpModal, showResetModal, hideResetModal, wireResetModal } from './modals.js'
import {
    prevShape, nextShape, addShape, deleteShape, wireDeleteShapeModal,
} from './shapes.js'
import { mergeSelectedPoints, wireMergeErrorModal, hideMergeErrorModal } from './merge.js'
import { log } from './log.js'

// ===== Init DOM refs et canvas =====

initDomRefs()
state.body.style.overflow = 'hidden'
state.board.style.border = 'solid 1px black'
state.board.style.width = '99vw'
state.board.style.height = '99vh'
state.board.width = state.board.getBoundingClientRect().width
state.board.height = state.board.getBoundingClientRect().height
state.board.style.cursor = 'none'
state.ctx.center.x = state.board.width / 2
state.ctx.center.y = state.board.height / 2
state._ctx = state.board.getContext('2d')
state._ctx.fillStyle = '#000000'
state._ctx.fillRect(0, 0, state.board.width, state.board.height)

// ===== Restore localStorage + wire UI controls =====

restoreReticleMode()
restoreSelectionMode()
restoreConsoleVisible()

// ===== Branchement des listeners "locaux" =====

// Ces fonctions sont co-localisees dans leur module respectif.
// main.js se contente de les appeler au boot.
wireGridControl()
wireReticleControl()
wireSelectionModeControl()
wireConsoleToggle()
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

// ===== Toolbar buttons =====

// Co-localises avec leur logique metier dans leur module
// respectif : on importe la fonction, on attache un listener
// sur le bouton toolbar avec garde e.button === 0 (le canvas
// et la toolbar utilisent la meme convention left-click-only).
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

// Boutons d'import : ouvrent un picker file-cache (input
// type=file dynamique). La creation du input se fait ici en
// co-localisation avec le DOM toolbar ; la lecture et la
// delegation sont les memes (FileReader -> importMeshFromText)
// -> importMeshFromFile.
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
            // Pas de filtre accept: les fichiers meshes n'ont
            // souvent pas d'extension (ex: assets/meshes). Un
            // filtre MIME/extension strict masque ces fichiers
            // dans le picker.
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

// contextmenu sur board : preventDefault pour ne pas ouvrir le
// menu natif du browser (clic droit = grab, pas menu).
document.addEventListener('contextmenu', (e) => {
    if (e.target.id === 'board') e.preventDefault()
}, false)

// mousedown global : dispatch selon le bouton et la cible.
// button === 2 (clic droit) -> grab (editor.js)
// button === 1 (clic milieu) -> pan (viewport.js)
// button === 0 (clic gauche) -> debut d'une selection box
document.addEventListener('mousedown', (e) => {
    if (e.target.id !== 'board') return
    const mousePos = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    if (e.button === 2) {
        beginGrabbing(e)
    } else if (e.button === 0) {
        state.selectionBoxStart = mousePos
        state.selectionBoxCurrent = mousePos
        state.isSelectingBox = true
    } else if (e.button === 1) {
        startPan(mousePos)
    }
})

// mousemove global : dispatch selon l'etat courant.
// - Pan si isPanning (viewport.js)
// - resolveMouseMoveOnBoard sinon (editor.js : grab OU
//   selection box OU rien).
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

// mouseup global : termine grab, termine pan, gere le
// mouseup qui finit une selection box sur le board.
//
// mouseup global : termine grab (editor.js), termine pan
// (viewport.js), et dispatch la fin d'un click court sur le
// board vers processMouseUpSelection (editor.js).
//
// Le mouseup distingue 3 cas sur le board :
//   - grabbed : fin du grab (deplace des points).
//   - isPanning : fin du pan (deplace le viewCenter).
//   - isSelectingBox : un click court (dist < 5 px dans
//     screen) -> selection / creation de point selon les
//     modifiers. La logique complete (3 modifiers x 2 cibles
//     point / espace vide) est dans editor.processMouseUpSelection.
//     La selection box elargie (> 5 px) est geree plus tot
//     dans editor.resolveMouseMoveOnBoard (drag = box).
document.addEventListener('mouseup', (e) => {
    if (grabbed()) endGrabbing(e)
    if (state.isPanning && e.button === 1) endPan()
    if (e.target.id === 'board' && e.button === 0) {
        if (state.isSelectingBox) {
            const dist = Math.hypot(state.selectionBoxCurrent.x - state.selectionBoxStart.x, state.selectionBoxCurrent.y - state.selectionBoxStart.y)
            state.isSelectingBox = false
            if (dist < 5) {
                // Click court : delegation a editor.js qui
                // gere tous les cas de modifiers selon la
                // cible (point proche vs espace vide).
                processMouseUpSelection(e)
                drawBoard()
                updateSelectionHud()
            }
        }
    }
})

// keydown global : raccourcis clavier.
document.addEventListener('keydown', (e) => {
    // Backspace : supprime le selection (sans shift), ou
    // affiche la modale de reset (avec shift+Backspace).
    // Dispatch par mode de selection :
    //   - 'segment' : deleteSelectedSegment (supprime les
    //                 triangles dependent du segment,
    //                 preserve les points encore references
    //                 ailleurs).
    //   - 'triangle' : deleteSelectedTriangle (supprime
    //                  UNIQUEMENT les triangles selectionnes,
    //                  preserve les partages partiels).
    //   - 'vertex'   : deleteSelectedPoint (retire le point
    //                  des slots de tous les triangles
    //                  concernes, ce qui peut cascader en
    //                  triangles <2 points).
    if (e.code === 'Backspace') {
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
    // 'G' / 'g' : toggle la grille. Ignore si focus dans
    // un INPUT/TEXTAREA, ou si focus dans le bouton #grid
    // (sinon double-toggle consecutif apres un clic).
    const t = e.target
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const inGridBtn = t && typeof t.closest === 'function' && t.closest('#grid')
    const inReticleBtn = t && typeof t.closest === 'function' && t.closest('#reticle')
    if (!typing && !inGridBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        toggleGrid()
    }
    // 'R' / 'r' : cycle reticule.
    if (!typing && !inReticleBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        toggleReticle()
    }
    // '?' : ouvre/ferme l'aide (locale-dependant : shift+/
    // sur US, shift+, sur AZERTY). Memo pour eviter un
    // double-fire sur repeat.
    const helpM = document.querySelector('#helpModal')
    const isHelpOpen = helpM && !helpM.hidden
    const wantsHelp = !typing && (e.key === '?' || e.code === 'Help')
    if (wantsHelp && !e.repeat) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        else showHelp()
    }
    // Escape : ferme les modales ouvertes (help, reset,
    // delete-shape, merge-error).
    const resetM = document.querySelector('#resetModal')
    const deleteShapeM = document.querySelector('#deleteShapeModal')
    const mergeErrorM = document.querySelector('#mergeErrorModal')
    const isResetOpen = resetM && !resetM.hidden
    const isDeleteShapeOpen = deleteShapeM && !deleteShapeM.hidden
    const isMergeErrorOpen = mergeErrorM && !mergeErrorM.hidden
    if (e.code === 'Escape' && !e.repeat && (isHelpOpen || isResetOpen || isDeleteShapeOpen || isMergeErrorOpen)) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        if (isResetOpen) hideResetModal()
        if (isDeleteShapeOpen) {
            const m = document.querySelector('#deleteShapeModal')
            if (m) m.hidden = true
        }
        if (isMergeErrorOpen) hideMergeErrorModal()
    }
    // Escape ferme aussi le panneau flottant de coloration
    // (meme UX que les modales help/reset). Si le panneau est
    // ouvert ET qu'aucune autre modale n'est ouverte (pour ne
    // pas interferer avec Escape de Help/Reset), on ferme.
    if (e.code === 'Escape' && !e.repeat && state.isTriangleColorPanelOpen && !isHelpOpen && !isResetOpen && !isDeleteShapeOpen && !isMergeErrorOpen) {
        e.preventDefault()
        hideTriangleColorPanel()
    }
    // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, Ctrl/Cmd+S, Ctrl/Cmd+0.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        redo()
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y')) {
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
// (console_overlay.js expose applyConsoleFrame ; pas de cycle
// car console_overlay.js n'importe pas main.js.)
applyConsoleFrame()

// Update console button state (display of #messageBoard)
updateConsoleButton()

// ===== Boot =====

const doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
    updateZoomDisplay()
    // Premier appel HUD undo/redo initialise le compteur a
    // (0) et grise les boutons tant que la scene restauree
    // n'a pas une premiere entree dans state.historyStack.
    updateUndoRedoHud()
    // Defense en profondeur : si loadState a restaure une
    // scene avec selection non vide (cas rare), on reflette
    // l'etat reel plutot que le "0" du HTML par defaut.
    updateSelectionHud()
    // Bouton mode de selection : sync apres restoreSelectionMode
    // pour que le label "0"/"1"/"2" reflete l'eventuelle
    // preference persistee en localStorage, pas la valeur
    // hard-coded "0" du HTML par defaut.
    updateSelectionModeButton()
    // Bouton Colorier : au boot, reste disabled (aucun
    // triangle selectionne + mode vertex par defaut). Defensive
    // sync pour aligner le bouton sur la regle
    // updateColorButtonState.
    updateColorButtonState()
    log('App ready')
}

doit()
