// Rationale : voir DESIGN.md §7.5

import { state } from './state.js'
import { activeTriangles, adjacentPoints } from './geometry.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard, requestDraw } from './draw.js'
import { updateSelectionHud } from './hud.js'
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

// (modifyShapeModel-spec §3.9 Q1c) : active shape et pointList
// sont les structures canoniques. selectedPoints est un tableau d'indices.
const activeShape = () => state.shapes[state.activeShapeIndex]

// Regroupe les indices selectionnes en clusters de coords adjacentes
// (tol 0.01). Cluster = ensemble d'indices pointList occupant la meme
// position physique. Renvoie un tableau vide si la liste de points est
// absente ou si un indice designe une entree manquante (defense).
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

// Re-index d'une valeur t.pX post-compactage : on soustrait 1 pour
// chaque deleteIndex strictement inferieur (les autres ne deplacent
// pas l'entite). deleteIndicesAsc doit etre trie asc et unique. Pour
// un index `undefined`, retourne `undefined` (defense, conforme Q1b).
const reindexOne = (oldIdx, deleteIndicesAsc) => {
    if (!Number.isInteger(oldIdx)) return undefined
    let newIdx = oldIdx
    for (let i = 0; i < deleteIndicesAsc.length; i++) {
        if (deleteIndicesAsc[i] < oldIdx) newIdx--
    }
    return newIdx
}

// ===== Validation =====

// Q1c : compte les slots distincts du tri dont l'indice
// pointList est dans state.selectedPoints (les slots undefined ne
// contribuent pas, conforme I5). Un tri avec 2+ slots selectionnes
// devient degenere apres fusion (3 sommets sur <= 2 positions) ->
// conflit.
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
        // On ignore les triangles partiels (au moins p1 ou p2 undefined,
        // conforme Q1b). Un partiel n'a que 2 slots definis max — apres
        // fusion, les 2 peuvent collapser en survivor sans degenerer
        // puisqu'il manque deja p3 (= segment partiel = pas de surface).
        // C'est un changement de comportement vs l'ancien code (qui
        // flaggait tous les tris), mais il est safe : invariant I5
        // garantit qu'un partiel == 1 seul tri ne devient jamais une
        // surface degeneree par fusion.
        if (!Number.isInteger(t.p1) || !Number.isInteger(t.p2)) return
        if (countSelectedSlots(t) >= 2) conflicting.push(i + 1)
    })
    return conflicting
}

// ===== Centroid =====

// centroid = moyenne des coords uniques (un representant par
// cluster de doublons adjacents, via clusterSelected). Meme semantique
// qu'avant : si N points sont colocalises, ils comptent 1 fois (et non N).
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

    // (delta) capture l'état pré-mutation du shape actif pour le
    // replaceShapePatch (gain net dès que la scène contient
    // plusieurs formes). Pour une scène mono-shape, le seuil
    // shouldUseSnapshot bascule automatiquement en snapshot.
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris
    const pointList = shape.pointList
    const tris = shape.tris

    // Survivant = plus petit indice parmi toutes les selections. Choix
    // stable : minimise les shifts ulterieurs pour les tris non concernes
    // et garantit newSurvivor === survivor apres reindex (= pas de shift
    // sur lui-meme puisque tous les deleteIndices sont >= survivor).
    const survivor = selected.reduce(
        (acc, idx) => (idx < acc ? idx : acc),
        Number.MAX_SAFE_INTEGER
    )

    // Centroid moyen sur les positions uniques (1 par cluster dedup).
    // Note : on autorise deliberement le cas single-cluster (= toutes les
    // selections au meme coord, ex: ctrl-click ou lasso resserré). Dans
    // ce cas le centroid est geometriquement inchange, mais le
    // compactage immediat (Q2a) elimine les entrees pointList
    // redondantes pour ramener l'etat a 1 entree canonique. C'est le
    // comportement de cleanup prevu par Q2a (le user pouvait avoir
    // plusieurs refs par erreur sur un meme sommet ; la fusion dedup).
    const clusters = clusterSelected(selected)
    const centroid = computeMergeCentroid(clusters)

    // Mutation 1 : la position du survivant devient le centroid. Tous
    // les slots concernes referent cette entree partagee.
    pointList[survivor].x = centroid.x
    pointList[survivor].y = centroid.y

    // Mutation 2 : remplacer t.pX par survivor pour toute slot dont
    // l'indice est selectionne. Le survivant lui-meme -> survivor est un
    // no-op mais garde la logique uniforme.
    const selectedSet = new Set(selected)
    const replaced = tris.map((t) => ({
        p1: Number.isInteger(t.p1) && selectedSet.has(t.p1) ? survivor : t.p1,
        p2: Number.isInteger(t.p2) && selectedSet.has(t.p2) ? survivor : t.p2,
        p3: Number.isInteger(t.p3) && selectedSet.has(t.p3) ? survivor : t.p3,
        fill: t.fill,
    }))

    // Q2a compactage immediat : splice les indices selectionnes non
    // survivant en ordre descendant (reverse sorted) pour que les
    // indices inferieurs restent valides jusqu'au prochain splice.
    const deleteIndicesDesc = selected
        .filter((idx) => idx !== survivor)
        .sort((a, b) => b - a)
    for (let i = 0; i < deleteIndicesDesc.length; i++) {
        pointList.splice(deleteIndicesDesc[i], 1)
    }
    const deleteIndicesAsc = selected
        .filter((idx) => idx !== survivor)
        .sort((a, b) => a - b)

    // Mutation 3 : re-indexer les slots non concernes par la suppression.
    // Maintient I1 (pX ∈ [0, pointList.length) ∪ undefined) et I2
    // (chaque entree pointList restante reste referencee par au moins
    // un tri) apres compactage.
    shape.tris = replaced.map((t) => ({
        p1: t.p1 === undefined ? undefined : reindexOne(t.p1, deleteIndicesAsc),
        p2: t.p2 === undefined ? undefined : reindexOne(t.p2, deleteIndicesAsc),
        p3: t.p3 === undefined ? undefined : reindexOne(t.p3, deleteIndicesAsc),
        fill: t.fill,
    }))

    // Mutation 4 : re-indexer activeConstructionTriangle (Q1b). Si un
    // slot est dans la selection, on le remplace par survivor ; sinon on
    // le re-indexe selon les suppressions. Les slots undefined restent
    // undefined (maintient l'invariant I5).
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

    // State cleanup : toutes les indirections utilisant des indices
    // obsoletes sont reinitialisees. Meme clautre qu'avant.
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

    // (delta) capture post-mutation et saveState avec replaceShapePatch.
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
        `Fusion : ${selected.length} ref(s) -> 1 point cible au centroid ` +
        `(${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)})`
    )
    return true
}
