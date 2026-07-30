// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import { ACTION_NONE, ACTION_GRABBING, COLOR_HOVER_NEAREST_LINE, LINE_WIDTH_HOVER_NEAREST_LINE, TRIANGLE_COLOR_PRESETS, TRIANGLE_COLOR_CLEAR, TAU } from './constants.js'
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

// `findNearestPoint` itere sur les triangles de la FORME
// active, mesure la distance euclidienne au point donne, et
// renvoie le vertex le plus proche avec son {triangle,
// triangleIndex, pointIndex, pointId, distance}. Delegue a
// `findNextNearestPoint` pour permettre la continuation
// apres un index donne (utilise par `addPoint` pour trouver
// le second point du triangle en cours si besoin).
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

// Plus proche triangle pour le mode 'triangle' de selection.
// Critere : on accepte un triangle comme hit si SOIT (a) le
// curseur est STRICTEMENT dedans (pointInsideTriangle = test
// cross-product sign), SOIT (b) il est dans un rayon
// raisonnable du centroide (CENTROID_HIT_RADIUS unites
// modele). Ce double critere adresse deux problemes
// observes :
//   - Floating-point edge case : un point EXACTEMENT sur un
//     edge peut donner des signs = 0 ambigus selon la
//     precision des coords (un des d1/d2/d3 = 0 et hasNeg
//     XOR hasPos determines; le OU inclut le cas "tout
//     zero" = true).
//   - UX "near miss" : un clic au voisinage du triangle mais
//     legerement en-dehors (a 1-2 px d'une edge en raison
//     du snap ou de la perception de l'utilisateur) doit
//     quand meme selectionner le triangle elargi. Le seuil
//     CENTROID_HIT_RADIUS = 20 (= un tiers du seuil vertex
//     15... en fait elargi pour etre permissif) garantit
//     ce confort.
// Renvoie le triangle le plus PROCHE du curseur selon une
// hierarchie de priorite :
//   1) Triangles contenant STRICTEMENT le curseur gagnent
//      TOUJOURS sur les near-miss. Sinon un triangle T_near
//      dont le centroide est a 5 unites pourrait supplanter
//      un triangle T_inside enorme dont le centroide est a
//      200 unites du curseur (le user a clique DANS T_inside,
//      il s'attend a voir T_inside, pas T_near).
//   2) Au sein d'une meme priorite (inside-inside ou
//      near-near), le centroide le plus proche gagne — utile
//      quand 2 triangles partagent un edge ou sont voisins.
// Renvoie undefined si aucun triangle ne contient le curseur
// ET aucun n'est dans le rayon de tolerance.
const CENTROID_HIT_RADIUS = 20
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
            // Le tiebreaker "centroid le plus proche" reste
            // utile : si plusieurs triangles contiennent le
            // curseur (overlapping meshes), on prend celui
            // dont le centroid est le plus pres — en pratique
            // le plus petit, donc le moins ambigu.
            if (distToCentroid < bestInsideDist) {
                bestInsideDist = distToCentroid
                bestInside = candidate
            }
        } else if (distToCentroid <= CENTROID_HIT_RADIUS) {
            if (distToCentroid < bestNearDist) {
                bestNearDist = distToCentroid
                bestNear = candidate
            }
        }
    })
    // Priorite absolue : un hit "inside" bat toujours un hit
    // "near-centroid", independamment des distances.
    return bestInside || bestNear
}

// Test d'appartenance point-in-triangle via le signe du
// cross-product 2D. Renvoie true si le point est a
// l'interieur ou exactement sur un edge (inclusif).
// Le signe du cross (b-a) x (c-a) : positif en maths
// standard (Y vers le haut), négatif sinon. Pour etre
// tolérant a l'orientation on prend le signe partage
// (tous les memes signes ou zeros).
const pointInsideTriangle = (p, a, b, c) => {
    const d1 = sign(p, a, b)
    const d2 = sign(p, b, c)
    const d3 = sign(p, c, a)
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
    return !(hasNeg && hasPos)
}

// Cross-product 2D signe : (b-a) x (p-a). Resultat :
//   > 0 si p est a GAUCHE du vecteur a->b (maths, Y+ haut)
//   < 0 si p est a DROITE
//   = 0 si p est COLINEAIRE avec a->b
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
    }
}

// ===== Hover et HUD bas-gauche =====

// Met a jour le hover (nearestPoint + nearestLine + nearestTriangle
// selon le mode + dim selection) ET appelle drawBoard (qui inclut
// les drawSelectedPoints + drawReticle + drawShape) + drawMouse
// (le curseur custom) + drawPoint pour le hint vert du point le
// plus proche + drawLine du segment hovered (mode vertex/segment)
// ou drawTriangleFilled pour le triangle hovered (mode triangle).
// textContent sur #coords (cf. updateCoordsDisplay).
export const updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    const actionModel = screenToModel(cursorScreen)
    const target = state.activeGrid ? snapToGrid(actionModel) : actionModel
    state.nearestPoint = findNearestPoint(target)

    if (state.selectedPoints.length > 0 && state.nearestPoint && state.nearestPoint.point && !isPointSelected(state.nearestPoint.point)) {
        state.isSelectionDimmed = true
    } else {
        state.isSelectionDimmed = false
    }

    // Calcule TOUS les "nearest" (point/line/triangle) en un
    // seul passage, et choisit l'affichage selon selectionMode.
    // Meme si on n'affiche pas tout, les calculs sont O(n)
    // et deja faits au prochain changement de mode.
    state.nearestLine = findSelectedLine(target)
    state.nearestTriangle = findNearestTriangle(target)

    drawBoard()
    drawMouse(cursorScreen)

    if (state.nearestPoint && state.nearestPoint.point) {
        drawPoint(state.nearestPoint.point, 5, '#00FF00')
    }
    // Hint selon mode :
    //   - vertex   : juste le point (deja affiche ci-dessus).
    //   - segment  : segment hovered rendu avec un aspect
    //                DISTINCTIF (vert + epais) pour signaler
    //                "ce trait sera l'ancre du futur triangle
    //                en cas d'ajout" — cf. addPoint, qui cree
    //                un nouveau triangle
    //                {nearestLine.firstPoint, .secondPoint,
    //                point} quand le dernier triangle est
    //                complet. Anciennement gris inactif 1px
    //                (legere visibilite), maintenant vert +
    //                3px pour ressortir nettement parmi :
    //                  - contours blancs 1px des triangles actifs
    //                  - pointilles gris 1px ([4,4]) des inactives
    //                  - axes vert fonce 1px ([2,1,3,1])
    //                Code inliné (memes raisons que le triangle
    //                hover ci-dessous : on a besoin de regler
    //                lineWidth, ce que drawLine ne supporte
    //                pas dans sa signature actuelle).
    //                lineWidth est remis a 1 apres stroke pour
    //                eviter de polluer les rendus subsequents
    //                (axes via drawAxis, reticule via
    //                drawReticle, drawShape / drawTriangle
    //                des autres formes, ...) qui ne s'attendent
    //                pas a une epaisseur non-standard.
    //   - triangle : triangle hovered en fill vert transparent +
    //                stroke vert (code inliné juste en dessous).
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
                state._ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)'
                state._ctx.fillStyle = 'rgba(0, 255, 0, 0.18)'
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

// Pilule bas-gauche : position curseur + plus proche point en
// coords model. Vide le contenu si le curseur quitte le canvas.
// textContent (pas innerText) pour eviter un reflow a chaque
// mousemove.
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
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
}

export const addPoint = (point) => {
    const tris = activeTriangles()
    // exclure un point deja occupe (tolerance : < 1)
    for (let i = 0; i < tris.length; i++) {
        const triangle = tris[i]
        if (adjacentPoints(point, triangle.p1, 1)) return
        if (triangle.p2 !== undefined) if (adjacentPoints(point, triangle.p2, 1)) return
        if (triangle.p3 !== undefined) if (adjacentPoints(point, triangle.p3, 1)) return
    }
    // Garde la branche "nouveau triangle lie a un segment" :
    // si le dernier triangle est deja complet MAIS qu'aucune
    // projection n'est tombee dans un segment au point de clic
    // (clic en espace vide, sans ligne proche), on abandonne
    // proprement au lieu de planter sur
    // `state.nearestLine.firstPoint`. Ce check est fait AVANT
    // saveState pour eviter une entree no-op dans la pile
    // d'historique (qui polluerait undo/redo).
    if (
        tris.length > 0 &&
        tris.at(-1).p2 !== undefined &&
        tris.at(-1).p3 !== undefined &&
        (!state.nearestLine || !state.nearestLine.firstPoint || !state.nearestLine.secondPoint)
    ) {
        log('addPoint: clic trop loin d\'un segment - triangle ignore')
        return
    }
    saveState()
    if (tris.length === 0) {
        tris.push({ p1: point })
    } else {
        const triangle = tris.at(-1)
        if (triangle.p2 === undefined) {
            triangle.p2 = point
        } else if (triangle.p3 === undefined) {
            triangle.p3 = point
        } else {
            tris.push({
                p1: state.nearestLine.firstPoint,
                p2: state.nearestLine.secondPoint,
                p3: point,
            })
        }
    }
    state.ctx.workIsSaved = 0
    state.ctx.workIsBackuped = 0
    persistState()
}

// Selection de tous les points de la forme active. Meme
// regle de "cluster coalesce" que resolveMouseClickOnBoard
// au mouseup : getAllVertices dedup, puis getPointsAtSamePosition
// rexpanse les clusters (un point physique == un cluster de
// triangles partageant ce sommet).
export const selectAllPoints = () => {
    const result = []
    const vertices = getAllVertices()  // from geometry.js
    vertices.forEach(p => {
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    state.selectedPoints = result
    // Mode 'triangle' : on selectionne TOUS les triangles de
    // la forme active (les indices de tous ses triangles).
    // Mode 'vertex' / 'segment' : aucun triangle "selectionne"
    // (la selection ne porte que sur des points ; les triangles
    // survoles restent grises). Ce branchement rend le bouton
    // Colorier actif automatiquement en mode triangle quand
    // tous les triangles sont impliques dans la selection
    // (clic selectAll dans ce mode).
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

// `processMouseUpSelection(e)` : traite la fin d'un click
// court (dist < 5 px dans screen) sur le board. Ciblee sur
// le BOUT du drag de selection-box : si l'utilisateur n'a
// pas drag (mousedown puis mouseup avec dist < 5), on
// dispatche selon state.selectionMode :
//
//   - 'segment'  : si le curseur tombe sur un edge (findSelectedLine
//                  hit), selectionne ses 2 extremites via la meme
//                  grille "3 modifiers" que ci-dessous (avec
//                  pointsAtPos=y a la liste des 2 extremites).
//                  Sinon retombe sur la logique vertex (point
//                  proche ou espace vide).
//   - 'triangle' : si le curseur est STRICTEMENT DANS un
//                  triangle, selectionne ses 3 sommets.
//                  Sinon retombe sur la logique vertex.
//   - 'vertex'   : comportement historique (point < 15 unites
//                  ou espace vide).
//
// Trois modifiers (orthogonaux au mode), deux cibles de base
// (point proche / espace vide) :
//
// Cible = entite du mode (point / segment / triangle)
//   - shift           : toggle la selection (selon presence
//                       des points sous-jacents dans
//                       state.selectedPoints).
//   - ctrl / meta     : ajoute les points sous-jacents SANS
//                       toggle (idempotent).
//   - rien            : remplace la selection par les points
//                       sous-jacents de l'entite.
//
// Cible = espace vide (ou entite absente selon le mode)
//   - shift           : preserve la selection, cree un
//                       nouveau point.
//   - ctrl / meta     : preserve la selection, NE CREE PAS
//                       de point (les modifiers operent sur
//                       la selection, pas sur la scene).
//   - rien            : vide la selection, cree un nouveau
//                       point.
//
// Selection videe / mutee -> mise a jour de la pilule
// selection via updateSelectionHud(). resolveMouseClickOnBoard
// appelle addPoint (qui appelle saveState + persistState).
// findNearestPoint et findSelectedLine / findNearestTriangle
// sont declares plus haut dans ce meme module, on s'y refere
// directement.

export const processMouseUpSelection = (e) => {
    if (!state.board) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const targetModel = screenToModel(mouseScreen)
    const np = findNearestPoint(targetModel)

    // Mode 'segment' et 'triangle' : essayer d'abord un hit
    // sur l'entite elargie. Si le hit reussit, on selectionne
    // les POINTS sous-jacents ; sinon on retombe sur la
    // logique vertex (point proche ou espace vide).
    if (state.selectionMode === 'segment') {
        const ns = findSelectedLine(targetModel)
        if (ns && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            // Segment degenere (2 endpoints a la meme position)
            // ignore : retombe sur la logique vertex.
            const cluster = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            applySelectionModifiers(cluster, e)
            return
        }
    } else if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt) {
            const cluster = collectUnderlyingPoints([nt.p1, nt.p2, nt.p3])
            applySelectionModifiers(cluster, e)
            // Track le(s) triangle(s) selectionne(s) en
            // PARALLELE de leur(s) sommet(s) sous-jacents.
            // On stocke l'INDEX dans le tableau de la forme
            // active (nt.triangleIndex) pour une iteration
            // directe dans applyColorToSelectedTriangles.
            // Les 3 modifiers (shift/ctrl/rien) sont appliques
            // par applyTriangleIndexModifier, miroir strict de
            // applySelectionModifiers mais sur les indices.
            applyTriangleIndexModifier(nt.triangleIndex, e)
            return
        }
    }

    // Branche vertex (ou mode segment/triangle sans hit).
    if (np && np.distance < 15) {
        const pointsAtPos = getPointsAtSamePosition(np.point)
        applySelectionModifiers(pointsAtPos, e)
    } else {
        // Clic en espace vide.
        if (e.shiftKey) {
            resolveMouseClickOnBoard(e)
        } else if (e.ctrlKey || e.metaKey) {
            // Preserve la selection, ne cree pas de point.
        } else {
            state.selectedPoints = []
            resolveMouseClickOnBoard(e)
        }
    }
}

// Helper : convertit une liste de points-bruts en une liste
// de REFS UNIQUES au meme endroit (dedup par adjacentPoints
// 0.01). Utilise par les modes segment/triangle pour
// expander la selection vers TOUTES les refs partageant la
// meme position (un point physique = un cluster de refs
// partagees entre triangles). Sans cette expansion, un
// segment ayant des refs partagees selectionnerait une seule
// ref au lieu du cluster, et les operations ulterieures
// (grab, rotate) ne verraient qu'un sommet au lieu de tous
// ceux au meme endroit.
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

// Helper prive : synchronise state.selectedTriangles avec
// une mutation de selectedPoints en mode 'triangle' pendant
// un GRAB (clic droit). Compose avec les 3 modifiers
// (shift/ctrl/rien) de la meme facon que
// applySelectionModifiers et applyTriangleIndexModifier.
// Strangely : grabPoints contient les 3 underlying points
// partages du triangle grabbe (via collectUnderlyingPoints),
// donc on doit retrouver le triangle origine parmi tous les
// triangles dont les 3 slots matchent ces refs. Si plusieurs
// triangles matchent (rare : meme triangle copie physiquement
// a 2 positions differentes), on retourne le premier match
// (deterministe). hover/grab en mode triangle sur un
// triangle partage ses 3 sommets entre plusieurs triangles
// physiquement distincts : dans ce cas, le grab concerne
// logiquement les 3 triangles (= l'utilisateur voit 1
// triangle vert, le grab deplace l'entite visible ; si elle
// est en fait multiple, ils bougent ensemble via shared
// refs).
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
        // Security fallback : si pas de triangle match
        // (grabbedPoint doit etre un sous-ensemble des 3
        // sommets d'un triangle), on vide la selection de
        // triangles. Cohrent avec le cas segment : pas de
        // triangle pleinement sur-jacent.
        state.selectedTriangles = []
        return
    }
    if (e.shiftKey) {
        // Toggle tous les triangles matchants (cf. logique
        // de shift+clic gauche sur 1 triangle -> 1 seul,
        // mais ici grab selectionne l'ENTITE visible qui
        // peut etre multiple = toggle l'union).
        let anySelected = false
        matching.forEach(i => { if (state.selectedTriangles.includes(i)) anySelected = true })
        if (anySelected) {
            state.selectedTriangles = state.selectedTriangles.filter(i => !matching.includes(i))
        } else {
            matching.forEach(i => {
                if (!state.selectedTriangles.includes(i)) state.selectedTriangles.push(i)
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

// Helper : applique les 3 modifiers (shift/ctrl/rien) a une
// liste de points-bruts candidatos, en suivant les memes
// regles que la branche vertex historique (cf. le tableau
// "3 modifiers, 2 cibles" en tete de processMouseUpSelection).
// Extrait pour eviter de dupliquer 3 fois la meme logique
// entre les 3 modes.
const applySelectionModifiers = (pointsAtPos, e) => {
    if (e.shiftKey) {
        // shift teste en premier pour preserver sa priorite
        // si l'utilisateur combine shift+ctrl.
        const anySelected = pointsAtPos.some(p => isPointSelected(p))
        if (anySelected) {
            state.selectedPoints = state.selectedPoints.filter(sp => !pointsAtPos.some(p => adjacentPoints(sp, p, 0.01)))
        } else {
            pointsAtPos.forEach(p => {
                if (!isPointSelected(p)) state.selectedPoints.push(p)
            })
        }
    } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd + click : ajoute SANS toggle.
        // Idempotent : si deja dans la selection, rien
        // n'est ajoute (filtre isPointSelected).
        pointsAtPos.forEach(p => {
            if (!isPointSelected(p)) state.selectedPoints.push(p)
        })
    } else {
        // Click sans modifier : remplace la selection.
        state.selectedPoints = [...pointsAtPos]
    }
}

// Miroir strict de applySelectionModifiers, mais opere sur
// les INDICES de triangles (state.selectedTriangles) au lieu
// des refs de points. Les 3 modifiers (shift = toggle ; ctrl/
// meta = add idempotent ; rien = replace) sont alignes sur la
// meme grille mentale que la selection de points : un user qui
// passe de la selection de points a celle de triangles via le
// meme bouton de cycle aura le meme feedback. Meme si le
// tracking de selectedTriangles est techniquement independant
// de selectedPoints (les 2 listes sont maintenues en parallele
// par les callers), les modifiers sont identiques pour
// eviter toute divergence de comportement.
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
    // Tri des indices pour stabilite visuelle (les triangles
    // sont stockes dans l'ordre de l'array de triangles de la
    // forme active ; sans tri, l'ordre d'insertion peut
    // diverger et le rendu n'est pas impacte mais le debug et
    // les snapshots undo/redo en beneficient).
    state.selectedTriangles.sort((a, b) => a - b)
    // updateSelectionHud pour reactualiser la pilule
    // selectionCount (#selectionCount). Note : cette pilule
    // reflete selectedPoints.length, PAS
    // selectedTriangles.length ; mais comme applyTriangleIndexModifier
    // est jumele avec applySelectionModifiers (memes
    // modifiers, meme cible = 3 sommets), les 2 listes
    // varient en synchronie. updateSelectionHud ici garde le
    // HUD coherent sans avoir a modifier applySelectionModifiers
    // (qui sert aussi en segment, ou la liste pourrait etre
    // 2 points mais le count est plus petit que 3 et non
    // tributaire de triangles).
    updateSelectionHud()
    updateColorButtonState()
}

// ===== Suppression d'un point =====

// ===== Suppression d'un point =====

// Rationale : voir DESIGN.md §1.1
export const deleteSelectedPoint = () => {
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
    // deleteSelectedPoint est appele aussi depuis le mode
    // 'triangle' (cf. processMouseUpSelection : un clic en
    // espace vide en mode triangle SI le clic ne tombe pas DANS
    // un triangle retombe sur la logique vertex, qui peut creer
    // un point si le cursor est proche d'un sommet ou en espace
    // vide). On invalide donc la selection de triangles par
    // precaution : au moins un triangle a change (suppression
    // possible) et les indices precedents ne sont plus valides.
    state.selectedTriangles = []
    state.nearestPoint = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un segment (mode 'segment') =====

// Rationale : voir DESIGN.md §8
export const deleteSelectedSegment = () => {
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestLine && state.nearestLine.firstPoint && state.nearestLine.secondPoint) {
        // Anti-degenerescence calquee sur processMouseUpSelection :
        // un segment a 2 endpoints a la meme position
        // (adjacentPoints < 0.01) ne represente rien de
        // geometriquement interessant ; on l'ignore et on
        // retombe sur rien (et donc sur no-op silencieux).
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
        // matchCount >= 2 : le triangle partage >= 2 sommets
        // avec la selection = il depend du segment -> a
        // supprimer. matchCount < 2 : on garde tel quel
        // (cf. commentaire d'en-tete : le slot garde son
        // ref -> le point survit naturellement).
        return matchCount < 2
    })
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un triangle (mode 'triangle') =====

// Rationale : voir DESIGN.md §7.1
export const deleteSelectedTriangle = () => {
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
        // Strict (cf. commentaire d'en-tete) : un triangle est
        // "selectionne" SSI ses 3 sommets sont dans les cibles.
        // matchCount === 3 -> on retire le triangle EN TOTALITE.
        // matchCount < 3 -> on garde tel quel (les slots ne sont
        // pas touches, ce qui preserve les points references
        // par d'autres triangles).
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

// `grabbed()` : true si une session de drag est en cours.
// Utilise par le mousedown/mouseup chain pour savoir quand
// initier et terminer le drag.
export const grabbed = () => state.currentAction === ACTION_GRABBING

// Debut d'une session de drag (clic droit).
// Detection AltGr robuste : on accepte (a) le couple DOM
// ctrlKey+altKey OU (b) getModifierState('AltGraph').
// Mode Alt : drag toutes les formes (repeuple grabbedGroup
// avec tous les points de toutes les formes).
// Mode classique : drag du point le plus proche uniquement,
// reordonne la selection selon le modifier.
export const beginGrabbing = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    state.moveAllActive = isAltGrDown
    state.grabbedGroup = []

    // AltGr : mode "deplace toute la scene". Accepte meme en
    // espace vide (pas d'ancre sur un point).
    if (isAltGrDown) {
        state.currentAction = ACTION_GRABBING
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
        // Scene vide -> rien a deplacer. Annule avant saveState
        // pour ne pas polluer l'historique undo.
        if (state.grabbedGroup.length === 0) {
            state.currentAction = undefined
            state.grabStartMouse = undefined
            return
        }
        saveState()
        log(`AltGr detecte - deplacement de ${state.shapes.length} forme(s) : ${state.grabbedGroup.length} points`)
        state.board.style.cursor = 'move'
        return
    }

    // Mode classique : ancrage sur l'entite la plus proche selon
    // state.selectionMode. Recalcul IMMEDIAT depuis la position
    // du clic (pas depuis le cache mousemove), memes raisons que
    // resolveMouseClickOnBoard qui recalcule nearestLine : la
    // cible doit refleter ce qui est sous le curseur au moment
    // du mousedown.
    //
    // - 'triangle' : grab les 3 corners du triangle sous curseur.
    //   C'est un raccourci ergonomique : clic droit sur le
    //   triangle (surligne en vert en mode triangle) = deplacer
    //   ses 3 sommets. Sans cette branche, en mode triangle le
    //   clic droit retomberait sur le sommet le plus proche, ce
    //   qui contredit la perception visuelle (l'utilisateur voit
    //   un triangle vert, il agit dessus comme une unite).
    //
    // - 'segment' : grab les 2 endpoints du segment sous curseur.
    //   Meme raccourci ergonomique applique au segment : clic
    //   droit sur un edge (surligne en gris inactif en mode
    //   segment) = deplacer ses 2 extremites. L'utilisateur
    //   voit un edge, il agit dessus comme une unite (= ses 2
    //   endpoints). findSelectedLine verifie que la projection
    //   orthogonale du curseur tombe ENTRE les 2 sommets
    //   (test isInsideSegmentByDot), sinon on retombe sur la
    //   logique vertex. Garde anti-degenerescence (< 0.01 unit)
    //   avant d'accepter le segment (= meme garde que
    //   processMouseUpSelection, assure la coherence clic
    //   gauche / clic droit).
    //
    // - 'vertex' : grab le sommet le plus proche et son cluster
    //   de shared-refs (comportement historique, inchange).
    //
    // grabPoints = REFS UNIQUES representant l'entite complete ;
    // getPointsAtSamePosition (via collectUnderlyingPoints)
    // expand chaque sommet a TOUTES les refs partageant cette
    // position, ce qui inclut les shared-refs entre triangles
    // (sans cette expansion, deplacer un sommet logique ne
    // deplacerait qu'une ref sur N, ce qui casserait la
    // coherence de la mesh).
    const targetModel = screenToModel(mouseScreen)
    let grabPoints = []
    let preserveExisting = false
    if (state.selectionMode === 'triangle') {
        const nt = findNearestTriangle(targetModel)
        if (nt) {
            grabPoints = collectUnderlyingPoints([nt.p1, nt.p2, nt.p3])
            // Garde "preserve si deja selectionne" : si les 3
            // corners sont deja dans la selection, on garde
            // selectedPoints tel quel (= grab via selection
            // existante). Sinon on l'ecrase ou on l'augmente
            // selon le modifier.
            preserveExisting = grabPoints.length > 0 && grabPoints.every(p => isPointSelected(p))
        }
    } else if (state.selectionMode === 'segment') {
        // Mode segment : comportement identique au mode triangle.
        // findSelectedLine fait une projection orthogonale sur
        // chaque edge du triangle actif et garde le plus proche
        // dont la projection tombe entre les 2 sommets
        // (test isInsideSegmentByDot). Renvoie
        // {firstPoint, secondPoint} + metadata de chaque edge.
        // Garde anti-degenerescence : si les 2 endpoints sont a
        // moins de 0.01 unite (collapse geometrique), on retombe
        // sur la logique vertex (= meme garde que
        // processMouseUpSelection pour le clic gauche en mode
        // segment, assure la coherence entre les 2 boutons).
        const ns = findSelectedLine(targetModel)
        if (ns && ns.firstPoint && ns.secondPoint && !adjacentPoints(ns.firstPoint, ns.secondPoint, 0.01)) {
            grabPoints = collectUnderlyingPoints([ns.firstPoint, ns.secondPoint])
            preserveExisting = grabPoints.length > 0 && grabPoints.every(p => isPointSelected(p))
        }
    }
    if (grabPoints.length === 0) {
        // Mode vertex/segment, OU mode triangle sans triangle
        // sous curseur : on retombe sur le sommet le plus
        // proche (comportement historique).
        const np = findNearestPoint(targetModel)
        if (!np || !np.point) return
        grabPoints = getPointsAtSamePosition(np.point)
        preserveExisting = isPointSelected(np.point)
    }

    state.currentAction = ACTION_GRABBING
    state.grabStartMouse = mouseScreen
    saveState()

    // Application des modifiers, differenciee selon le mode :
    //
    //   - 'triangle' / 'segment' : grille alignee sur
    //                  applySelectionModifiers (clic gauche
    //                  dans ces 2 modes). Meme contrat mental
    //                  entre clic gauche et clic droit = pas
    //                  d'effet de surprise :
    //                    shift       : toggle (presence d'un
    //                                  point dans selection =>
    //                                  retrait de TOUT, sinon
    //                                  ajout).
    //                    ctrl / meta : ajoute idempotent.
    //                    rien        : remplace.
    //
    //   - 'vertex' : comportement historique preserve,
    //                  equivalent fonctionnellement a l'ancien
    //                  `if (!isPointSelected(np.point))` du
    //                  code preexistant. ctrl/meta agit comme
    //                  rien (remplace, pas d'idempotent), shift
    //                  ajoute idempotent sans toggle. Pas de
    //                  regression sur le mode historique.
    //
    // Dans les 2 cas, si l'entite ciblee est deja entierement
    // selectionnee, on PRESERVE selectedPoints tel quel (= grab
    // via selection existante, sans la modifier).
    if (!preserveExisting) {
        if (state.selectionMode === 'triangle' || state.selectionMode === 'segment') {
            // triangle/segment : meme contrat que le clic gauche
            // (cf. applySelectionModifiers). Voir commentaires
            // ci-dessus pour le detail des 3 modifiers.
            //
            // En mode 'triangle', on maintient EN PARALLELE
            // state.selectedTriangles (indices des triangles
            // completement sur-jacents a grabPoints). Comme
            // grabPoints == les 3 underlying points du triangle
            // (collectUnderlyingPoints), le triangle origine
            // (celui qui contient ces 3 sommets) est celui par
            // nt.triangleIndex, mais on ne l'a pas ici : on le
            // retrouve via scan (cf. inner helper). Cela evite
            // une divergence entre selectedPoints et
            // selectedTriangles apres grab en mode triangle
            // (autrement, l'utilisateur en mode triangle qui
            // grab-shift-toggle un triangle aurait un
            // desynchronisation visible : selection de POINTS
            // changee, mais pas celle de TRIANGLES, donc le
            // bouton Colorier resterait sur l'etat anterieur).
            // En mode 'segment' (2 endpoints), aucun triangle
            // n'est completement couvert, donc on vide
            // simplement selectedTriangles (la selection de
            // triangles n'a pas de sens en mode segment).
            if (e.shiftKey) {
                const anySelected = grabPoints.some(p => isPointSelected(p))
                if (anySelected) {
                    state.selectedPoints = state.selectedPoints.filter(sp => !grabPoints.some(p => adjacentPoints(sp, p, 0.01)))
                } else {
                    grabPoints.forEach(p => {
                        if (!isPointSelected(p)) state.selectedPoints.push(p)
                    })
                }
            } else if (e.ctrlKey || e.metaKey) {
                grabPoints.forEach(p => {
                    if (!isPointSelected(p)) state.selectedPoints.push(p)
                })
            } else {
                state.selectedPoints = [...grabPoints]
            }
            if (state.selectionMode === 'triangle') {
                applyGrabTriangleSync(grabPoints, e)
            } else {
                // segment : vider (pas de triangle pleinement
                // sur-jacent a 2 endpoints).
                state.selectedTriangles = []
            }
            updateColorButtonState()
        } else {
            // vertex : retrocompat stricte.
            if (!e.shiftKey) {
                state.selectedPoints = [...grabPoints]
            } else {
                grabPoints.forEach(p => {
                    if (!isPointSelected(p)) state.selectedPoints.push(p)
                })
            }
        }
        updateSelectionHud()
    }

    const tris = activeTriangles()
    state.selectedPoints.forEach(sp => {
        tris.forEach((t, i) => {
            [t.p1, t.p2, t.p3].forEach((p, j) => {
                if (p && adjacentPoints(p, sp, 0.01)) {
                    state.grabbedGroup.push({
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
}

// Fin du grab : rend la main + persiste le dernier etat.
// Restore le curseur OS en 'none' (le canvas dessine son
// propre curseur via drawMouse). Reset du flag move-all pour
// qu'un futur grabbing classique ne herite pas d'un AltGr
// residue.
export const endGrabbing = (e) => {
    state.currentAction = ACTION_NONE
    resolveMouseMoveOnBoard(e)
    state.board.style.cursor = 'none'
    state.moveAllActive = false
    persistState()
}

// Resolution d'un mousemove sur le board.
// Trois branches mutuellement exclusives (early-return a
// l'interieur de la branche via state.* pre-mutes) :
//   1) Drag d'une selection box -> mise a jour de selectedPoints.
//   2) Pan clic-milieu (viewport).
//   3) Grab en cours (curModel delta + snap si grille).
// Dans tous les cas, on finit par redessiner + recalculer
// le hover + update le HUD selection.
export const resolveMouseMoveOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }

    if (state.isSelectingBox) {
        state.selectionBoxCurrent = mouseScreen
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
    } else if (grabbed()) {
        const curModel = screenToModel(mouseScreen)
        const startModel = screenToModel(state.grabStartMouse)
        const dx = curModel.x - startModel.x
        const dy = curModel.y - startModel.y
        // Mode move-all + grille : on snap le DELTA, pas chaque point
        // (sinon le snap independant casserait l'uniformite entre
        // formes).
        if (state.activeGrid && state.moveAllActive) {
            const snappedDelta = snapToGrid({ x: dx, y: dy })
            state.grabbedGroup.forEach(item => {
                const targetPos = {
                    x: item.startX + snappedDelta.x,
                    y: item.startY + snappedDelta.y,
                }
                applyGrabToPoint(item, targetPos)
            })
        } else {
            state.grabbedGroup.forEach(item => {
                const rawPos = { x: item.startX + dx, y: item.startY + dy }
                const targetPos = (state.activeGrid && !state.moveAllActive) ? snapToGrid(rawPos) : rawPos
                applyGrabToPoint(item, targetPos)
            })
        }
    }

    state.lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
    updateSelectionHud()
}

// Helper prive : applique une position a un point du grabbedGroup
// (mute le triangle + le selectedPointRef associe). Meme
// implementation que dans main.js, juste extraite.
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

    // Compteur HUD : somme cumulee des angles modulo 2*PI.
    // Le `(r % TAU + TAU) % TAU` gere les angles negatifs
    // (le simple `% TAU` peut renvoyer un resultat negatif).
    state.ctx.rotationTracking = ((state.ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

// Rotation des POINTS SELECTIONNES autour du curseur (sans
// AltGr). snapToGrid sur la position finale si la grille est
// activee. Mute la liste state.selectedPoints en place ; pour
// chaque sp, cherche tous les triangles de la forme active
// qui contiennent un point adjacent a sp et remplace sa
// position (maintien de la coherence des shared refs).
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

// Applique une couleur a TOUS les triangles indexes dans
// state.selectedTriangles (cf. applyTriangleIndexModifier).
// `color` peut etre :
//   - un string CSS color (provenant d'un swatch preset OU
//     de l'<input type="color"> natif). Valeur passee
//     directement a t.fill et serialisee telle quelle.
//   - la sentinelle TRIANGLE_COLOR_CLEAR='__default__' : on
//     SUPPRIME t.fill (delete t.fill) plutot que d'ecrire
//     une valeur neutre ; draw.js retombe alors sur
//     COLOR_TRIANGLE_FILL_ACTIVE sans polluer le payload
//     JSON avec des "rgba blancs" redondants.
//
// saveState en tete : toute application de couleur est
// annulable (undo restaure la scene avant). Pas de saveState
// si rien a faire (selection vide) pour eviter d'polluer
// la pile d'historique.
//
// Coherence avec deleteSelectedTriangle : on opere sur la
// FORME ACTIVE uniquement. Les indices dans
// state.selectedTriangles sont relatifs a la forme active
// (maintient cela cf. clearEditingTransientState,
// toggleSelectionMode, goToShape et resetAll : tous
// vident la liste aux transitions).
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
            // Reset : supprime la cle fill. delete plutot
            // que t.fill = undefined pour eviter que la
            // serialisation JSON ecrit "fill":null ; cf.
            // shapeToMesh qui n'inclut fill que si !== undefined.
            delete t.fill
        } else if (typeof color === 'string' && color.length > 0) {
            t.fill = color
        }
    })
    drawBoard()
    // Le hover n'a pas change (nearestTriangle n'est pas
    // impacte par un changement de fill), mais on le
    // recalcule pour conserver l'ordre de rendu (icones
    // hover dessinees apres les shapes).
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

// Construction du contenu du panneau : appelee une seule
// fois au boot depuis wireTriangleColorPanel. Cree les
// boutons swatches depuis TRIANGLE_COLOR_PRESETS (1 par
// preset, bg = preset.bg, click -> applyColorToSelectedTriangles
// avec preset.fill). Idempotent : clearSwatches avant
// rebuild pour eviter le double-build en HMR ou autre.
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
            // Marque visuel immediate du swatch choisi (utile
            // si plusieurs swatches aboutissent a des couleurs
            // proches). Reset des autres marques concurrentes.
            host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
            sw.classList.add('swatch-active')
        })
        host.appendChild(sw)
    })
}

// Wire-up complet du panneau : swatches + input custom +
// bouton Reset. Branche aussi le fermeture sur clic dehors
// (document-level mousedown : si le clic ne tombe ni sur le
// panneau, ni sur le bouton declencheur, on ferme).
// Branche aussi Escape (meme handler que les modales help/
// reset/etc., cf. main.js keydown). Le maintient de
// TRIANGLE_COLOR_PRESETS = source de verite pour la liste
// des swatches (8 par defaut), permet de changer la
// palette sans toucher au JS.
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
    // Input color natif : applique des qu'une nouvelle
    // valeur est choisie (input event). Maintient l'etat
    // 'active' sur le bon swatch si la valeur match exactement
    // un preset ; sinon retire tous les swatches actives
    // (= la couleur est custom). L'input value par defaut
    // est '#ff5555' (cf. main.html), donc ouvrir le panneau
    // donnerait du rouge si l'utilisateur ne touche a rien.
    // On prefere le premier preset (rouge) ; cf. preFill au
    // premier open : on aligne input.value sur la couleur du
    // premier triangle selectionne (s'il en a un) ou sur le
    // premier preset rouge, pour une UX coherente.
    input.addEventListener('input', () => {
        applyColorToSelectedTriangles(input.value)
        // De-sync marqueur swatch si la couleur differe de
        // tous les presets (= custom).
        const host = document.querySelector('#triangleColorSwatches')
        if (host) {
            // Toggle '.swatch-active' sur l'eventuel match de
            // input.value parmi les presets ; sans tracking
            // d'un flag 'matched' (la classe est portee par
            // l'element lui-meme, pas par une variable locale).
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
        // Reset du swatch actif + de l'input color (revenir
        // a la valeur par defaut = premier preset rouge).
        const host = document.querySelector('#triangleColorSwatches')
        if (host) host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
        input.value = TRIANGLE_COLOR_PRESETS[0].bg
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.isTriangleColorPanelOpen) return
        const target = e.target
        if (!target) return
        // Le clic sur le bouton declencheur est gere par
        // son propre handler (toggle). Le clic sur le panneau
        // ou un de ses descendants ne ferme pas. Tout autre
        // clic (canvas, toolbar autre, background) ferme.
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        hideTriangleColorPanel()
    })
}

// ===== Drop (drag/drop d'un fichier JSON) =====

// Branchement sur le canvas des handlers de drag/drop. La
// delegation est en boot depuis main.js (cf. wireBoardDrop()).
// Le drop appelle importMeshFromFile de io.js.
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
