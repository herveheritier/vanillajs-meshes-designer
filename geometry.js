// Rationale : voir DESIGN.md §3.2

import { state } from './state.js'
import { TAU } from './constants.js'

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

export const activeTriangles = () => state.shapes[state.activeShapeIndex].triangles

export const isSceneEmpty = () => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return true
    for (let i = 0; i < state.shapes.length; i++) {
        if (state.shapes[i] && Array.isArray(state.shapes[i].triangles) && state.shapes[i].triangles.length > 0) return false
    }
    return true
}

export const getAllVertices = () => {
    const vertices = []
    const tris = activeTriangles()
    tris.forEach((t) => {
        [t.p1, t.p2, t.p3].forEach((p) => {
            if (p && !vertices.some((v) => adjacentPoints(v, p, 0.01))) {
                vertices.push(p)
            }
        })
    })
    return vertices
}

export const getPointsAtSamePosition = (p, tolerance = 0.01) => {
    if (!p) return []
    const result = []
    const tris = activeTriangles()
    tris.forEach((t) => {
        [t.p1, t.p2, t.p3].forEach((q) => {
            if (q && adjacentPoints(p, q, tolerance) && !result.some((r) => r === q)) {
                result.push(q)
            }
        })
    })
    return result
}

// Index 0-based du sommet `p` dans la liste unique des vertices de
// la forme active. Utilise par updateMouseHover pour afficher un
// identifiant stable au survol (cf. §7.8). Retourne -1 si `p`
// n'appartient pas a activeTriangles() (defense ; ne devrait pas
// arriver dans le call site normal).
export const getVertexIndex = (p) => {
    const vertices = getAllVertices()
    return vertices.findIndex(v => adjacentPoints(v, p, 0.01))
}

// Liste des slots (triangleIndex, slotId) qui portent une ref
// adjacente a `p`. Utilise par §7.9 pour enumerer les doublons
// quand plusieurs refs distinctes partagent la meme position
// physique. Renvoie un tableau vide si p est null. Chaque entree
// est unique -- un meme slot ne peut pas matcher deux fois dans la
// boucle. Cas length===1 : ref unique, pas de doublon. Cas length>1 :
// cluster (meme position, refs distinctes) ou meme ref apparaissant
// dans plusieurs slots -- dans les deux cas la liste est utile.
export const getStackTriangleRefs = (p, tolerance = 0.01) => {
    const refs = []
    if (!p) return refs
    const tris = activeTriangles()
    tris.forEach((t, ti) => {
        if (!t.p1 || !t.p2 || !t.p3) return
        if (adjacentPoints(p, t.p1, tolerance)) refs.push({ triangleIndex: ti, slotId: 'p1' })
        if (adjacentPoints(p, t.p2, tolerance)) refs.push({ triangleIndex: ti, slotId: 'p2' })
        if (adjacentPoints(p, t.p3, tolerance)) refs.push({ triangleIndex: ti, slotId: 'p3' })
    })
    return refs
}

export const isPointSelected = (p) => {
    if (!p) return false
    return state.selectedPoints.some((sp) => adjacentPoints(sp, p, 0.01))
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

export { TAU }
