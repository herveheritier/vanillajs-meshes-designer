// Rationale : voir DESIGN.md §7.5

import { state } from './state.js'
import { activeTriangles, adjacentPoints, isPointSelected } from './geometry.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard } from './draw.js'
import { updateSelectionHud } from './hud.js'
import { saveState } from './history.js'
import { persistState } from './io.js'
import { updateMouseHover } from './editor.js'
import { log } from './log.js'

// ===== Modal helpers =====
const mergeErrorModal = () => document.querySelector('#mergeErrorModal')
const mergeErrorModalInfo = () => document.querySelector('#mergeErrorModalInfo')

export const showMergeErrorModal = (info) => {
    const m = mergeErrorModal()
    const infoEl = mergeErrorModalInfo()
    if (!m || !infoEl) return
    infoEl.textContent = info
    state.lastFocusedElement = document.activeElement
    m.hidden = false
    m.setAttribute('aria-hidden', 'false')
    const closeBtn = document.querySelector('#mergeErrorModalClose')
    if (closeBtn) closeBtn.focus()
}

export const hideMergeErrorModal = () => {
    const m = mergeErrorModal()
    if (m) {
        m.hidden = true
        m.setAttribute('aria-hidden', 'true')
    }
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
    state.lastFocusedElement = undefined
}

export const wireMergeErrorModal = () => {
    const m = mergeErrorModal()
    const closeBtn = document.querySelector('#mergeErrorModalClose')
    if (closeBtn) closeBtn.addEventListener('click', () => hideMergeErrorModal())
    if (m) m.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.mergeErrorClose !== undefined) hideMergeErrorModal()
    })
}

// ===== Validation =====

// Rationale : voir DESIGN.md §3.2
const countSelectedSlots = (tri) => {
    const seen = new Set()
    let count = 0
    if (tri.p1 && isPointSelected(tri.p1) && !seen.has(tri.p1)) {
        count++
        seen.add(tri.p1)
    }
    if (tri.p2 && isPointSelected(tri.p2) && !seen.has(tri.p2)) {
        count++
        seen.add(tri.p2)
    }
    if (tri.p3 && isPointSelected(tri.p3) && !seen.has(tri.p3)) {
        count++
        seen.add(tri.p3)
    }
    return count
}

const findMergeConflicts = () => {
    const tris = activeTriangles()
    const conflicting = []
    tris.forEach((t, i) => {
        if (countSelectedSlots(t) >= 2) conflicting.push(i + 1)
    })
    return conflicting
}

// ===== Centroid =====

const computeMergeCentroid = () => {
    const selected = state.selectedPoints
    const uniquePositions = []
    selected.forEach((sp) => {
        if (!uniquePositions.some((up) => adjacentPoints(up, sp, 0.01))) {
            uniquePositions.push(sp)
        }
    })
    if (uniquePositions.length === 0) return { x: 0, y: 0 }
    const sum = uniquePositions.reduce(
        (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
        { x: 0, y: 0 }
    )
    return {
        x: sum.x / uniquePositions.length,
        y: sum.y / uniquePositions.length,
    }
}

// ===== Merge =====

export const mergeSelectedPoints = () => {
    const selected = state.selectedPoints

    if (selected.length < 2) {
        showMergeErrorModal(
            `Sélection insuffisante : la fusion nécessite au moins 2 points.\n` +
            `Sélection actuelle : ${selected.length}.`
        )
        return false
    }

    const conflicting = findMergeConflicts()
    if (conflicting.length > 0) {
        const idxList = conflicting.length <= 6
            ? conflicting.join(', ')
            : conflicting.slice(0, 6).join(', ') + ` (+${conflicting.length - 6})`
        showMergeErrorModal(
            `Fusion impossible : ${conflicting.length} triangle(s) contiennent plusieurs points ` +
            `sélectionnés (indices : ${idxList}).\n` +
            `Chaque triangle ne peut avoir qu'un seul sommet sélectionné pour pouvoir ` +
            `être fusionné sans devenir dégénéré.`
        )
        return false
    }

    // Capture the pre-mutation scene so undo restores the actual state
    // before the merge, not the already-mutated geometry.
    saveState()
    const centroid = computeMergeCentroid()
    const target = selected[0]

    const tris = activeTriangles()
    tris.forEach((t) => {
        ['p1', 'p2', 'p3'].forEach((pid) => {
            const p = t[pid]
            if (!p) return
            if (p !== target && isPointSelected(p)) {
                t[pid] = target
            }
        })
    })

    target.x = centroid.x
    target.y = centroid.y

    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.grabbedGroup = []
    state.currentAction = ACTION_NONE
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    clearTimeout(state.eachShapeRotateTimer)
    state.eachShapeRotateTimer = undefined
    state.isEachShapeRotating = false
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    persistState()
    log(
        `Fusion : ${selected.length} ref(s) -> 1 point cible au centroid ` +
        `(${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)})`
    )
    return true
}
