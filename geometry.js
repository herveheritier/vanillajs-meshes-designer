import { state } from './state.js'
import {
    TAU, CIRCLE_DEFAULT_SEGMENTS,
    SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO, STAR_INNER_RATIO_MIN, STAR_INNER_RATIO_MAX,
    ANNULUS_INNER_RATIO_MIN, ANNULUS_INNER_RATIO_MAX,
} from './constants.js'

// ===== Snap =====
export const snapToGrid = (point) => {
    if (!state.activeGrid || !point) return point
    return {
        x: Math.round(point.x / state.GRID_STEP) * state.GRID_STEP,
        y: Math.round(point.y / state.GRID_STEP) * state.GRID_STEP,
    }
}

// ===== Model <-> Screen =====
export const modelToScreen = (model) => {
    if (!model) return undefined
    const { center, viewCenter, zoomLevel } = state.ctx
    return {
        x: center.x + (model.x - viewCenter.x) * zoomLevel,
        y: center.y - (model.y - viewCenter.y) * zoomLevel,
    }
}

export const screenToModel = (screen) => {
    if (!screen) return undefined
    const { center, viewCenter, zoomLevel } = state.ctx
    return {
        x: (screen.x - center.x) / zoomLevel + viewCenter.x,
        y: viewCenter.y - (screen.y - center.y) / zoomLevel,
    }
}

// ===== Topologie / selection =====

// Triangles (par indices) de la forme active.
export const activeTriangles = () => state.shapes[state.activeShapeIndex].tris

export const isSceneEmpty = () => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return true
    for (let i = 0; i < state.shapes.length; i++) {
        if (state.shapes[i] && Array.isArray(state.shapes[i].tris) && state.shapes[i].tris.length > 0) return false
    }
    return true
}

// Copie du pointList (liste canonique des sommets) sans exposer la table mutable.
import { state as _stateForShape } from './state.js'
const _activeShape = () => _stateForShape.shapes[_stateForShape.activeShapeIndex]
export const getAllVertices = () => {
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return []
    return s.pointList.slice()
}

// Refs des points du pointList adjacents a `p` (les callers editor.js
// les convertissent en indices via getIndicesAtSamePosition).
export const getPointsAtSamePosition = (p, tolerance = 0.01) => {
    if (!p) return []
    const result = []
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return result
    const pointList = s.pointList
    for (let i = 0; i < pointList.length; i++) {
        if (pointList[i] && adjacentPoints(p, pointList[i], tolerance)) result.push(pointList[i])
    }
    return result
}

// Index 0-based du sommet `p` dans le pointList canonique (survol §7.8) ; -1 si absent.
export const getVertexIndex = (p) => {
    if (!p) return -1
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return -1
    for (let i = 0; i < s.pointList.length; i++) {
        if (s.pointList[i] && adjacentPoints(p, s.pointList[i], 0.01)) return i
    }
    return -1
}

// Variante indexee de getPointsAtSamePosition (pour selectedPoints en indices).
export const getIndicesAtSamePosition = (p, tolerance = 0.01) => {
    const result = []
    if (!p) return result
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return result
    const pointList = s.pointList
    for (let i = 0; i < pointList.length; i++) {
        if (pointList[i] && adjacentPoints(p, pointList[i], tolerance)) result.push(i)
    }
    return result
}

// Indices pointList dont la position est partagee avec une AUTRE entree
// (cf. DESIGN.md §7.10) : candidats a la fusion #mergePoints. Tri par x
// + fenetre glissante (break des dx >= 0.01) : O(N log N), meme
// semantique qu'adjacentPoints (strict < 0.01).
export const getMultiPointIndices = (shape) => {
    const multi = new Set()
    if (!shape || !Array.isArray(shape.pointList)) return multi
    const pointList = shape.pointList
    const ordered = []
    for (let i = 0; i < pointList.length; i++) {
        const p = pointList[i]
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
        ordered.push({ idx: i, p })
    }
    ordered.sort((a, b) => a.p.x - b.p.x)
    for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i]
        for (let j = i + 1; j < ordered.length; j++) {
            const b = ordered[j]
            if (b.p.x - a.p.x >= 0.01) break
            if (adjacentPoints(a.p, b.p, 0.01)) {
                multi.add(a.idx)
                multi.add(b.idx)
            }
        }
    }
    return multi
}

// Slots (triangleIndex, slotId) portant une ref adjacente a `p`
// (cf. §7.9). Entrees uniques ; length>1 = doublon/cluster.
export const getStackTriangleRefs = (p, tolerance = 0.01) => {
    const refs = []
    if (!p) return refs
    const tris = activeTriangles()
    const s = _activeShape()
    const pointList = (s && Array.isArray(s.pointList)) ? s.pointList : []
    tris.forEach((t, ti) => {
        if (!Array.isArray(t)) return
        if (t.p1 !== undefined && pointList[t.p1] && adjacentPoints(p, pointList[t.p1], tolerance)) refs.push({ triangleIndex: ti, slotId: 'p1' })
        if (t.p2 !== undefined && pointList[t.p2] && adjacentPoints(p, pointList[t.p2], tolerance)) refs.push({ triangleIndex: ti, slotId: 'p2' })
        if (t.p3 !== undefined && pointList[t.p3] && adjacentPoints(p, pointList[t.p3], tolerance)) refs.push({ triangleIndex: ti, slotId: 'p3' })
    })
    return refs
}

// selectedPoints = indices pointList ; comparaison via pointList[idx],
// gate Number.isInteger contre les entrees corrompues (string, NaN, null).
export const isPointSelected = (p) => {
    if (!p) return false
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return false
    const pointList = s.pointList
    for (let i = 0; i < state.selectedPoints.length; i++) {
        const idx = state.selectedPoints[i]
        if (!Number.isInteger(idx)) continue
        const pt = pointList[idx]
        if (pt && adjacentPoints(p, pt, 0.01)) return true
    }
    return false
}

export const adjacentPoints = (a, b, tolerance = 0.01) => {
    if (!a || !b) return false
    return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance
}

// ===== Projection / produit scalaire =====

export const computeOrthogonalProjection = (p, p1, p2) => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const denominator = dx * dx + dy * dy
    if (denominator === 0) return { x: p1.x, y: p1.y }
    const t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / denominator
    return {
        x: p1.x + t * dx,
        y: p1.y + t * dy,
    }
}

export const scalarProduct = (ax, ay, bx, by) => ax * bx + ay * by

export const isInsideSegmentByDot = (dot, p1, p2) => {
    return dot.x >= Math.min(p1.x, p2.x) - 0.01 &&
        dot.x <= Math.max(p1.x, p2.x) + 0.01 &&
        dot.y >= Math.min(p1.y, p2.y) - 0.01 &&
        dot.y <= Math.max(p1.y, p2.y) + 0.01
}

// ===== Generation d'un cercle (eventail de triangles) =====
// Disque approxime par `segments` triangles en eventail : centre +
// sommets sur la circonference, indices 0-based (l'appelant les decale
// des points deja presents). `offsetAngle` decale le sommet 0
// (orientation par souris). Fonction pure ; `segments` arrondi et >= 3.
export const circleGeometry = (center, radius, segments, offsetAngle = 0) => {
    const n = Math.max(3, Math.round(segments) || CIRCLE_DEFAULT_SEGMENTS)
    const pointList = [{ x: center.x, y: center.y }]
    const tris = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offsetAngle
        pointList.push({
            x: center.x + radius * Math.cos(a),
            y: center.y + radius * Math.sin(a),
        })
        tris.push({ p1: 0, p2: i + 1, p3: ((i + 1) % n) + 1 })
    }
    return { pointList, tris }
}

// ===== Triangle (3 sommets, un seul triangle) =====
// Triangle equilateral sur le cercle circonscrit (meme formule que le
// cercle n=3) mais UN SEUL triangle, sans centre. `offsetAngle`
// oriente le sommet 0 vers la souris. Fonction pure.
export const triangleGeometry = (center, radius, offsetAngle = 0) => {
    const n = 3
    const pointList = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offsetAngle
        pointList.push({
            x: center.x + radius * Math.cos(a),
            y: center.y + radius * Math.sin(a),
        })
    }
    return {
        pointList,
        tris: [{ p1: 0, p2: 1, p3: 2 }],
    }
}

// ===== Anneau (cercle perçé d'un trou) =====
// 2×N sommets (cercle exterieur indices 0..N-1, cercle interieur — le
// trou — indices N..2N-1, meme angle par i) + 2×N triangles decoupant
// chaque quad (exterieur_i, exterieur_j, interieur_j, interieur_i).
// Centre volontairement VIDE (le trou = absence de triangles). Winding
// uniforme par quad -> fill batched de draw.js reste sur le chemin
// rapide. `offsetAngle` oriente le sommet 0. Fonction pure.
export const annulusGeometry = (center, outerRadius, innerRadius, segments, offsetAngle = 0) => {
    const n = Math.max(3, Math.round(segments) || CIRCLE_DEFAULT_SEGMENTS)
    // Clamp du rayon du trou : jamais zero ni >= au rayon externe (anneau degenere).
    const rInner = Math.max(ANNULUS_INNER_RATIO_MIN, Math.min(ANNULUS_INNER_RATIO_MAX, outerRadius > 0 ? innerRadius / outerRadius : 0)) * outerRadius
    const pointList = []
    const tris = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offsetAngle
        pointList.push({
            x: center.x + outerRadius * Math.cos(a),
            y: center.y + outerRadius * Math.sin(a),
        })
    }
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offsetAngle
        pointList.push({
            x: center.x + rInner * Math.cos(a),
            y: center.y + rInner * Math.sin(a),
        })
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        tris.push({ p1: i, p2: j, p3: n + i })
        tris.push({ p1: j, p2: n + j, p3: n + i })
    }
    return { pointList, tris }
}

// ===== Rectangle (2 coins) =====
// Rectangle axis-aligned depuis 2 coins opposes : 4 points (ordre
// horaire) + 2 triangles le long de la diagonale p0-p2. Fonction pure.
export const rectGeometry = (corner1, corner2) => {
    const x1 = Math.min(corner1.x, corner2.x)
    const y1 = Math.min(corner1.y, corner2.y)
    const x2 = Math.max(corner1.x, corner2.x)
    const y2 = Math.max(corner1.y, corner2.y)
    return {
        pointList: [
            { x: x1, y: y1 },
            { x: x2, y: y1 },
            { x: x2, y: y2 },
            { x: x1, y: y2 },
        ],
        tris: [
            { p1: 0, p2: 1, p3: 2 },
            { p1: 0, p2: 2, p3: 3 },
        ],
    }
}

// ===== Etoile (eventail depuis le centre) =====
// 1 centre + 2×N sommets alternant exterieur/interieur + 2×N triangles
// en eventail. 1er pic vers le haut (-PI/2 canonique, convention Y
// inverse) ; `offsetAngle` decale par-dessus (mode etoile : angle
// curseur + PI/2 pour pointer le 1er pic vers la souris). Fonction pure.
export const starGeometry = (center, radius, points = SHAPE_STAR_POINTS, innerRatio = SHAPE_STAR_INNER_RATIO, offsetAngle = 0) => {
    const n = Math.max(3, Math.round(points) || SHAPE_STAR_POINTS)
    const rInner = Math.max(STAR_INNER_RATIO_MIN, Math.min(STAR_INNER_RATIO_MAX, innerRatio)) * radius
    const pointList = [{ x: center.x, y: center.y }]
    const tris = []
    for (let i = 0; i < n; i++) {
        const aOuter = (i / n) * TAU - Math.PI / 2 + offsetAngle
        const aInner = ((i + 0.5) / n) * TAU - Math.PI / 2 + offsetAngle
        pointList.push({ x: center.x + radius * Math.cos(aOuter), y: center.y + radius * Math.sin(aOuter) })
        pointList.push({ x: center.x + rInner * Math.cos(aInner), y: center.y + rInner * Math.sin(aInner) })
    }
    for (let i = 0; i < n; i++) {
        const outer = 1 + 2 * i
        const inner = 1 + 2 * i + 1
        const nextOuter = 1 + (2 * (i + 1)) % (2 * n)
        tris.push({ p1: 0, p2: outer, p3: inner })
        tris.push({ p1: 0, p2: inner, p3: nextOuter })
    }
    return { pointList, tris }
}

export { TAU }
