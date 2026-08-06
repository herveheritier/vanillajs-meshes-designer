import { state } from './state.js'
import { activeTriangles, adjacentPoints } from './geometry.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateSelectionHud, updateMergeButtonState, showActionComment } from './hud.js'
import { saveState, replaceShapePatch, cloneShape } from './history.js'
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

// ===== Helpers =====

// selectedPoints = tableau d'indices dans le pointList de la forme active.
const activeShape = () => state.shapes[state.activeShapeIndex]

// Clusterise les indices selectionnes par position physique adjacente (tol 0.01).
const clusterSelected = (selectedIndices) => {
    const clusters = []
    const pointList = (activeShape() && Array.isArray(activeShape().pointList)) ? activeShape().pointList : []
    selectedIndices.forEach((idx) => {
        const pt = pointList[idx]
        if (!pt) return
        const found = clusters.find((c) => adjacentPoints(c[0].pt, pt, 0.01))
        if (found) found.push({ idx, pt })
        else clusters.push([{ idx, pt }])
    })
    return clusters
}

// Re-index t.pX apres compactage : -1 par deleteIndex strictement inferieur.
const reindexOne = (oldIdx, deleteIndicesAsc) => {
    if (!Number.isInteger(oldIdx)) return undefined
    let newIdx = oldIdx
    for (let i = 0; i < deleteIndicesAsc.length; i++) {
        if (deleteIndicesAsc[i] < oldIdx) newIdx--
    }
    return newIdx
}

// ===== Validation =====

// Slots du tri selectionnes (slots undefined exclus) ; 2+ = conflit
// (le tri deviendrait degenere apres fusion).
const countSelectedSlots = (tri) => {
    let count = 0
    if (Number.isInteger(tri.p1) && state.selectedPoints.includes(tri.p1)) count++
    if (Number.isInteger(tri.p2) && state.selectedPoints.includes(tri.p2)) count++
    if (Number.isInteger(tri.p3) && state.selectedPoints.includes(tri.p3)) count++
    return count
}

const findMergeConflicts = () => {
    const tris = activeTriangles()
    const conflicting = []
    tris.forEach((t, i) => {
        // Triangles partiels ignores : sans p3 ils ne peuvent pas devenir
        // une surface degeneree par fusion.
        if (!Number.isInteger(t.p1) || !Number.isInteger(t.p2)) return
        if (countSelectedSlots(t) >= 2) conflicting.push(i + 1)
    })
    return conflicting
}

// ===== Centroid =====

// Moyenne des coords uniques (1 representant par cluster de doublons).
const computeMergeCentroid = (clusters) => {
    if (clusters.length === 0) return { x: 0, y: 0 }
    const sum = clusters.reduce(
        (acc, c) => ({ x: acc.x + c[0].pt.x, y: acc.y + c[0].pt.y }),
        { x: 0, y: 0 }
    )
    return {
        x: sum.x / clusters.length,
        y: sum.y / clusters.length,
    }
}

// ===== Merge =====

export const mergeSelectedPoints = () => {
    const selected = state.selectedPoints

    if (selected.length < 2) {
        // 1 point selectionne : le clic arme la fusion par deplacement (cf. DESIGN.md §7.11).
        if (selected.length === 1) return toggleMergeOnDrop()
        showMergeErrorModal(
            `Sélection insuffisante : la fusion nécessite au moins 2 points.\n` +
            `Sélection actuelle : ${selected.length}.`
        )
        return false
    }

    disarmMergeOnDrop()

    const clusters = clusterSelected(selected)
    const centroid = computeMergeCentroid(clusters)
    return applyMergeToSelection(centroid, 'Fusion')
}

// Coeur commun des deux fusions (cf. DESIGN.md §7.11) : tous les
// points selectionnes convergent vers un survivant (plus petit indice)
// pose sur `mergePos` — centroid des positions uniques (bouton) ou
// position de la cible (drag arme) —, slots rediriges, compactage
// immediat, replaceShapePatch dans l'historique.
const applyMergeToSelection = (mergePos, label) => {
    const selected = state.selectedPoints

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

    // Capture pre-mutation pour le replaceShapePatch (gain net des
    // que la scene contient plusieurs formes ; sinon bascule snapshot).
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris
    const pointList = shape.pointList
    const tris = shape.tris

    // Survivant = plus petit indice : choix stable (newSurvivor ===
    // survivor apres reindex, pas de shift sur lui-meme).
    const survivor = selected.reduce(
        (acc, idx) => (idx < acc ? idx : acc),
        Number.MAX_SAFE_INTEGER
    )

    // Mutation 1 : le survivant prend mergePos (centroid ou position de la cible).
    pointList[survivor].x = mergePos.x
    pointList[survivor].y = mergePos.y

    // Mutation 2 : rediriger les slots selectionnes vers le survivant.
    const selectedSet = new Set(selected)
    const replaced = tris.map((t) => ({
        p1: Number.isInteger(t.p1) && selectedSet.has(t.p1) ? survivor : t.p1,
        p2: Number.isInteger(t.p2) && selectedSet.has(t.p2) ? survivor : t.p2,
        p3: Number.isInteger(t.p3) && selectedSet.has(t.p3) ? survivor : t.p3,
        fill: t.fill,
    }))

    // Compactage : splice en ordre descendant pour garder les indices valides.
    const deleteIndicesDesc = selected
        .filter((idx) => idx !== survivor)
        .sort((a, b) => b - a)
    for (let i = 0; i < deleteIndicesDesc.length; i++) {
        pointList.splice(deleteIndicesDesc[i], 1)
    }
    const deleteIndicesAsc = selected
        .filter((idx) => idx !== survivor)
        .sort((a, b) => a - b)

    // Mutation 3 : re-indexation des slots non concernes (I1/I2).
    shape.tris = replaced.map((t) => ({
        p1: t.p1 === undefined ? undefined : reindexOne(t.p1, deleteIndicesAsc),
        p2: t.p2 === undefined ? undefined : reindexOne(t.p2, deleteIndicesAsc),
        p3: t.p3 === undefined ? undefined : reindexOne(t.p3, deleteIndicesAsc),
        fill: t.fill,
    }))

    // Mutation 4 : re-indexer activeConstructionTriangle (selection -> survivor).
    const act = state.activeConstructionTriangle
    if (act) {
        const rewriteSlot = (slotKey) => {
            if (!Number.isInteger(act[slotKey])) return
            act[slotKey] = selectedSet.has(act[slotKey])
                ? survivor
                : reindexOne(act[slotKey], deleteIndicesAsc)
        }
        rewriteSlot('p1')
        rewriteSlot('p2')
        rewriteSlot('p3')
    }

    // Cleanup : toutes les indirections a indices obsoletes sont reinitialisees.
    state.selectedPoints = [survivor]
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.nearestTriangle = undefined
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
    state.moveAllActive = false
    state.mergeDropCandidate = undefined

    // Capture post-mutation et saveState en replaceShapePatch.
    const clonedShapeAfter = cloneShape(shape)
    saveState({
        patches: [replaceShapePatch(
            shapeIdx,
            pointListBefore, trisBefore,
            clonedShapeAfter.pointList, clonedShapeAfter.tris,
        )],
    })

    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    persistState()
    log(
        `${label} : ${selected.length} ref(s) -> 1 point cible en ` +
        `(${mergePos.x.toFixed(2)}, ${mergePos.y.toFixed(2)})`
    )
    showActionComment(
        `Ctrl+Z pour annuler — sélectionnez ≥ 2 points pour une autre fusion`
    )
    return true
}

// ===== Fusion par déplacement (2e fonction du bouton #mergePoints) =====
// 1 point selectionne -> le clic ARME le mode : glisser le point puis
// le RELÂCHER pres d'un autre (rayon MERGE_DROP_RADIUS_PX en px ecran)
// le fusionne avec lui (position de la CIBLE conservee, refs redirigees).
// Cycle du bouton en 3 etats (cf. DESIGN.md §7.11) : desarme -> ARME ->
// VERROUILLE (enchainement) -> DESARME. Le mode se desarme aussi quand
// la selection n'est plus un point unique (garde updateSelectionHud).
export const toggleMergeOnDrop = () => {
    if (state.mergeOnDropActive) {
        if (state.mergeOnDropLocked) {
            // 3e état : clic sur verrouillé → désarme tout (mode + verrou).
            disarmMergeOnDrop()
            log('Fusion par déplacement desarmée')
        } else {
            // 2e état : clic sur armé → verrouille (le mode survit aux fusions).
            state.mergeOnDropLocked = true
            updateMergeButtonState()
            log('Fusion par déplacement verrouillée : le mode reste armé après chaque fusion ' +
                'pour enchaîner les fusions (re-clic sur Fusionner pour désarmer).')
        }
        return false
    }
    if (state.selectedPoints.length !== 1) {
        showMergeErrorModal(
            `Sélection insuffisante : la fusion par déplacement nécessite exactement 1 point sélectionné.\n` +
            `Sélection actuelle : ${state.selectedPoints.length}.`
        )
        return false
    }
    state.mergeOnDropActive = true
    updateMergeButtonState()
    log(`Fusion par déplacement armée : glissez le point sélectionné puis relâchez-le près d'un autre point ` +
        `(rayon ${state.mergeDropRadius} px a l'ecran, independant du zoom — molette sur ce bouton pour le régler) ` +
        `pour le fusionner avec lui. Re-clic sur Fusionner = verrouiller (enchaînement), un autre clic = désarmer.`)
    return true
}

export const disarmMergeOnDrop = () => {
    if (!state.mergeOnDropActive && !state.mergeOnDropLocked) return
    state.mergeOnDropActive = false
    state.mergeOnDropLocked = false
    state.mergeDropCandidate = undefined
    updateMergeButtonState()
}

// Tentee par main.js au mouseup d'un grab arme ayant reellement
// deplace la geometrie : fusion du point deplace avec le candidat
// cible calcule par updateMergeDropCandidate (editor.js).
export const attemptDropMerge = () => {
    if (!state.mergeOnDropActive) return false
    if (state.selectedPoints.length !== 1) return false
    const draggedIdx = state.selectedPoints[0]
    const targetIdx = state.mergeDropCandidate
    state.mergeDropCandidate = undefined
    if (typeof targetIdx !== 'number' || targetIdx === draggedIdx) return false
    const shape = activeShape()
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const targetPt = pointList[targetIdx]
    if (!targetPt) return false
    // Position de la cible conservee : le drag a deja deplace le point,
    // la fusion ne doit pas le faire « rebondir » vers un centroide.
    const previousSelection = state.selectedPoints
    state.selectedPoints = [draggedIdx, targetIdx]
    const merged = applyMergeToSelection(
        { x: targetPt.x, y: targetPt.y },
        'Fusion par déplacement'
    )
    if (merged) {
        // Succès : désarme sauf si verrouillé (l'intention d'enchaîner
        // est exprimée par le verrou).
        if (!state.mergeOnDropLocked) disarmMergeOnDrop()
    } else {
        // Échec (conflit topologique) : sélection restaurée, mode armé.
        state.selectedPoints = previousSelection
    }
    return merged
}
