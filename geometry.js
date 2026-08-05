// Rationale : voir DESIGN.md §3.2

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

// (modifyShapeModel-spec §3.3) : runtime aligned sur { pointList, tris }.
// inchangé — retourne simplement le tableau de triangles (par
// indices) de la forme active.
export const activeTriangles = () => state.shapes[state.activeShapeIndex].tris

export const isSceneEmpty = () => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return true
    for (let i = 0; i < state.shapes.length; i++) {
        if (state.shapes[i] && Array.isArray(state.shapes[i].tris) && state.shapes[i].tris.length > 0) return false
    }
    return true
}

// (modifyShapeModel-spec §3.3) : avec le runtime indexe, la
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

// scan direct du pointList (plus de slots triangulaires a
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
// l'index d'un sommet est sa position directe dans le
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

// variante indexee de getPointsAtSamePosition. Utilisee par
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

// (evolution « sommets multi-points », cf. DESIGN.md §7.10) : indices
// pointList de `shape` dont la position physique est partagee avec au
// moins une AUTRE entree (tol §3.2 0.01). Ce sont les vrais candidats
// a la fusion mergeSelectedPoints (plusieurs entrees au meme sommet =
// doublons de scenes legacy/importees) — distinct de getStackTriangleRefs
// (count de SLOTS triangles, topologie dense legitime).
//
// Implementation : tri des indices par x + fenetre glissante — on
// break des que dx >= 0.01 (la tolerance exigeant les DEUX axes, toute
// paire au-dela est non-adjacente par construction). Exactement la
// meme semantique qu'adjacentPoints (strict < 0.01) : aucune paire
// adjacente echappee, aucun faux positif de bucketing arrondi. O(N log N)
// au lieu du O(N²) naif de validateShape — le marqueur est recalcule a
// chaque re-render offscreen, la fenetre ne s'etend reellement que sur
// des doublons (rares) ; le pire cas (N points de meme x) retombe sur
// O(N²), meme borne que validateShape deja accepte.
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

// Liste des slots (triangleIndex, slotId) qui portent une ref
// adjacente a `p`. Utilise par §7.9 pour enumerer les doublons
// quand plusieurs refs distinctes partagent la meme position
// physique. Renvoie un tableau vide si p est null. Chaque entree
// est unique -- un meme slot ne peut pas matcher deux fois dans la
// boucle. Cas length===1 : ref unique, pas de doublon. Cas length>1 :
// cluster (meme position, refs distinctes) ou meme ref apparaissant
// dans plusieurs slots -- dans les deux cas la liste est utile.
// on accede aux coordonnees des sommets via pointList[t.pX]
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

// Q1c : state.selectedPoints est un array d'indices dans le
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

// ===== Generation d'un cercle (eventail de triangles) =====
//
// Fabrique la geometrie canonique { pointList, tris } d'un disque
// approxime par `segments` triangles en eventail : un sommet central
// + `segments` sommets sur la circonference, chaque triangle
// referencant (centre, rim[i], rim[i+1]). Les indices sont 0-based
// dans le pointList retourne — l'appelant (editor.js createCircle)
// les decale du nombre de points deja presents dans la forme active.
//
// `offsetAngle` (defaut 0) : rotation en radians appliquee a
// chaque sommet i, permettant de decaler l'angle de depart du
// polygone (utilise par le geste « orientation par souris », cf.
// cahier des charges des evolutions : le sommet 0 du polygone
// pointe vers la position de la souris quand le geste valide).
// Sens de rotation : CCW (math) en coords model ; le rendu
// (modelToScreen avec Y inverse)projette le sommet 0 vers la
// direction de la souris sur l'ecran si l'appelant calcule
// l'angle en sens ecran (cf. editor.js updateCircleGesture).
//
// Fonction pure (aucun acces a state) : testable de maniere
// isolee. `segments` est arrondi et borne a >= 3 (le defaut 24 rend
// un disque visuellement lisse ; 3 donnerait un triangle).
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
//
// Fabrique la geometrie canonique d'un triangle equilateral : les 3
// sommets sur le cercle circonscrit (MEME formule que les sommets de
// circleGeometry avec n=3) mais UN SEUL triangle — pas d'eventail
// depuis un centre (le point central n'existe pas dans la forme
// generee, cf. cahier des charges des evolutions « la forme triangle
// doit être composée d'un seul triangle au lieu de trois »).
//
// `offsetAngle` (defaut 0, radians) : rotation appliquee a chaque
// sommet, meme convention que circleGeometry — le geste en 2 clics
// passe l'angle du curseur (updateShapeGesture) pour que le sommet 0
// pointe vers la souris. Fonction pure (aucun acces a state).
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
//
// Fabrique la geometrie canonique d'un anneau : 2×segments sommets
// (les `segments` sommets du cercle EXTERIEUR aux indices 0..N-1,
// puis les `segments` sommets du cercle INTERIEUR — le trou — aux
// indices N..2N-1, chaque sommet interieur i partageant l'angle du
// sommet exterieur i) + 2×segments triangles reliant les deux
// couronnes (chaque « quad » (exterieur_i, exterieur_{i+1},
// interieur_{i+1}, interieur_i) est decoupe en 2 triangles). Le
// centre est volontairement VIDE : le trou n'est pas une zone
// re-remplie, c'est l'absence de triangles (cf. cahier des charges
// des evolutions « création d'un cercle percé d'un trou »).
//
// Winding : les deux triangles d'un quad ont le meme signe de
// cross-product en coords model (verifie : cross(T1) = r·sin(θ)·
// (r - ri) > 0, cross(T2) = (r - ri)·ri·sin(θ) > 0), donc le fill
// batched de draw.js (SAFE-BELT sur l'uniformite des windings en
// screen-space) reste sur le chemin rapide.
//
// `offsetAngle` (defaut 0, radians) : rotation appliquee a chaque
// sommet, meme convention que circleGeometry — le geste en 3 clics
// passe l'angle du curseur (updateAnnulusGesture) pour que le
// sommet exterieur 0 pointe vers la souris. Fonction pure (aucun
// acces a state).
export const annulusGeometry = (center, outerRadius, innerRadius, segments, offsetAngle = 0) => {
    const n = Math.max(3, Math.round(segments) || CIRCLE_DEFAULT_SEGMENTS)
    // Clamp du rayon du trou a la generation (meme pattern defensif que
    // starGeometry sur rInner) : le rayon interne reste dans
    // [MIN x externe, MAX x externe] — jamais zero (pas de trou) ni
    // superieur ou egal au rayon externe (anneau degenere).
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
        // Quad (exterieur_i, exterieur_j, interieur_j, interieur_i)
        // decoupe en 2 triangles (winding uniforme, cf. commentaire
        // ci-dessus).
        tris.push({ p1: i, p2: j, p3: n + i })
        tris.push({ p1: j, p2: n + j, p3: n + i })
    }
    return { pointList, tris }
}

// ===== Rectangle (2 coins) =====
//
// Fabrique la geometrie canonique d'un rectangle axis-aligned a partir
// de deux coins opposes (ordre quelconque). 4 points (coins, ordre
// horaire depuis le coin haut-gauche) + 2 triangles le long de la
// diagonale p0-p2. Fonction pure (aucun acces a state).
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
//
// Fabrique la geometrie canonique d'une etoile a `points` branches :
// 1 sommet central + 2×points sommets alternant exterieur (rayon
// externe) et interieur (rayon interne = innerRatio × rayon externe),
// puis 2×points triangles en eventail (centre, exterieur_i, interieur_i)
// et (centre, interieur_i, exterieur_{i+1}). Le premier pic pointe
// vers le haut (decalage -PI/2, convention Y inverse de l'app : un
// model.y plus grand rend en haut).
//
// `offsetAngle` (defaut 0, radians) : rotation appliquee a chaque
// sommet, decalee par-dessus le -PI/2 canonique. Le mode etoile
// (3 clics, meme logique que le cercle) passe l'angle du curseur
// + PI/2 (cf. editor.js updateStarGesture) pour que le 1er pic
// (sommet exterieur 0) pointe vers la souris : le geste d'orientation
// par souris devient identique au cercle, le -PI/2 historique restant
// le comportement par defaut des anciens appels (createShape drag).
// Fonction pure (aucun acces a state).
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
