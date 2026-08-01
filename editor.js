// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    ACTION_NONE, ACTION_GRABBING,
    COLOR_HOVER_NEAREST_LINE, LINE_WIDTH_HOVER_NEAREST_LINE,
    COLOR_HOVER_NEAREST_POINT,
    COLOR_HOVER_NEAREST_TRIANGLE_STROKE, COLOR_HOVER_NEAREST_TRIANGLE_FILL,
    TRIANGLE_COLOR_PRESETS, TRIANGLE_COLOR_CLEAR, TAU,
    POINT_HIT_RADIUS_PX, LINE_HIT_RADIUS_PX, TRIANGLE_CENTROID_HIT_RADIUS_PX,
} from './constants.js'
import { drawBoard, drawPoint, drawMouse, drawVertexLabel, drawStackList } from './draw.js'
import { updateSelectionHud, updateColorButtonState } from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import { modelToScreen } from './geometry.js'
import {
    screenToModel, snapToGrid,
    activeTriangles, getAllVertices, getPointsAtSamePosition, getVertexIndex, getStackTriangleRefs, isPointSelected,
    getIndicesAtSamePosition,
    adjacentPoints, computeOrthogonalProjection, isInsideSegmentByDot,
} from './geometry.js'
import { saveState } from './history.js'
import { persistState, importMeshFromFile } from './io.js'
import { log } from './log.js'

// ===== find : point/line/triangle les plus proches =====

// (modifyShapeModel-spec §3.6) : scanne directement le pointList
// canonique de la forme active (Q1a per-shape). Renvoie un point avec son
// indice 0-based dans activeShape().pointList. Le prefixe pointIndex
// aligne sur la convention dev-friendly des arrays JS (cf. §7.8).
const activeShape = () => state.shapes[state.activeShapeIndex]

export const findNearestPoint = (point) => {
    return findNextNearestPoint({ point: point, pointIndex: -1 })
}

export const findNextNearestPoint = (nearestPoint) => {
    const pointList = activeShape() && Array.isArray(activeShape().pointList) ? activeShape().pointList : []
    let shortDistance = Number.MAX_VALUE
    let shortIndex = -1
    for (let i = (nearestPoint.pointIndex | 0) + 1; i < pointList.length; i++) {
        const p = pointList[i]
        if (!p) continue
        const d = Math.hypot(p.x - nearestPoint.point.x, p.y - nearestPoint.point.y)
        if (d < shortDistance) {
            shortDistance = d
            shortIndex = i
        }
    }
    if (shortIndex < 0) return undefined
    return { pointIndex: shortIndex, distance: shortDistance, point: pointList[shortIndex] }
}

const modelToleranceForPixels = (pixels) => pixels / Math.max(state.ctx.zoomLevel, 0.0001)
const pointHitRadiusModel = () => modelToleranceForPixels(POINT_HIT_RADIUS_PX)
const lineHitRadiusModel = () => modelToleranceForPixels(LINE_HIT_RADIUS_PX)
const triangleCentroidHitRadiusModel = () => modelToleranceForPixels(TRIANGLE_CENTROID_HIT_RADIUS_PX)
// les slots tris.pX sont des indices dans activeShape().pointList.
// On accede aux coordonnees via pointList[t.pX]. Renvoie pointIndices
// (= [t.p1, t.p2, t.p3]) pour permettre aux callers editor.js de
// faire cluster/selection par indice sans de-referencement manuel.
export const findNearestTriangle = (point) => {
    const tris = activeShape() && Array.isArray(activeShape().tris) ? activeShape().tris : []
    const pointList = activeShape() && Array.isArray(activeShape().pointList) ? activeShape().pointList : []
    let bestInside = undefined
    let bestInsideDist = Number.MAX_VALUE
    let bestNear = undefined
    let bestNearDist = Number.MAX_VALUE
    tris.forEach((t, i) => {
        if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) return
        const p1 = pointList[t.p1]
        const p2 = pointList[t.p2]
        const p3 = pointList[t.p3]
        if (!p1 || !p2 || !p3) return
        const cx = (p1.x + p2.x + p3.x) / 3
        const cy = (p1.y + p2.y + p3.y) / 3
        const distToCentroid = Math.hypot(point.x - cx, point.y - cy)
        const inside = pointInsideTriangle(point, p1, p2, p3)
        const pointIndices = [t.p1, t.p2, t.p3]
        if (inside) {
            if (distToCentroid < bestInsideDist) {
                bestInsideDist = distToCentroid
                bestInside = { triangleIndex: i, triangle: t, pointIndices, _distance: distToCentroid }
            }
        } else if (distToCentroid <= triangleCentroidHitRadiusModel()) {
            if (distToCentroid < bestNearDist) {
                bestNearDist = distToCentroid
                bestNear = { triangleIndex: i, triangle: t, pointIndices, _distance: distToCentroid }
            }
        }
    })
    return bestInside || bestNear
}

const pointInsideTriangle = (p, a, b, c) => {
    const d1 = sign(p, a, b)
    const d2 = sign(p, b, c)
    const d3 = sign(p, c, a)
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
    return !(hasNeg && hasPos)
}

const sign = (p, a, b) => (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)

// idem findNearestTriangle, coords via pointList[t.pX]. Renvoie
// aussi les coordonnees des endpoints pour les callers qui tracent
// directement (updateMouseHover ligne verte).
export const findSelectedLine = (point) => {
    const tris = activeShape() && Array.isArray(activeShape().tris) ? activeShape().tris : []
    const pointList = activeShape() && Array.isArray(activeShape().pointList) ? activeShape().pointList : []
    let shortDistance = Number.MAX_VALUE
    let shortTriangleIndex = -1
    let shortLineIndex = -1
    tris.forEach((t, i) => {
        if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) return
        const p1 = pointList[t.p1]
        const p2 = pointList[t.p2]
        const p3 = pointList[t.p3]
        if (!p1 || !p2 || !p3) return
        let cop = computeOrthogonalProjection(point, p1, p2)
        let d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, p1, p2)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 0
        }
        cop = computeOrthogonalProjection(point, p2, p3)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, p2, p3)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 1
        }
        cop = computeOrthogonalProjection(point, p3, p1)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, p3, p1)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 2
        }
    })
    if (shortTriangleIndex < 0) return undefined
    const t = tris[shortTriangleIndex]
    const firstPointIndex = [t.p1, t.p2, t.p3][shortLineIndex]
    const secondPointIndex = [t.p2, t.p3, t.p1][shortLineIndex]
    return {
        triangleIndex: shortTriangleIndex,
        lineIndex: shortLineIndex,
        triangle: t,
        firstPointIndex,
        secondPointIndex,
        firstPoint: pointList[firstPointIndex],
        secondPoint: pointList[secondPointIndex],
        distance: shortDistance,
    }
}

// ===== Hover et HUD bas-gauche =====

export const updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    const actionModel = screenToModel(cursorScreen)
    const target = state.activeGrid ? snapToGrid(actionModel) : actionModel
    state.nearestPoint = findNearestPoint(target)
    if (!state.nearestPoint || state.nearestPoint.distance > pointHitRadiusModel()) state.nearestPoint = undefined

    if (state.selectedPoints.length > 0 && state.nearestPoint && state.nearestPoint.point && !isPointSelected(state.nearestPoint.point)) {
        state.isSelectionDimmed = true
    } else {
        state.isSelectionDimmed = false
    }

    state.nearestLine = findSelectedLine(target)
    if (!state.nearestLine || state.nearestLine.distance > lineHitRadiusModel()) state.nearestLine = undefined
    state.nearestTriangle = findNearestTriangle(target)

    drawBoard()
    drawMouse(cursorScreen)

    if (state.nearestPoint && state.nearestPoint.point) {
        drawPoint(state.nearestPoint.point, 5, COLOR_HOVER_NEAREST_POINT)
        // DESIGN.md §7.8 — label d'identifiant stable du sommet surve.
        // Affiche directement l'index 0-based retourne par
        // getVertexIndex (= position dans getAllVertices()), convention
        // dev-friendly alignee sur les arrays JS (idx sur state.nearestPoint,
        // state.shapes, etc.). Si p est absent de la liste (defense,
        // devrait pas arriver dans le call site normal), fallback '?'
        // plutot que planter.
        const vertexIdx = getVertexIndex(state.nearestPoint.point)
        drawVertexLabel(state.nearestPoint.point, vertexIdx >= 0 ? vertexIdx : '?')
        // DESIGN.md §7.9 — liste des slots triangles qui partagent cette
        // position. N'affiche la pill 2-lignes que si > 1 ref (sinon la
        // liste est triviale = 1 entree, redondante avec §7.8).
        const stackRefs = getStackTriangleRefs(state.nearestPoint.point)
        if (stackRefs.length > 1) drawStackList(state.nearestPoint.point, stackRefs)
    }
    if (state.selectionMode === 'segment' || state.selectionMode === 'vertex') {
        if (state.nearestLine && state.nearestLine.firstPoint && state.nearestLine.secondPoint) {
            const s1 = modelToScreen(state.nearestLine.firstPoint)
            const s2 = modelToScreen(state.nearestLine.secondPoint)
            state._ctx.setLineDash([])
            state._ctx.strokeStyle = COLOR_HOVER_NEAREST_LINE
            state._ctx.lineWidth = LINE_WIDTH_HOVER_NEAREST_LINE
            state._ctx.beginPath()
            state._ctx.moveTo(s1.x, s1.y)
            state._ctx.lineTo(s2.x, s2.y)
            state._ctx.stroke()
            state._ctx.lineWidth = 1
        }
    }
    if (state.selectionMode === 'triangle') {
        if (state.nearestTriangle) {
            const t = state.nearestTriangle.triangle
            // les slots tris sont des indices dans pointList ;
            // on resout les coords avant de projeter en SCREEN.
            const pointList = activeShape().pointList
            const p1 = pointList[t.p1], p2 = pointList[t.p2], p3 = pointList[t.p3]
            if (p1 && p2 && p3) {
                const s1 = modelToScreen(p1)
                const s2 = modelToScreen(p2)
                const s3 = modelToScreen(p3)
                state._ctx.setLineDash([])
                state._ctx.strokeStyle = COLOR_HOVER_NEAREST_TRIANGLE_STROKE
                state._ctx.fillStyle = COLOR_HOVER_NEAREST_TRIANGLE_FILL
                state._ctx.beginPath()
                state._ctx.moveTo(s1.x, s1.y)
                state._ctx.lineTo(s2.x, s2.y)
                state._ctx.lineTo(s3.x, s3.y)
                state._ctx.closePath()
                state._ctx.fill()
                state._ctx.stroke()
            }
        }
    }
}

export const updateCoordsDisplay = (cursorScreen) => {
    const div = document.querySelector('#coords')
    if (!div) return
    if (!cursorScreen) {
        div.textContent = ''
        return
    }
    const m = screenToModel(cursorScreen)
    const np = (state.nearestPoint && state.nearestPoint.point) ? state.nearestPoint.point : null
    const cursorTxt = `(${Math.round(m.x)}, ${Math.round(m.y)})`
    const nearestTxt = np ? `(${Math.round(np.x)}, ${Math.round(np.y)})` : '\u2014'
    div.textContent = `curseur ${cursorTxt}  plus proche ${nearestTxt}`
}

// ===== Selection / click sur board =====

// Rationale : voir DESIGN.md §2.1
export const resolveMouseClickOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const pointToAdd = snapToGrid(screenToModel(mouseScreen))
    state.nearestLine = findSelectedLine(pointToAdd)
    if (!state.nearestLine || state.nearestLine.distance > lineHitRadiusModel()) state.nearestLine = undefined
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
}

// (modifyShapeModel-spec §3.6) : dedup tolerance 1 px scanne
// directement le pointList canonique (invariant I3 garantit <= 1
// entree par coord unique, donc le test ne fait pas de tour
// triangulaire). On push le nouveau point dans pointList et on
// assigne son INDEX dans le slot du triangle. Maintient l'invariant
// I5 (p1/p2/p3 toujours definis pour le tri en cours).
export const addPoint = (point) => {
    const shape = activeShape()
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    for (let i = 0; i < pointList.length; i++) {
        if (pointList[i] && adjacentPoints(point, pointList[i], 1)) return
    }
    if (
        tris.length > 0 &&
        tris.at(-1).p2 !== undefined &&
        tris.at(-1).p3 !== undefined &&
        (!state.nearestLine || !state.nearestLine.firstPoint || !state.nearestLine.secondPoint)
    ) {
        log('addPoint: clic trop loin d\'un segment - triangle ignore')
        return
    }
    const nearestLine = state.nearestLine && state.nearestLine.firstPoint && state.nearestLine.secondPoint
        ? state.nearestLine
        : undefined
    const lastTriangle = tris.at(-1)
    const isActivePartial = lastTriangle && lastTriangle === state.activeConstructionTriangle
    if (lastTriangle && lastTriangle.p2 !== undefined && lastTriangle.p3 === undefined && !isActivePartial && !nearestLine) {
        log('addPoint: triangle partiel inactif - clic ignore')
        return
    }
    saveState()
    if (tris.length === 0) {
        pointList.push({ x: point.x, y: point.y })
        const partial = { p1: pointList.length - 1 }
        tris.push(partial)
        state.activeConstructionTriangle = partial
    } else {
        const triangle = lastTriangle
        if (triangle.p2 === undefined) {
            pointList.push({ x: point.x, y: point.y })
            triangle.p2 = pointList.length - 1
            state.activeConstructionTriangle = triangle
        } else if (triangle.p3 === undefined && isActivePartial && !nearestLine) {
            pointList.push({ x: point.x, y: point.y })
            triangle.p3 = pointList.length - 1
            state.activeConstructionTriangle = undefined
        } else if (nearestLine) {
            // Triangle sur edge : on reutilise les indices existants pour
            // les endpoints (l'edge survit en topologie), on push le 3e
            // sommet comme nouvelle entree pointList.
            pointList.push({ x: point.x, y: point.y })
            tris.push({
                p1: nearestLine.firstPointIndex,
                p2: nearestLine.secondPointIndex,
                p3: pointList.length - 1,
            })
            state.activeConstructionTriangle = undefined
        }
    }
    state.ctx.workIsSaved = 0
    state.ctx.workIsBackuped = 0
    persistState()
}

// Q1c : state.selectedPoints = [0, 1, ..., pointList.length-1].
// La conversion par indices evite l'ambiguite ref-vs-cluster heritage de
// la representation inline-coord : un sommet == une entree pointList, et
// le doublonnage est impossible par invariant I3.
export const selectAllPoints = () => {
    const shape = activeShape()
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    state.selectedPoints = pointList.map((_, i) => i)
    if (state.selectionMode === 'triangle') {
        const tris = Array.isArray(shape.tris) ? shape.tris : []
        state.selectedTriangles = tris.map((t, i) => (
            t && Number.isInteger(t.p1) && Number.isInteger(t.p2) && Number.isInteger(t.p3) ? i : -1
        )).filter(i => i >= 0)
    } else {
        state.selectedTriangles = []
    }
    state.nearestPoint = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
}

// ===== Mouseup (selection par click sur point) =====

// findNearestTriangle/Line renvoient maintenant des pointIndices
// ([t.p1, t.p2, t.p3]) et pas des refs. collectUnderlyingPoints prend
// des coords en entree et renvoie des indices ; le pipeline reste logique
// et juste change le type de sortie.
export const processMouseUpSelection = (e) => {
    if (!state.board) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawTargetModel = screenToModel(mouseScreen)
    const targetModel = state.activeGrid ? snapToGrid(rawTargetModel) : rawTargetModel
    const np = findNearestPoint(targetModel)
    const pointHit = np && np.distance <= pointHitRadiusModel() ? np : undefined
    const leftSelectionEvent = { ...e, ctrlKey: false, metaKey: false }

    if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            const cluster = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            state.selectedTriangles = []
            applySelectionModifiers(cluster, leftSelectionEvent)
            updateColorButtonState()
            return
        }
    } else if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt && nt.pointIndices) {
            const pointList = activeShape().pointList
            const cluster = collectUnderlyingPoints(nt.pointIndices.map(i => pointList[i]))
            applySelectionModifiers(cluster, leftSelectionEvent)
            applyTriangleIndexModifier(nt.triangleIndex, leftSelectionEvent)
            return
        }
    }

    if (pointHit) {
        const pointsAtPos = getIndicesAtSamePosition(pointHit.point)
        if (state.selectionMode !== 'triangle') state.selectedTriangles = []
        applySelectionModifiers(pointsAtPos, leftSelectionEvent, state.selectionMode === 'vertex')
    } else if (leftSelectionEvent.shiftKey) {
        // Shift preserves the current selection and suppresses creation.
    } else {
        state.selectedPoints = []
        state.selectedTriangles = []
        updateSelectionHud()
        updateColorButtonState()
        resolveMouseClickOnBoard(e)
    }
}

// prend un array de coords (sortie brute de findNearest*)
// et renvoit les indices correspondants dans pointList. Pas de
// doublonnage par I3.
const collectUnderlyingPoints = (baseCoords) => {
    const result = []
    if (!Array.isArray(baseCoords)) return result
    for (let i = 0; i < baseCoords.length; i++) {
        const c = baseCoords[i]
        if (!c) continue
        const idxs = getIndicesAtSamePosition(c)
        for (let j = 0; j < idxs.length; j++) {
            if (!result.includes(idxs[j])) result.push(idxs[j])
        }
    }
    return result
}

// grabPoints est un array d'indices. On match les tris par
// equity d'indices sur les 3 slots (plus fiable que adjacentPoints
// par coord, et plus rapide O(N) au lieu de O(N*3)).
const applyGrabTriangleSync = (grabIndices, e) => {
    const tris = activeShape() && Array.isArray(activeShape().tris) ? activeShape().tris : []
    const matching = []
    tris.forEach((t, i) => {
        if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) return
        const slots = [t.p1, t.p2, t.p3]
        const allMatch = grabIndices.every(g => slots.includes(g))
        if (allMatch) matching.push(i)
    })
    if (matching.length === 0) {
        state.selectedTriangles = []
        return
    }
    if (e.shiftKey) {
        let anySelected = false
        matching.forEach(i => { if (state.selectedTriangles.includes(i)) anySelected = true })
        if (anySelected) {
            state.selectedTriangles = state.selectedTriangles.filter(i => !matching.includes(i))
        } else {
            matching.forEach(i => {
                // Cohérence selectedTriangles ↔ selectedPoints : on ne push
                // i que si ses 3 indices sont dans selectedPoints (les modes
                // vertex/segment/triangle basculent la cohérence en
                // applySelectionModifiers ; ici on reapplique la garde pour
                // eviter selectedTriangles indep des sommets engages).
                const t = tris[i]
                const inSel = t && t.p1 !== undefined && t.p2 !== undefined && t.p3 !== undefined
                    && [t.p1, t.p2, t.p3].every(idx => state.selectedPoints.includes(idx))
                if (inSel && !state.selectedTriangles.includes(i)) state.selectedTriangles.push(i)
            })
        }
    } else if (e.ctrlKey || e.metaKey) {
        matching.forEach(i => {
            if (!state.selectedTriangles.includes(i)) state.selectedTriangles.push(i)
        })
    } else {
        state.selectedTriangles = [...matching]
    }
    state.selectedTriangles.sort((a, b) => a - b)
}

// Q1c : indicesAtPos est un array d'indices. La notion de
// 'meme point' est une egalite stricte d'indice (plus de tolerance
// coord necessaire grace a l'invariant I3). Si l'un des indices est
// deja dans selectedPoints, on retire TOUT le cluster ; sinon on
// ajoute chaque indice manquant.
const toggleSelectionPoints = (indicesAtPos) => {
    const set = new Set(state.selectedPoints)
    const overlap = indicesAtPos.some(idx => set.has(idx))
    if (overlap) {
        state.selectedPoints = state.selectedPoints.filter(idx => !indicesAtPos.includes(idx))
        return
    }
    for (let i = 0; i < indicesAtPos.length; i++) {
        const idx = indicesAtPos[i]
        if (!state.selectedPoints.includes(idx)) state.selectedPoints.push(idx)
    }
}

// Rationale : voir DESIGN.md §3.6
// Q1c : pointsAtPos est un array d'indices. ctrlToggles
// conservé pour le toggle additif cluster (mode vertex).
const applySelectionModifiers = (indicesAtPos, e, ctrlToggles = false) => {
    if (e.shiftKey) {
        toggleSelectionPoints(indicesAtPos)
    } else if (e.ctrlKey || e.metaKey) {
        if (ctrlToggles) {
            toggleSelectionPoints(indicesAtPos)
        } else {
            for (let i = 0; i < indicesAtPos.length; i++) {
                const idx = indicesAtPos[i]
                if (!state.selectedPoints.includes(idx)) state.selectedPoints.push(idx)
            }
        }
    } else {
        state.selectedPoints = [...indicesAtPos]
    }
}

const applyTriangleIndexModifier = (triangleIndex, e) => {
    if (e.shiftKey) {
        const idx = state.selectedTriangles.indexOf(triangleIndex)
        if (idx >= 0) {
            state.selectedTriangles.splice(idx, 1)
        } else {
            state.selectedTriangles.push(triangleIndex)
        }
    } else if (e.ctrlKey || e.metaKey) {
        if (!state.selectedTriangles.includes(triangleIndex)) {
            state.selectedTriangles.push(triangleIndex)
        }
    } else {
        state.selectedTriangles = [triangleIndex]
    }
    state.selectedTriangles.sort((a, b) => a - b)
    updateSelectionHud()
    updateColorButtonState()
}

// Q1c + invariant I2 : helper qui compacte pointList apres
// une mutation des tris. Retire les entrees pointList non referencees
// par aucun slot, puis re-indexe les slots et renvoie une map
// oldIdx -> newIdx pour les callers qui ajustent selectedPoints
// (qui est un array d'indices, Q1c).
const compactPointList = (shape) => {
    const oldPointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    const refs = new Set()
    tris.forEach(t => {
        if (Number.isInteger(t.p1)) refs.add(t.p1)
        if (Number.isInteger(t.p2)) refs.add(t.p2)
        if (Number.isInteger(t.p3)) refs.add(t.p3)
    })
    const kept = []
    for (let i = 0; i < oldPointList.length; i++) {
        if (refs.has(i)) kept.push(i)
    }
    const idxMap = new Map()
    const newPointList = []
    for (let newIdx = 0; newIdx < kept.length; newIdx++) {
        idxMap.set(kept[newIdx], newIdx)
        newPointList.push(oldPointList[kept[newIdx]])
    }
    shape.pointList = newPointList
    shape.tris = tris.map(t => ({
        p1: Number.isInteger(t.p1) ? idxMap.get(t.p1) : undefined,
        p2: Number.isInteger(t.p2) ? idxMap.get(t.p2) : undefined,
        p3: Number.isInteger(t.p3) ? idxMap.get(t.p3) : undefined,
    }))
    return idxMap
}

// ===== Suppression d'un point =====

// (modifyShapeModel-spec §4.1, alterne invariants I1-I8) :
// suppression d'un sommet = retirer ses refs des slots puis compacter
// (invariant I2). Les tris avec < 2 sommets survivants disparaissent
// (regle §4.1 'segment oppose survit').
export const deleteSelectedPoint = () => {
    const shape = activeShape()
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getIndicesAtSamePosition(state.nearestPoint.point)
    }
    if (targets.length === 0) return
    saveState()
    const targetSet = new Set(targets)
    // Retrait par slot : un slot pX egal a un indice cible devient
    // undefined ; les tris avec < 2 survivants sont filtres. p3
    // (partial eventuel) reste undefined si manquant.
    const trisBeforeFilter = shape.tris
    const filteredTris = []
    for (let i = 0; i < trisBeforeFilter.length; i++) {
        const t = trisBeforeFilter[i]
        const surviving = []
        if (Number.isInteger(t.p1) && !targetSet.has(t.p1)) surviving.push(t.p1)
        if (Number.isInteger(t.p2) && !targetSet.has(t.p2)) surviving.push(t.p2)
        if (Number.isInteger(t.p3) && !targetSet.has(t.p3)) surviving.push(t.p3)
        if (surviving.length < 2) continue
        filteredTris.push({
            p1: surviving[0],
            p2: surviving[1],
            p3: surviving[2] !== undefined ? surviving[2] : undefined,
        })
    }
    shape.tris = filteredTris
    const idxMap = compactPointList(shape)
    state.selectedPoints = state.selectedPoints
        .filter(idx => !targetSet.has(idx))
        .map(idx => idxMap.has(idx) ? idxMap.get(idx) : undefined)
        .filter(idx => idx !== undefined)
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un segment (mode 'segment') =====

// §4.1 : suppression des triangles dont 2+ slots matchent les
// endpoints du segment. Les triangles avec 0-1 match survivent (leurs
// autres slots conservent leur ref). Compact pointList invariant I2.
export const deleteSelectedSegment = () => {
    const shape = activeShape()
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestLine && state.nearestLine.firstPoint && state.nearestLine.secondPoint) {
        if (!adjacentPoints(state.nearestLine.firstPoint, state.nearestLine.secondPoint, 0.01)) {
            targets = collectUnderlyingPoints([
                state.nearestLine.firstPoint,
                state.nearestLine.secondPoint,
            ])
        }
    }
    if (targets.length === 0) return
    saveState()
    const targetSet = new Set(targets)
    shape.tris = shape.tris.filter(t => {
        let matchCount = 0
        if (Number.isInteger(t.p1) && targetSet.has(t.p1)) matchCount++
        if (Number.isInteger(t.p2) && targetSet.has(t.p2)) matchCount++
        if (Number.isInteger(t.p3) && targetSet.has(t.p3)) matchCount++
        return matchCount < 2
    })
    compactPointList(shape)
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un triangle (mode 'triangle') =====

// §4.1 : suppression stricte des triangles dont les 3 slots
// matchent le triangle selectionne (matchCount === 3). Distinct du
// mode segment : on ne supprime pas les triangles partageant un sommet.
// Compact pointList I2.
export const deleteSelectedTriangle = () => {
    const shape = activeShape()
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestTriangle && state.nearestTriangle.triangle) {
        const t = state.nearestTriangle.triangle
        if (Number.isInteger(t.p1) && Number.isInteger(t.p2) && Number.isInteger(t.p3)) {
            const pl = shape.pointList
            targets = collectUnderlyingPoints([pl[t.p1], pl[t.p2], pl[t.p3]])
        }
    }
    if (targets.length === 0) return
    saveState()
    const targetSet = new Set(targets)
    shape.tris = shape.tris.filter(t => {
        let matchCount = 0
        if (Number.isInteger(t.p1) && targetSet.has(t.p1)) matchCount++
        if (Number.isInteger(t.p2) && targetSet.has(t.p2)) matchCount++
        if (Number.isInteger(t.p3) && targetSet.has(t.p3)) matchCount++
        return matchCount < 3
    })
    compactPointList(shape)
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.nearestTriangle = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    persistState()
}

// ===== Grab (drag) d'un point =====

export const grabbed = () => state.currentAction === ACTION_GRABBING

// Q1c : findNearestTriangle/Line renvoient des pointIndices
// (arrays d'indices) ; collectUnderlyingPoints prend des coords et
// renvoie des indices ; applySelectionModifiers attend des indices.
// Pas de doublance coords <=> indices entre les helpers : un seul
// aller-retour via pointList.
const selectAtRightClick = (e, targetModel, additive = true) => {
    let indices = []
    let triangleIndex = -1
    const shape = activeShape()
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []

    if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt && Array.isArray(nt.pointIndices)) {
            indices = collectUnderlyingPoints(nt.pointIndices.map(i => pointList[i]))
            triangleIndex = nt.triangleIndex
        }
    } else if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            indices = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
        }
    } else {
        const np = findNearestPoint(targetModel)
        if (np && np.distance <= pointHitRadiusModel() && np.point) {
            indices = getIndicesAtSamePosition(np.point)
        }
    }

    if (indices.length === 0) {
        if (!additive) {
            state.selectedPoints = []
            state.selectedTriangles = []
            updateSelectionHud()
            updateColorButtonState()
            drawBoard()
        }
        return false
    }

    const selectionEvent = additive
        ? { ...e, shiftKey: false, ctrlKey: true, metaKey: false }
        : { ...e, shiftKey: false, ctrlKey: false, metaKey: false }
    applySelectionModifiers(indices, selectionEvent, false)
    if (state.selectionMode === 'triangle') {
        applyTriangleIndexModifier(triangleIndex, selectionEvent)
    } else if (state.selectionMode === 'segment') {
        state.selectedTriangles = []
    }
    updateSelectionHud()
    updateColorButtonState()
    state.nearestPoint = undefined
    drawBoard()
    return true
}

export const processRightClickSelection = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawTargetModel = screenToModel(mouseScreen)
    const targetModel = state.activeGrid ? snapToGrid(rawTargetModel) : rawTargetModel
    return selectAtRightClick(e, targetModel, false)
}

// AltGr drag itere shape.pointList directement (Q1a per-shape,
// pas de tour triangulaire pour collecter). Chaque grabbedGroup entry
// devient {shapeIndex, pointIndex, triangleIndex, slotId, startX, startY}
// (Q2c supprime selectedPointRef). buildGrabbedGroupFromSelection
// produit cette nouvelle structure (drag d'une selection engageante).
// §3.6.1 sparse-replace, mode-aware (Q1c) — la detection est faite
// sur la topologie canonique (pointList + tris) et retourne un
// predicat O(N) qui permet la parite click/drag WYSIWYG sur les 3
// modes (vertex / segment / triangle).
// - vertex : 0 entree OU tous les indices selectedPoints au meme
//   coord (cluster, tol §3.2 0.01).
// - segment : 0 entree OU <= 1 edge couvert par la selection
//   (edges = paires consecutives (p1,p2)/(p2,p3)/(p3,p1) d'un
//   triangle avec ses 2 endpoints dans selectedPoints et distincts).
// - triangle : 0 entree OU <= 1 triangle dont les 3 slots sont
//   dans selectedPoints.
// Anti-flicker gere separement plus bas (le check
// !sparseCursorGrabIndices.every(idx => state.selectedPoints.includes(idx))).
// Returns early des que covered > 1 (memes bornes O(N) que l'ancien
// isSingleCluster, pas de degradation mesurable).
const isSelectionSparse = () => {
    const sp = state.selectedPoints
    if (!Array.isArray(sp) || sp.length === 0) return true
    const shape = activeShape()
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    const mode = state.selectionMode
    if (mode === 'vertex') {
        return sp.every((idx, i, arr) =>
            i === 0
            || (pointList[idx] && pointList[arr[0]] && adjacentPoints(pointList[idx], pointList[arr[0]], 0.01))
        )
    }
    if (mode === 'segment') {
        // Une edge partagee entre plusieurs triangles (ex. fan autour
        // d'un axe) reste un seul segment logique : dedup par paire
        // non ordonnee (min-max) sinon le compteur gonfle a N pour
        // une edge presente dans N tris et le predicat devient faux
        // positif en 'not sparse' alors que l'utilisateur n'a bien
        // qu'1 entite engagee. Regression report : clic sur
        // l'edge AB dans T1={p1:0,p2:1,p3:2} / T2={p1:0,p2:1,p3:3}
        // => selectedPoints=[0,1], cover=2 (avant) au lieu de 1.
        const set = new Set(sp)
        const coveredEdges = new Set()
        for (const t of tris) {
            if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) continue
            const pairs = [[t.p1, t.p2], [t.p2, t.p3], [t.p3, t.p1]]
            for (const [a, b] of pairs) {
                if (a !== b && set.has(a) && set.has(b)) {
                    const key = a < b ? `${a}-${b}` : `${b}-${a}`
                    coveredEdges.add(key)
                    if (coveredEdges.size > 1) return false
                }
            }
        }
        return true
    }
    if (mode === 'triangle') {
        let covered = 0
        for (const t of tris) {
            if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) continue
            if (sp.includes(t.p1) && sp.includes(t.p2) && sp.includes(t.p3)) {
                covered++
                if (covered > 1) return false
            }
        }
        return true
    }
    return false
}

export const beginGrabbing = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }

    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    state.moveAllActive = isAltGrDown
    state.grabbedGroup = []
    state.grabHistorySaved = false
    state.hasDragged = false

    if (isAltGrDown) {
        state.currentAction = ACTION_GRABBING
        state.grabHistorySaved = false
        state.grabStartMouse = mouseScreen
        state.selectedPoints = []
        updateSelectionHud()
        state.shapes.forEach((shape, sIndex) => {
            const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
            for (let i = 0; i < pointList.length; i++) {
                const p = pointList[i]
                if (!p) continue
                state.grabbedGroup.push({
                    shapeIndex: sIndex,
                    pointIndex: i,
                    startX: p.x,
                    startY: p.y,
                })
            }
        })
        if (state.grabbedGroup.length === 0) {
            state.currentAction = undefined
            state.grabStartMouse = undefined
            state.grabHistorySaved = false
            return false
        }
        log(`AltGr detecte - deplacement de ${state.shapes.length} forme(s) : ${state.grabbedGroup.length} points`)
        state.board.style.cursor = 'move'
        return true
    }

    const hasCtrlSelectionModifier = e.ctrlKey || e.metaKey
    if (hasCtrlSelectionModifier) {
        const rawTargetModel = screenToModel(mouseScreen)
        const targetModel = state.activeGrid ? snapToGrid(rawTargetModel) : rawTargetModel
        selectAtRightClick(e, targetModel)
        state.moveAllActive = false
        return false
    }

    // §3.6.1 sparse-replace WYSIWYG, mode-aware : predicate
    // isSelectionSparse() juste au-dessus couvre les 3 modes
    // (vertex cluster / segment edge / triangle complet) pour la
    // parite click/drag. Maintient l'invariant I4 (selectedPoints
    // ⊆ [0, pointList.length)) : la detection n'insere aucun index.
    let sparseCursorGrabIndices = []
    const pointList = activeShape().pointList || []
    if (isSelectionSparse()) {
        const sparseTargetModel = screenToModel(mouseScreen)
        if (state.selectionMode === 'triangle') {
            const nt = findNearestTriangle(sparseTargetModel)
            if (nt && Array.isArray(nt.pointIndices)) {
                sparseCursorGrabIndices = collectUnderlyingPoints(nt.pointIndices.map(i => pointList[i]))
            }
        } else if (state.selectionMode === 'segment') {
            const ns = findSelectedLine(sparseTargetModel)
            if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
                sparseCursorGrabIndices = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            }
        } else {
            const np = findNearestPoint(sparseTargetModel)
            if (np && np.distance <= pointHitRadiusModel() && np.point) {
                sparseCursorGrabIndices = getIndicesAtSamePosition(np.point)
            }
        }
        if (
            state.selectedPoints.length > 0 &&
            sparseCursorGrabIndices.length > 0 &&
            !sparseCursorGrabIndices.every(idx => state.selectedPoints.includes(idx))
        ) {
            applySelectionModifiers(sparseCursorGrabIndices, e, state.selectionMode === 'vertex')
            if (state.selectionMode === 'triangle') {
                applyGrabTriangleSync(sparseCursorGrabIndices, e)
            } else if (state.selectionMode === 'segment') {
                state.selectedTriangles = []
            }
            if (state.selectionMode === 'triangle' || state.selectionMode === 'segment') {
                updateColorButtonState()
            }
            updateSelectionHud()
        }
    }

    // A right drag moves the committed selection as a group. The sparse
    // case (1 cluster + cursor on a different entity) has already been
    // replaced above §3.6.1 ; multi-element selections are preserved
    // (filet défensif §3.6.1).
    if (state.selectedPoints.length > 0) {
        state.currentAction = ACTION_GRABBING
        state.grabStartMouse = mouseScreen
        state.grabHistorySaved = false
        state.grabbedGroup = buildGrabbedGroupFromSelection()
        if (state.grabbedGroup.length === 0) {
            state.currentAction = ACTION_NONE
            state.grabStartMouse = undefined
            state.grabHistorySaved = false
            return false
        }
        state.board.style.cursor = 'move'
        return true
    }

    // preserveExisting : Shift remains available for the historical
    // right-click target-selection behavior; Ctrl/Cmd was handled above.
    const hasModifier = e.shiftKey
    const rawTargetModel = screenToModel(mouseScreen)
    const targetModel = state.activeGrid ? snapToGrid(rawTargetModel) : rawTargetModel
    let grabIndices = []
    let preserveExisting = false
    if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt && Array.isArray(nt.pointIndices)) {
            grabIndices = collectUnderlyingPoints(nt.pointIndices.map(i => pointList[i]))
            preserveExisting = !hasModifier && grabIndices.length > 0 && grabIndices.every(idx => state.selectedPoints.includes(idx))
        }
    } else if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            grabIndices = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            preserveExisting = !hasModifier && grabIndices.length > 0 && grabIndices.every(idx => state.selectedPoints.includes(idx))
        }
    }
    if (grabIndices.length === 0) {
        const np = findNearestPoint(targetModel)
        if (!np || np.distance > pointHitRadiusModel() || !np.point) return false
        grabIndices = getIndicesAtSamePosition(np.point)
        preserveExisting = !hasModifier && state.selectedPoints.includes(np.pointIndex)
    }

    state.currentAction = ACTION_GRABBING
    state.grabStartMouse = mouseScreen
    state.grabHistorySaved = false

    if (!preserveExisting) {
        applySelectionModifiers(grabIndices, e, state.selectionMode === 'vertex')
        if (state.selectionMode === 'triangle') {
            applyGrabTriangleSync(grabIndices, e)
        } else if (state.selectionMode === 'segment') {
            state.selectedTriangles = []
        }
        if (state.selectionMode === 'triangle' || state.selectionMode === 'segment') {
            updateColorButtonState()
        }
        updateSelectionHud()
    }

    state.grabbedGroup = buildGrabbedGroupFromSelection()
    if (state.grabbedGroup.length === 0) {
        state.currentAction = ACTION_NONE
        state.grabStartMouse = undefined
        state.grabHistorySaved = false
        state.board.style.cursor = 'none'
        return false
    }
    state.board.style.cursor = 'move'
    return true
}

// Q2c : nouvelle structure d'entree — {shapeIndex, pointIndex,
// triangleIndex, slotId, startX, startY} plus de selectedPointRef (la
// coherence avec state.selectedPoints est assuree par construction :
// une mutation de pointList[idx].x propage directement aux coords
// observees par drawSelectedPoints/Q7.6).
const buildGrabbedGroupFromSelection = () => {
    const group = []
    const shape = activeShape()
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    state.selectedPoints.forEach(idx => {
        tris.forEach((t, i) => {
            const slots = []
            if (t.p1 === idx) slots.push('p1')
            if (t.p2 === idx) slots.push('p2')
            if (t.p3 === idx) slots.push('p3')
            if (slots.length === 0) return
            const pt = pointList[idx]
            if (!pt) return
            slots.forEach(slotId => {
                group.push({
                    shapeIndex: state.activeShapeIndex,
                    pointIndex: idx,
                    triangleIndex: i,
                    slotId,
                    startX: pt.x,
                    startY: pt.y,
                })
            })
        })
    })
    return group
}

export const endGrabbing = (e) => {
    // Keep the grab active while applying the final mouse position: a
    // mouseup can arrive without a preceding mousemove event.
    const wasMoveAll = state.moveAllActive
    resolveMouseMoveOnBoard(e)
    const movedScene = state.hasDragged

    // A plain right click is selection-only; a right drag remains a move.
    // The deferred decision avoids moving the selection on a click while
    // preserving the distant-start drag gesture.
    if (!wasMoveAll && !movedScene && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        processRightClickSelection(e)
    }

    state.currentAction = ACTION_NONE
    state.grabHistorySaved = false
    state.hasDragged = false
    state.grabStartMouse = undefined
    state.grabbedGroup = []
    state.board.style.cursor = 'none'
    state.moveAllActive = false
    persistState()
}

export const resolveMouseMoveOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }

    if (state.isSelectingBox) {
        state.selectionBoxCurrent = mouseScreen
        const dragDist = Math.hypot(
            mouseScreen.x - state.selectionBoxStart.x,
            mouseScreen.y - state.selectionBoxStart.y
        )
        if (dragDist >= 5) {
            const m1 = screenToModel(state.selectionBoxStart)
            const m2 = screenToModel(state.selectionBoxCurrent)
            const minXM = Math.min(m1.x, m2.x)
            const maxXM = Math.max(m1.x, m2.x)
            const minYM = Math.min(m1.y, m2.y)
            const maxYM = Math.max(m1.y, m2.y)
            const shape = activeShape()
            const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
            // Q1c : la selection du lasso est un array d'indices
            // dans le pointList canonique. On garde invariant I3 (pas de
            // doublon intra-coord) ; l'unique coord-matching est
            // inBox.indexOf(idx) sans passer par un cluster.
            const inBoxIndices = []
            for (let i = 0; i < pointList.length; i++) {
                const p = pointList[i]
                if (!p) continue
                if (p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM) inBoxIndices.push(i)
            }
            state.selectedPoints = inBoxIndices
        }
    } else if (grabbed()) {
        const dragDist = Math.hypot(
            mouseScreen.x - state.grabStartMouse.x,
            mouseScreen.y - state.grabStartMouse.y,
        )
        if (dragDist >= 5) state.hasDragged = true
        if (state.hasDragged) {
            const curModel = screenToModel(mouseScreen)
            const startModel = screenToModel(state.grabStartMouse)
            const dx = curModel.x - startModel.x
            const dy = curModel.y - startModel.y
            if (!state.grabHistorySaved && state.grabbedGroup.some(item => {
                const targetPos = getGrabTargetPosition(item, dx, dy)
                return Math.abs(targetPos.x - item.startX) > 0.01 || Math.abs(targetPos.y - item.startY) > 0.01
            })) {
                saveState()
                state.grabHistorySaved = true
            }
            state.grabbedGroup.forEach(item => {
                applyGrabToPoint(item, getGrabTargetPosition(item, dx, dy))
            })
        }
    }

    state.lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
    updateSelectionHud()
}

const getGrabTargetPosition = (item, dx, dy) => {
    if (state.activeGrid && state.moveAllActive) {
        const snappedDelta = snapToGrid({ x: dx, y: dy })
        return {
            x: item.startX + snappedDelta.x,
            y: item.startY + snappedDelta.y,
        }
    }
    const rawPos = { x: item.startX + dx, y: item.startY + dy }
    return (state.activeGrid && !state.moveAllActive) ? snapToGrid(rawPos) : rawPos
}

// Q2c : plus de selectedPointRef (Q2c). L'item porte un
// pointIndex direct ; on mute pointList[item.pointIndex] en place.
// Cette mutation couvre tous les slots partagant cet indice (les N
// triangles qui referencent le meme sommet visuelle bougent en
// O(1)).
const applyGrabToPoint = (item, targetPos) => {
    const shape = state.shapes[item.shapeIndex]
    if (!shape || !Array.isArray(shape.pointList)) return
    const pt = shape.pointList[item.pointIndex]
    if (!pt) return
    pt.x = targetPos.x
    pt.y = targetPos.y
    // Validation granulometre : si la mutation rend le slot indefini
    // partiellement (item.slotId etait 'p3' mais l'utilisateur a drag
    // un vertex partage avec un triangle en cours de construction),
    // on ecrase tous les slots de la triple qui touchent cet idx -
    // deja couvert par definition identique `pointList[idx].x`.
}

// ===== Rotation runtime =====

// la rotation opere sur le pointList canonique (Q1a per-shape),
// une seule mutation par sommet logique (au lieu de N mutations sur les
// slots triangulaires).
export const rotateEachShapeAroundPivot = (pivotModel, angle) => {
    if (!state.shapes || state.shapes.length === 0) return
    if (!state.isEachShapeRotating) {
        saveState()
        state.isEachShapeRotating = true
        state.selectedPoints = []
        updateSelectionHud()
        log('AltGr + molette detecte - rotation de chaque forme autour du curseur (5 deg/tick)')
    }
    clearTimeout(state.eachShapeRotateTimer)
    state.eachShapeRotateTimer = setTimeout(() => {
        state.isEachShapeRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    state.shapes.forEach((shape) => {
        if (!Array.isArray(shape.pointList)) return
        shape.pointList.forEach((p) => {
            if (!p) return
            const dx = p.x - pivotModel.x
            const dy = p.y - pivotModel.y
            p.x = pivotModel.x + dx * cos - dy * sin
            p.y = pivotModel.y + dx * sin + dy * cos
        })
    })

    state.ctx.rotationTracking = ((state.ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

// Q1c : state.selectedPoints est un array d'indices ; on
// mute directement pointList[idx]. Une rotation d'un point partage
// par N triangles produit N mises a jour identiques sur la meme
// coord - l'effet visuel est identique, la complexite est O(N) en
// selectedPoints au lieu de O(M*N) en tri*slots.
export const rotateSelectedPoints = (center, angle) => {
    if (state.selectedPoints.length < 2 || state.isSelectionDimmed) return
    if (!state.isWheelRotating) {
        saveState()
        state.isWheelRotating = true
    }
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = setTimeout(() => {
        state.isWheelRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    const activeShapeRef = state.shapes[state.activeShapeIndex]
    const pointList = Array.isArray(activeShapeRef.pointList) ? activeShapeRef.pointList : []

    state.selectedPoints.forEach(idx => {
        const sp = pointList[idx]
        if (!sp) return
        const dx = sp.x - center.x
        const dy = sp.y - center.y
        const nx = center.x + dx * cos - dy * sin
        const ny = center.y + dx * sin + dy * cos
        let target = { x: nx, y: ny }
        if (state.activeGrid) target = snapToGrid(target)
        sp.x = target.x
        sp.y = target.y
    })

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// ===== Coloration des triangles (mode 'triangle') =====

// (modifyShapeModel-spec §3.6) : la liste de triangles de la
// forme active est `tris` (indexe) $
export const applyColorToSelectedTriangles = (color) => {
    if (!state.shapes || !state.shapes[state.activeShapeIndex]) return
    if (!state.selectedTriangles || state.selectedTriangles.length === 0) return
    const tris = state.shapes[state.activeShapeIndex].tris
    if (!Array.isArray(tris)) return
    saveState()
    state.selectedTriangles.forEach(idx => {
        const t = tris[idx]
        if (!t) return
        if (color === TRIANGLE_COLOR_CLEAR) {
            delete t.fill
        } else if (typeof color === 'string' && color.length > 0) {
            t.fill = color
        }
    })
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    persistState()
}

// ===== Panneau flottant de coloration =====

// Rationale : voir DESIGN.md §3.3
export const toggleTriangleColorPanel = () => {
    const btn = document.querySelector('#triangleColor')
    const panel = document.querySelector('#triangleColorPanel')
    if (!btn || !panel) return
    if (state.selectionMode !== 'triangle' || !state.selectedTriangles || state.selectedTriangles.length === 0) return
    if (state.isTriangleColorPanelOpen) {
        hideTriangleColorPanel()
        return
    }
    showTriangleColorPanel()
}

export const showTriangleColorPanel = () => {
    const btn = document.querySelector('#triangleColor')
    const panel = document.querySelector('#triangleColorPanel')
    if (!btn || !panel) return
    const rect = btn.getBoundingClientRect()
    panel.style.top = (rect.bottom + 4) + 'px'
    panel.style.left = rect.left + 'px'
    panel.hidden = false
    state.isTriangleColorPanelOpen = true
    btn.classList.add('color-panel-open')
}

export const hideTriangleColorPanel = () => {
    const panel = document.querySelector('#triangleColorPanel')
    const btn = document.querySelector('#triangleColor')
    if (panel) panel.hidden = true
    state.isTriangleColorPanelOpen = false
    if (btn) btn.classList.remove('color-panel-open')
}

const buildColorSwatches = () => {
    const host = document.querySelector('#triangleColorSwatches')
    if (!host) return
    while (host.firstChild) host.removeChild(host.firstChild)
    TRIANGLE_COLOR_PRESETS.forEach((preset, i) => {
        const sw = document.createElement('button')
        sw.type = 'button'
        sw.className = 'swatch'
        sw.style.backgroundColor = preset.bg
        sw.title = 'Appliquer ' + preset.bg
        sw.dataset.index = String(i)
        sw.addEventListener('click', (e) => {
            if (e.button !== 0) return
            applyColorToSelectedTriangles(preset.fill)
            host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
            sw.classList.add('swatch-active')
        })
        host.appendChild(sw)
    })
}

export const wireTriangleColorPanel = () => {
    const btn = document.querySelector('#triangleColor')
    const panel = document.querySelector('#triangleColorPanel')
    const input = document.querySelector('#triangleColorInput')
    const resetBtn = document.querySelector('#triangleColorReset')
    if (!btn || !panel || !input || !resetBtn) return
    buildColorSwatches()
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleTriangleColorPanel()
    })
    input.addEventListener('input', () => {
        applyColorToSelectedTriangles(input.value)
        const host = document.querySelector('#triangleColorSwatches')
        if (host) {
            host.querySelectorAll('.swatch').forEach(s => {
                const preset = TRIANGLE_COLOR_PRESETS[Number(s.dataset.index)]
                if (preset && preset.fill === input.value) {
                    s.classList.add('swatch-active')
                } else {
                    s.classList.remove('swatch-active')
                }
            })
        }
    })
    resetBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        applyColorToSelectedTriangles(TRIANGLE_COLOR_CLEAR)
        const host = document.querySelector('#triangleColorSwatches')
        if (host) host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
        input.value = TRIANGLE_COLOR_PRESETS[0].bg
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.isTriangleColorPanelOpen) return
        const target = e.target
        if (!target) return
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        hideTriangleColorPanel()
    })
}

// ===== Drop (drag/drop d'un fichier JSON) =====

export const wireBoardDrop = () => {
    if (!state.board) return
    state.board.addEventListener('dragover', (e) => {
        e.preventDefault()
    })
    state.board.addEventListener('drop', (e) => {
        e.preventDefault()
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
        const file = e.dataTransfer.files[0]
        importMeshFromFile(file)
    })
}
