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
import { drawBoard, drawPoint, drawMouse } from './draw.js'
import { updateSelectionHud, updateColorButtonState } from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import { modelToScreen } from './geometry.js'
import {
    screenToModel, snapToGrid,
    activeTriangles, getAllVertices, getPointsAtSamePosition, isPointSelected,
    adjacentPoints, computeOrthogonalProjection, isInsideSegmentByDot,
} from './geometry.js'
import { saveState } from './history.js'
import { persistState, importMeshFromFile } from './io.js'
import { log } from './log.js'

// ===== find : point/line/triangle les plus proches =====

export const findNearestPoint = (point) => {
    return findNextNearestPoint({ point: point, triangleIndex: -1 })
}

export const findNextNearestPoint = (nearestPoint) => {
    let shortDistance = Number.MAX_VALUE
    let shortIndex = -1
    let shortPointIndex = -1
    const tris = activeTriangles()
    tris.forEach((e, i) => {
        if (i <= nearestPoint.triangleIndex) return
        ;[e.p1, e.p2, e.p3].forEach((p, j) => {
            if (!p) return
            const d = Math.hypot(p.x - nearestPoint.point.x, p.y - nearestPoint.point.y)
            if (d < shortDistance) {
                shortIndex = i
                shortDistance = d
                shortPointIndex = j
            }
        })
    })
    if (shortIndex < 0) return undefined
    const pointId = ['p1', 'p2', 'p3'][shortPointIndex]
    const trisRef = activeTriangles()
    return {
        triangleIndex: shortIndex,
        distance: shortDistance,
        pointIndex: shortPointIndex,
        triangle: trisRef[shortIndex],
        pointId,
        point: trisRef[shortIndex][pointId],
    }
}

const modelToleranceForPixels = (pixels) => pixels / Math.max(state.ctx.zoomLevel, 0.0001)
const pointHitRadiusModel = () => modelToleranceForPixels(POINT_HIT_RADIUS_PX)
const lineHitRadiusModel = () => modelToleranceForPixels(LINE_HIT_RADIUS_PX)
const triangleCentroidHitRadiusModel = () => modelToleranceForPixels(TRIANGLE_CENTROID_HIT_RADIUS_PX)
export const findNearestTriangle = (point) => {
    const tris = activeTriangles()
    let bestInside = undefined
    let bestInsideDist = Number.MAX_VALUE
    let bestNear = undefined
    let bestNearDist = Number.MAX_VALUE
    tris.forEach((t, i) => {
        if (!t.p1 || !t.p2 || !t.p3) return
        const cx = (t.p1.x + t.p2.x + t.p3.x) / 3
        const cy = (t.p1.y + t.p2.y + t.p3.y) / 3
        const distToCentroid = Math.hypot(point.x - cx, point.y - cy)
        const inside = pointInsideTriangle(point, t.p1, t.p2, t.p3)
        const candidate = { triangleIndex: i, triangle: t, p1: t.p1, p2: t.p2, p3: t.p3, _distance: distToCentroid }
        if (inside) {
            if (distToCentroid < bestInsideDist) {
                bestInsideDist = distToCentroid
                bestInside = candidate
            }
        } else if (distToCentroid <= triangleCentroidHitRadiusModel()) {
            if (distToCentroid < bestNearDist) {
                bestNearDist = distToCentroid
                bestNear = candidate
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

export const findSelectedLine = (point) => {
    let shortDistance = Number.MAX_VALUE
    let shortTriangleIndex = -1
    let shortLineIndex = -1
    const tris = activeTriangles()
    tris.forEach((t, i) => {
        if (!t.p1 || !t.p2 || !t.p3) return
        let cop = computeOrthogonalProjection(point, t.p1, t.p2)
        let d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p1, t.p2)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 0
        }
        cop = computeOrthogonalProjection(point, t.p2, t.p3)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p2, t.p3)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 1
        }
        cop = computeOrthogonalProjection(point, t.p3, t.p1)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p3, t.p1)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 2
        }
    })
    if (shortTriangleIndex < 0) return undefined
    const firstPointId = ['p1', 'p2', 'p3'][shortLineIndex]
    const secondPointId = ['p2', 'p3', 'p1'][shortLineIndex]
    const trisRef = activeTriangles()
    return {
        triangleIndex: shortTriangleIndex,
        firstPointIndex: [0, 1, 2][shortLineIndex],
        secondPointIndex: [1, 2, 0][shortLineIndex],
        triangle: trisRef[shortTriangleIndex],
        firstPointId,
        secondPointId,
        firstPoint: trisRef[shortTriangleIndex][firstPointId],
        secondPoint: trisRef[shortTriangleIndex][secondPointId],
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
            const p1 = t.p1, p2 = t.p2, p3 = t.p3
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

export const addPoint = (point) => {
    const tris = activeTriangles()
    for (let i = 0; i < tris.length; i++) {
        const triangle = tris[i]
        if (adjacentPoints(point, triangle.p1, 1)) return
        if (triangle.p2 !== undefined) if (adjacentPoints(point, triangle.p2, 1)) return
        if (triangle.p3 !== undefined) if (adjacentPoints(point, triangle.p3, 1)) return
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
        const partial = { p1: point }
        tris.push(partial)
        state.activeConstructionTriangle = partial
    } else {
        const triangle = lastTriangle
        if (triangle.p2 === undefined) {
            triangle.p2 = point
            state.activeConstructionTriangle = triangle
        } else if (triangle.p3 === undefined && isActivePartial && !nearestLine) {
            triangle.p3 = point
            state.activeConstructionTriangle = undefined
        } else if (nearestLine) {
            tris.push({
                p1: nearestLine.firstPoint,
                p2: nearestLine.secondPoint,
                p3: point,
            })
            state.activeConstructionTriangle = undefined
        }
    }
    state.ctx.workIsSaved = 0
    state.ctx.workIsBackuped = 0
    persistState()
}

export const selectAllPoints = () => {
    if (state.editingMode === 'construction') return
    const result = []
    const vertices = getAllVertices()
    vertices.forEach(p => {
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    state.selectedPoints = result
    if (state.selectionMode === 'triangle') {
        const tris = activeTriangles()
        state.selectedTriangles = tris
            .map((t, i) => (t && t.p1 && t.p2 && t.p3 ? i : -1))
            .filter(i => i >= 0)
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
    // Ctrl/Cmd is reserved for additive selection on right-click. A left
    // click keeps its plain selection/lasso contract; Shift remains its
    // toggle modifier.
    const leftSelectionEvent = { ...e, ctrlKey: false, metaKey: false }

    if (state.editingMode !== 'construction' && state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            const cluster = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            state.selectedTriangles = []
            applySelectionModifiers(cluster, leftSelectionEvent)
            updateColorButtonState()
            return
        }
    } else if (state.editingMode !== 'construction' && state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt) {
            const cluster = collectUnderlyingPoints([nt.p1, nt.p2, nt.p3])
            applySelectionModifiers(cluster, leftSelectionEvent)
            applyTriangleIndexModifier(nt.triangleIndex, leftSelectionEvent)
            return
        }
    }

    if (state.editingMode !== 'construction') {
        if (pointHit) {
            const pointsAtPos = getPointsAtSamePosition(pointHit.point)
            if (state.selectionMode !== 'triangle') state.selectedTriangles = []
            applySelectionModifiers(pointsAtPos, leftSelectionEvent, state.selectionMode === 'vertex')
        } else if (state.editingMode === 'selection') {
            // Specialized selection mode never creates geometry.
            if (!leftSelectionEvent.shiftKey) state.selectedPoints = []
            state.selectedTriangles = []
            updateSelectionHud()
            updateColorButtonState()
        } else if (leftSelectionEvent.shiftKey) {
            // Shift preserves the current selection and suppresses creation.
        } else {
            // Edition mode remains fluid: an empty click creates the next
            // point without requiring a mode switch.
            state.selectedPoints = []
            state.selectedTriangles = []
            updateSelectionHud()
            updateColorButtonState()
            resolveMouseClickOnBoard(e)
        }
    } else if (!pointHit) {
        if (leftSelectionEvent.shiftKey) {
            // Shift in construction mode preserves the selection and
            // deliberately does not create a point on empty space.
        } else {
            state.selectedPoints = []
            resolveMouseClickOnBoard(e)
        }
    }
}

const collectUnderlyingPoints = (basePoints) => {
    const result = []
    basePoints.forEach(p => {
        if (!p) return
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    return result
}

const applyGrabTriangleSync = (grabPoints, e) => {
    const tris = activeTriangles()
    const matching = []
    tris.forEach((t, i) => {
        if (!t.p1 || !t.p2 || !t.p3) return
        const slots = [t.p1, t.p2, t.p3]
        const allMatch = grabPoints.every(gp => slots.some(s => adjacentPoints(s, gp, 0.01)))
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
                // i que si ses 3 sommets sont en sélection (sinon le toggle
                // de applySelectionModifiers les a déjà retirés et un push
                // laisserait l'index dans selectedTriangles alors que ses
                // sommets sont retirés -> incohérence visuelle).
                const t = tris[i]
                const inSel = t && t.p1 && t.p2 && t.p3 && [t.p1, t.p2, t.p3].every(p => state.selectedPoints.some(sp => adjacentPoints(p, sp, 0.01)))
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

const toggleSelectionPoints = (pointsAtPos) => {
    const anySelected = pointsAtPos.some(p => isPointSelected(p))
    if (anySelected) {
        state.selectedPoints = state.selectedPoints.filter(sp => !pointsAtPos.some(p => adjacentPoints(sp, p, 0.01)))
    } else {
        pointsAtPos.forEach(p => {
            if (!isPointSelected(p)) state.selectedPoints.push(p)
        })
    }
}

// Rationale : voir DESIGN.md §3.6
const applySelectionModifiers = (pointsAtPos, e, ctrlToggles = false) => {
    if (e.shiftKey) {
        toggleSelectionPoints(pointsAtPos)
    } else if (e.ctrlKey || e.metaKey) {
        if (ctrlToggles) {
            toggleSelectionPoints(pointsAtPos)
        } else {
            pointsAtPos.forEach(p => {
                if (!isPointSelected(p)) state.selectedPoints.push(p)
            })
        }
    } else {
        state.selectedPoints = [...pointsAtPos]
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

// ===== Suppression d'un point =====

// ===== Suppression d'un point =====

// Rationale : voir DESIGN.md §1.1
export const deleteSelectedPoint = () => {
    if (state.editingMode === 'construction') return
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getPointsAtSamePosition(state.nearestPoint.point)
    }
    if (targets.length === 0) return
    saveState()
    const activeShapeRef = state.shapes[state.activeShapeIndex]
    activeShapeRef.triangles = activeShapeRef.triangles
        .map(t => {
            const surviving = []
            if (t.p1 && !targets.some(target => adjacentPoints(t.p1, target, 0.01))) surviving.push(t.p1)
            if (t.p2 && !targets.some(target => adjacentPoints(t.p2, target, 0.01))) surviving.push(t.p2)
            if (t.p3 && !targets.some(target => adjacentPoints(t.p3, target, 0.01))) surviving.push(t.p3)
            if (surviving.length < 2) return null
            t.p1 = surviving[0]
            t.p2 = surviving[1]
            t.p3 = surviving[2]
            return t
        })
        .filter(t => t !== null)
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

// ===== Suppression d'un segment (mode 'segment') =====

// Rationale : voir DESIGN.md §8
export const deleteSelectedSegment = () => {
    if (state.editingMode === 'construction') return
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
    const activeShapeRef = state.shapes[state.activeShapeIndex]
    activeShapeRef.triangles = activeShapeRef.triangles.filter(t => {
        let matchCount = 0
        if (t.p1 && targets.some(tp => adjacentPoints(tp, t.p1, 0.01))) matchCount++
        if (t.p2 && targets.some(tp => adjacentPoints(tp, t.p2, 0.01))) matchCount++
        if (t.p3 && targets.some(tp => adjacentPoints(tp, t.p3, 0.01))) matchCount++
        return matchCount < 2
    })
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

// Rationale : voir DESIGN.md §7.1
export const deleteSelectedTriangle = () => {
    if (state.editingMode === 'construction') return
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestTriangle && state.nearestTriangle.triangle && state.nearestTriangle.triangle.p1 && state.nearestTriangle.triangle.p2 && state.nearestTriangle.triangle.p3) {
        targets = collectUnderlyingPoints([
            state.nearestTriangle.triangle.p1,
            state.nearestTriangle.triangle.p2,
            state.nearestTriangle.triangle.p3,
        ])
    }
    if (targets.length === 0) return
    saveState()
    const activeShapeRef = state.shapes[state.activeShapeIndex]
    activeShapeRef.triangles = activeShapeRef.triangles.filter(t => {
        let matchCount = 0
        if (t.p1 && targets.some(tp => adjacentPoints(tp, t.p1, 0.01))) matchCount++
        if (t.p2 && targets.some(tp => adjacentPoints(tp, t.p2, 0.01))) matchCount++
        if (t.p3 && targets.some(tp => adjacentPoints(tp, t.p3, 0.01))) matchCount++
        return matchCount < 3
    })
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

const selectAtRightClick = (e, targetModel, additive = true) => {
    let points = []
    let triangleIndex = -1

    if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt) {
            points = collectUnderlyingPoints([nt.p1, nt.p2, nt.p3])
            triangleIndex = nt.triangleIndex
        }
    } else if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            points = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
        }
    } else {
        const np = findNearestPoint(targetModel)
        if (np && np.distance <= pointHitRadiusModel() && np.point) {
            points = getPointsAtSamePosition(np.point)
        }
    }

    if (points.length === 0) {
        if (!additive) {
            state.selectedPoints = []
            state.selectedTriangles = []
            updateSelectionHud()
            updateColorButtonState()
            drawBoard()
        }
        return false
    }

    // Ctrl/Cmd + right-click adds without toggling. A plain right-click
    // replaces the selection; both are selection gestures, not grabs.
    const selectionEvent = additive
        ? { ...e, shiftKey: false, ctrlKey: true, metaKey: false }
        : { ...e, shiftKey: false, ctrlKey: false, metaKey: false }
    applySelectionModifiers(points, selectionEvent, false)
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
    if (state.editingMode !== 'edition') return false
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawTargetModel = screenToModel(mouseScreen)
    const targetModel = state.activeGrid ? snapToGrid(rawTargetModel) : rawTargetModel
    return selectAtRightClick(e, targetModel, false)
}

export const beginGrabbing = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Construction is intentionally create-only: no drag move,
    // including the global AltGr gesture.
    if (state.editingMode === 'construction') return false

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
            shape.triangles.forEach((t, tIndex) => {
                ['p1', 'p2', 'p3'].forEach((pid) => {
                    const p = t[pid]
                    if (!p) return
                    state.grabbedGroup.push({
                        shapeIndex: sIndex,
                        triangleIndex: tIndex,
                        pointId: pid,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: undefined,
                    })
                })
            })
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

    // A right drag moves the committed selection as a group, regardless of
    // the pointer position. AltGr was handled above and remains move-all.
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
    let grabPoints = []
    let preserveExisting = false
    if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt) {
            grabPoints = collectUnderlyingPoints([nt.p1, nt.p2, nt.p3])
            preserveExisting = !hasModifier && grabPoints.length > 0 && grabPoints.every(p => isPointSelected(p))
        }
    } else if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.distance <= lineHitRadiusModel() && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            grabPoints = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            preserveExisting = !hasModifier && grabPoints.length > 0 && grabPoints.every(p => isPointSelected(p))
        }
    }
    if (grabPoints.length === 0) {
        const np = findNearestPoint(targetModel)
        if (!np || np.distance > pointHitRadiusModel() || !np.point) return false
        grabPoints = getPointsAtSamePosition(np.point)
        preserveExisting = !hasModifier && isPointSelected(np.point)
    }

    state.currentAction = ACTION_GRABBING
    state.grabStartMouse = mouseScreen
    state.grabHistorySaved = false

    if (!preserveExisting) {
        // Rationale : voir DESIGN.md §3.6 (Shift remains the toggle
        // modifier for target selection before a right-hand grab).
        applySelectionModifiers(grabPoints, e, state.selectionMode === 'vertex')
        if (state.selectionMode === 'triangle') {
            applyGrabTriangleSync(grabPoints, e)
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

const buildGrabbedGroupFromSelection = () => {
    const group = []
    const tris = activeTriangles()
    state.selectedPoints.forEach(sp => {
        tris.forEach((t, i) => {
            [t.p1, t.p2, t.p3].forEach((p, j) => {
                if (p && adjacentPoints(p, sp, 0.01)) {
                    group.push({
                        shapeIndex: state.activeShapeIndex,
                        triangleIndex: i,
                        pointId: `p${j + 1}`,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: sp,
                    })
                }
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
            const activeShapeRef = state.shapes[state.activeShapeIndex]
            const allV = []
            activeShapeRef.triangles.forEach(t => {
                [t.p1, t.p2, t.p3].forEach(p => {
                    if (p && !allV.some(v => adjacentPoints(v, p, 0.01))) allV.push(p)
                })
            })
            const inBox = allV.filter(p => p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM)
            const expanded = []
            inBox.forEach(p => {
                getPointsAtSamePosition(p).forEach(q => {
                    if (!expanded.some(ev => ev === q)) expanded.push(q)
                })
            })
            state.selectedPoints = expanded
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

const applyGrabToPoint = (item, targetPos) => {
    const tri = state.shapes[item.shapeIndex].triangles[item.triangleIndex]
    if (!tri) return
    tri[item.pointId] = targetPos
    if (item.selectedPointRef) {
        item.selectedPointRef.x = targetPos.x
        item.selectedPointRef.y = targetPos.y
    }
}

// ===== Rotation runtime =====

// Rationale : voir DESIGN.md §1.2
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
        shape.triangles.forEach((t) => {
            ['p1', 'p2', 'p3'].forEach((pid) => {
                const p = t[pid]
                if (!p) return
                const dx = p.x - pivotModel.x
                const dy = p.y - pivotModel.y
                p.x = pivotModel.x + dx * cos - dy * sin
                p.y = pivotModel.y + dx * sin + dy * cos
            })
        })
    })

    state.ctx.rotationTracking = ((state.ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

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

    state.selectedPoints.forEach(sp => {
        const dx = sp.x - center.x
        const dy = sp.y - center.y
        const nx = center.x + dx * cos - dy * sin
        const ny = center.y + dx * sin + dy * cos

        let target = { x: nx, y: ny }
        if (state.activeGrid) target = snapToGrid(target)

        activeShapeRef.triangles.forEach(t => {
            [t.p1, t.p2, t.p3].forEach(p => {
                if (p && adjacentPoints(p, sp, 0.01)) {
                    p.x = target.x
                    p.y = target.y
                }
            })
        })

        sp.x = target.x
        sp.y = target.y
    })

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// ===== Coloration des triangles (mode 'triangle') =====

export const applyColorToSelectedTriangles = (color) => {
    if (!state.shapes || !state.shapes[state.activeShapeIndex]) return
    if (!state.selectedTriangles || state.selectedTriangles.length === 0) return
    const tris = state.shapes[state.activeShapeIndex].triangles
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
