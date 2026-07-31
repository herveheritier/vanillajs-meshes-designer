// Rationale : voir DESIGN.md §4.1

import { state, initDomRefs } from './state.js'
import { drawBoard } from './draw.js'
import { CANVAS_BACKGROUND } from './constants.js'
import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateConsoleButton, updateEditingModeButton,
    updateSelectionModeButton, updateColorButtonState, updateAccessibilityLabels, updateSceneStatus,
} from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import {
    selectAllPoints, deleteSelectedPoint, deleteSelectedSegment, deleteSelectedTriangle,
    endGrabbing, grabbed, resolveMouseMoveOnBoard, beginGrabbing,
    processMouseUpSelection, processRightClickSelection, wireBoardDrop,
    wireTriangleColorPanel, hideTriangleColorPanel,
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
    restoreEditingMode, wireEditingModeControl, restoreSelectionMode, wireSelectionModeControl,
} from './viewport.js'
import { wireGridControl } from './viewport.js'
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
state.board.width = state.board.getBoundingClientRect().width
state.board.height = state.board.getBoundingClientRect().height
state.board.style.cursor = 'none'
state.ctx.center.x = state.board.width / 2
state.ctx.center.y = state.board.height / 2
state._ctx = state.board.getContext('2d')
state._ctx.fillStyle = CANVAS_BACKGROUND
state._ctx.fillRect(0, 0, state.board.width, state.board.height)

// ===== Restore localStorage + wire UI controls =====

restoreReticleMode()
restoreEditingMode()
restoreSelectionMode()
restoreConsoleVisible()

// ===== Branchement des listeners "locaux" =====

wireGridControl()
wireReticleControl()
wireEditingModeControl()
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
        state.isSelectingBox = state.editingMode !== 'construction'
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
    const boardTarget = e.target && e.target.id === 'board'
    if (!wasGrabbing && e.button === 0) {
        if (state.editingMode !== 'construction' && state.isSelectingBox) {
            if (boardTarget && state.selectionBoxStart && state.selectionBoxCurrent) {
                const dist = Math.hypot(state.selectionBoxCurrent.x - state.selectionBoxStart.x, state.selectionBoxCurrent.y - state.selectionBoxStart.y)
                if (dist < 5) {
                    processMouseUpSelection(e)
                    drawBoard()
                    updateSelectionHud()
                }
            }
            // Always clear the gesture, including a release outside the canvas.
            state.isSelectingBox = false
            state.selectionBoxStart = undefined
            state.selectionBoxCurrent = undefined
        } else if (boardTarget && (state.editingMode === 'construction' || state.editingMode === 'edition')) {
            processMouseUpSelection(e)
            drawBoard()
        }
    } else if (!wasGrabbing && boardTarget && e.button === 2 && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        // If no grab target was armed, a plain right click still has
        // selection semantics in edition mode (including empty-space
        // deselection).
        processRightClickSelection(e)
    }
})

document.addEventListener('keydown', (e) => {
    if (e.code === 'Backspace' && state.editingMode !== 'construction') {
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
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyE') {
        e.preventDefault()
        const editMode = document.querySelector('#editMode')
        if (editMode) editMode.click()
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
applyConsoleFrame()
updateConsoleButton()
updateAccessibilityLabels()
updateEditingModeButton()
updateSceneStatus()

// ===== Boot =====

const doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
    updateZoomDisplay()
    updateUndoRedoHud()
    updateSelectionHud()
    updateSelectionModeButton()
    updateEditingModeButton()
    updateAccessibilityLabels()
    updateSceneStatus()
    updateColorButtonState()
    log('App ready')
}

doit()
