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

// Phase 1 (modifyShapeModel-spec §3.3) : runtime aligned sur { pointList, tris }.
// Phase 2 : inchangé — retourne simplement le tableau de triangles (par
// indices) de la forme active.
export const activeTriangles = () => state.shapes[state.activeShapeIndex].tris

export const isSceneEmpty = () => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return true
    for (let i = 0; i < state.shapes.length; i++) {
        if (state.shapes[i] && Array.isArray(state.shapes[i].tris) && state.shapes[i].tris.length > 0) return false
    }
    return true
}

// Phase 2 (modifyShapeModel-spec §3.3) : avec le runtime indexe, la
// liste canonique des sommets logiques d'une forme est son pointList
// (invariant I3 par merge compact : pas de doublons adjacents).
// getAllVertices renvoie la copie pour ne pas exposer la table mutable.
import { state as _stateForShape } from './state.js'
const _activeShape = () => _stateForShape.shapes[_stateForShape.activeShapeIndex]
export const getAllVertices = () => {
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return []
    return s.pointList.slice()
}

// Phase 2 : scan direct du pointList (plus de slots triangulaires a
// derefencer). At most un cluster de doublons adjacents — l'invariant
// I3 limite la liste a 1 entree par coord unique. Retourne des refs
// (callers editor.js les convertissent en indices via getIndicesAtSamePosition).
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

// Index 0-based du sommet `p` dans la liste unique des vertices de
// la forme active. Utilise par updateMouseHover pour afficher un
// identifiant stable au survol (cf. §7.8). Retourne -1 si `p`
// n'appartient pas a activeTriangles() (defense ; ne devrait pas
// arriver dans le call site normal).
// Phase 2 : l'index d'un sommet est sa position directe dans le
// pointList canonique. Plus d'iteration via getAllVertices().
export const getVertexIndex = (p) => {
    if (!p) return -1
    const s = _activeShape()
    if (!s || !Array.isArray(s.pointList)) return -1
    for (let i = 0; i < s.pointList.length; i++) {
        if (s.pointList[i] && adjacentPoints(p, s.pointList[i], 0.01)) return i
    }
    return -1
}

// Phase 2 : variante indexee de getPointsAtSamePosition. Utilisee par
// editor.js (selection, drag) qui manipule state.selectedPoints comme
// liste d'indices (Q1c). Renvoie un tableau vide si p est null.
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

// Liste des slots (triangleIndex, slotId) qui portent une ref
// adjacente a `p`. Utilise par §7.9 pour enumerer les doublons
// quand plusieurs refs distinctes partagent la meme position
// physique. Renvoie un tableau vide si p est null. Chaque entree
// est unique -- un meme slot ne peut pas matcher deux fois dans la
// boucle. Cas length===1 : ref unique, pas de doublon. Cas length>1 :
// cluster (meme position, refs distinctes) ou meme ref apparaissant
// dans plusieurs slots -- dans les deux cas la liste est utile.
// Phase 2 : on accede aux coordonnees des sommets via pointList[t.pX]
// pour chaque slot. Tris partiellement definis (pX===undefined) sont
// filtres comme avant.
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

// Phase 2, Q1c : state.selectedPoints est un array d'indices dans le
// pointList de l'active shape. La comparaison se fait via la ref du
// point en pointList[idx] ; pas de comparaison directe indice-vs-coord.
// La gate Number.isInteger est coherente avec le reste du codebase
// (compactPointList, deleteSelected*, findMergeConflicts) — robuste
// contre une entree corrompue (string, NaN, null).
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

export { TAU }
