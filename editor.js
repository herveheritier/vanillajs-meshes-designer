// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    ACTION_NONE, ACTION_GRABBING,
    COLOR_HOVER_NEAREST_LINE, LINE_WIDTH_HOVER_NEAREST_LINE,
    COLOR_HOVER_NEAREST_POINT,
    COLOR_HOVER_NEAREST_TRIANGLE_STROKE, COLOR_HOVER_NEAREST_TRIANGLE_FILL,
    TRIANGLE_COLOR_PRESETS, TRIANGLE_COLOR_CLEAR, TAU,
    POINT_HIT_RADIUS_PX, LINE_HIT_RADIUS_PX, TRIANGLE_CENTROID_HIT_RADIUS_PX,
    CIRCLE_MIN_RADIUS_PX,
    SHAPE_DEFS, SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO,
} from './constants.js'
import { drawBoard, drawPoint, drawMouse, drawVertexLabel, drawStackList, requestDraw, isSceneDirty } from './draw.js'
import { updateSelectionHud, updateColorButtonState, updateShapesButton } from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import { modelToScreen } from './geometry.js'
import {
    screenToModel, snapToGrid,
    activeTriangles, getAllVertices, getPointsAtSamePosition, getVertexIndex, getStackTriangleRefs, isPointSelected,
    getIndicesAtSamePosition,
    adjacentPoints, computeOrthogonalProjection, isInsideSegmentByDot,
    circleGeometry, rectGeometry, starGeometry,
} from './geometry.js'
import { saveState, movePointsPatch, insertPointPatch, replaceShapePatch, setFillsPatch, cloneShape } from './history.js'
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

// (feature/performance) clef de dedup pour updateMouseHover :
// combine la position du curseur (arrondie a l'unite pour ignorer le
// sub-pixel jitter) + les indices de nearest point/line/triangle (qui
// changent a chaque franchissement de hit-radius) + l'indicateur
// selection-dimmed + l'etat lasso (car le rectangle de selection est
// peint dans le calque transitoire, pas dans les overlays d'update-
// MouseHover). Tant que la clef est inchangee entre deux appels ET que
// le cache scene n'est pas dirty, aucun redraw n'est necessaire (la
// scene cachee du frame precedent contient deja le bon contenu).
// isSceneDirty() est inclus dans la garde pour absorber les cas ou la
// scene est mutee SANS avoir explicitement appele requestDraw (drag
// raw qui mute pointList a la volee) — la garde seule sur la clef ne
// suffirait pas.
let lastHoverSignature = null
const computeHoverSignature = (cursorScreen) => {
    const npKey = state.nearestPoint ? state.nearestPoint.pointIndex : '_'
    const nlKey = state.nearestLine ? state.nearestLine.triangleIndex + ':' + state.nearestLine.lineIndex : '_'
    const ntKey = state.nearestTriangle ? state.nearestTriangle.triangleIndex : '_'
    const cKey = cursorScreen ? (Math.round(cursorScreen.x) + ',' + Math.round(cursorScreen.y)) : '_'
    const boxKey = state.isSelectingBox && state.selectionBoxStart && state.selectionBoxCurrent
        ? '1|' + Math.round(state.selectionBoxCurrent.x) + ',' + Math.round(state.selectionBoxCurrent.y)
        : '0'
    return cKey + '|' + npKey + '|' + nlKey + '|' + ntKey + '|' + (state.isSelectionDimmed ? 'd' : 'n') + '|' + boxKey
}

export const updateMouseHover = (cursorScreen) => {
    // Preview (mode visualisation seule) : aucun overlay de survol
    // (cercle vert du point le plus proche, labels §7.8/§7.9, ligne /
    // triangle highlights) — ils sont des aides d'edition, pas de la
    // geometrie. Le rendu canvas est deja propre cote draw.js ; on
    // retourne avant tout calcul de hover (et avant le drawBoard).
    // Rationale : voir DESIGN.md §2.6
    if (state.previewMode) return
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    // Mode cercle : les overlays de survol (cercle vert du point le
    // plus proche, labels §7.8/§7.9, ligne/triangle highlights) ne
    // sont que du bruit pendant la construction d'un cercle. On se
    // limite au HUD coordonnees + au repaint : la previsualisation
    // du cercle est dessinee dans le calque transitoire (draw.js
    // renderTransient), drawMouse repeint le curseur.
    // Mode cercle OU forme predéfinie armee : meme traitement — les
    // overlays de survol (point le plus proche, labels, highlights)
    // sont du bruit pendant la construction ; seule la preview
    // (renderTransient) + le curseur sont dessines.
    if (state.circleMode || state.shapeKind !== undefined) {
        drawBoard()
        drawMouse(cursorScreen)
        return
    }
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

    // (feature/performance) skip frame integral si la signature
    // visuelle est inchangee ET que la scene cachee est encore
    // valide. Le 2e terme absorbe les paths de mutation raw (drag qui
    // mute pointList sans passer par un requestDraw explicite) — sans
    // lui, on pourrait avoir un drag qui ne se reflete jamais a
    // l'ecran si hover signature ne change pas. updateCoordsDisplay a
    // deja ete execute (= le HUD bas-gauche reflete bien le curseur
    // courant, on n'est pas en train de mentir a l'utilisateur).
    const signature = computeHoverSignature(cursorScreen)
    if (signature === lastHoverSignature && !isSceneDirty()) return
    lastHoverSignature = signature

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
    requestDraw()
    drawMouse(mouseScreen)
}

// (modifyShapeModel-spec §3.6) : dedup tolerance 1 px scanne
// directement le pointList canonique (invariant I3 garantit <= 1
// entree par coord unique, donc le test ne fait pas de tour
// triangulaire). On push le nouveau point dans pointList et on
// assigne son INDEX dans le slot du triangle. Maintient l'invariant
// I5 (p1/p2/p3 toujours definis pour le tri en cours).
//
// (delta) l'entry d'historique utilise le patch `insertPoint` (DESIGN
// §8) : ne stocke que la coord insérée + le tri concerné (before +
// after) au lieu de cloner toute la scène. Le cas-path est codé en
// 4 actions atomiques (push | modify-p2 | modify-p3 | push-new-tri)
// — chaque branche construit lastTriAfter au saveState time (avant
// la mutation) à partir de la connaissance complète des entrées
// (coord pushée, indices nearestLine, état pré-mutation).
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

    // (delta) construction du patch AVANT la mutation (toutes les
    // entrées sont connues : coord pushée, indices nearestLine, état
    // pré-mutation du shape). On capture aussi le lastTri pré-mut
    // pour permettre le rollback undo.
    // NOTE invariant §5.3 (insertPointPatch conv) :
    //   - lastTriIndexBefore = -1 si shape vide avant, sinon index.
    //   - triDelta = 1 si on pousse un nouveau tri (cas 'push' empty
    //     OU 'push-new-tri'), 0 si on modifie en place.
    // Le pré-fix (lastTriIndexAfter < 0 = "push") était ambigu car 0
    // est un index valide post-mutation pour le tri #0 ; on a donc
    // externalisé le signal via triDelta.
    const insertedPoint = { x: point.x, y: point.y }
    const newPointIdx = pointList.length  // index après le push
    const lastTriIndexBefore = tris.length - 1  // -1 si vide
    const lastTriBefore = lastTriIndexBefore >= 0
        ? { p1: lastTriangle.p1, p2: lastTriangle.p2, p3: lastTriangle.p3, fill: lastTriangle.fill }
        : null

    let lastTriIndexAfter, lastTriAfter, action, triDelta
    if (tris.length === 0) {
        action = 'push'
        triDelta = 1
        // lastTriIndexAfter inutilisé quand triDelta = 1.
        lastTriAfter = { p1: newPointIdx, p2: undefined, p3: undefined }
    } else if (lastTriangle.p2 === undefined) {
        action = 'modify-p2'
        triDelta = 0
        lastTriIndexAfter = lastTriIndexBefore
        lastTriAfter = { p1: lastTriangle.p1, p2: newPointIdx, p3: lastTriangle.p3, fill: lastTriangle.fill }
    } else if (lastTriangle.p3 === undefined && isActivePartial && !nearestLine) {
        action = 'modify-p3'
        triDelta = 0
        lastTriIndexAfter = lastTriIndexBefore
        lastTriAfter = { p1: lastTriangle.p1, p2: lastTriangle.p2, p3: newPointIdx, fill: lastTriangle.fill }
    } else if (nearestLine) {
        action = 'push-new-tri'
        triDelta = 1
        // lastTriIndexAfter inutilisé quand triDelta = 1.
        lastTriAfter = {
            p1: nearestLine.firstPointIndex,
            p2: nearestLine.secondPointIndex,
            p3: newPointIdx,
        }
    } else {
        // Garde défensive, devrait être inatteignable après les checks
        // précédents.
        log('addPoint: cas non couvert')
        return
    }

    saveState({
        patches: [insertPointPatch(
            state.activeShapeIndex,
            lastTriIndexBefore, lastTriBefore,
            lastTriIndexAfter, lastTriAfter,
            insertedPoint,
            triDelta,
        )],
    })

    // Mutation réelle, le case est déjà résolu ci-dessus.
    pointList.push(insertedPoint)
    if (action === 'push') {
        const partial = { p1: pointList.length - 1 }
        tris.push(partial)
        state.activeConstructionTriangle = partial
    } else if (action === 'modify-p2') {
        lastTriangle.p2 = pointList.length - 1
        state.activeConstructionTriangle = lastTriangle
    } else if (action === 'modify-p3') {
        lastTriangle.p3 = pointList.length - 1
        state.activeConstructionTriangle = undefined
    } else { // 'push-new-tri'
        tris.push({
            p1: nearestLine.firstPointIndex,
            p2: nearestLine.secondPointIndex,
            p3: pointList.length - 1,
        })
        state.activeConstructionTriangle = undefined
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
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
}

// ===== Creation d'un cercle (outil cercle) =====
//
// Mode transitoire (choisi dans le panneau #shapes ou via le raccourci
// C, non persiste — meme statut que la preview) : geste en 2 temps
// (orientation par souris, cf. cahier des charges des evolutions) :
//   1. 1er mousedown sur le canvas = pose le centre du cercle
//      (snapToGrid comme addPoint), initialise le rayon a 0 et
//      l'angle a 0 (seront mis a jour au 1er mousemove).
//   2. mouvement de la souris (avec ou sans bouton enfonce) = regle
//      en continu le rayon (distance curseur - centre en coords
//      model) ET l'angle de depart du polygone (atan2 du vecteur
//      curseur - centre en coords screen, pour rester intuitif : le
//      sommet 0 du futur polygone pointera vers la souris).
//      L'utilisateur peut relacher la souris entre les 2 clics — le
//      mode reste arme, l'angle se fige sur la derniere valeur
//      observee.
//   3. 2e mousedown sur le canvas = valide le cercle (genere
//      l'eventail de triangles avec l'angle courant, desarme le
//      mode). Si le rayon est trop petit (< CIRCLE_MIN_RADIUS_PX
//      en pixels ecran), le 2e clic est ignore sans creer de
//      cercle et le mode cercle est quitte.
//
// La molette regle N (viewport.js onBoardWheel ou bouton #shapes
// actif), Echap quitte le mode (sans creer, comme si clic droit),
// clic droit / Backspace annulent le trace en cours (reinitialise
// centre + rayon + angle, sans desarmer le mode).
export const toggleCircleMode = () => {
    if (state.circleMode) exitCircleMode()
    else enterCircleMode()
}

const enterCircleMode = () => {
    // Exclusion mutuelle avec l'outil forme predéfinie : un seul geste
    // de creation actif a la fois.
    if (state.shapeKind !== undefined) disarmShapeTool()
    // Ferme le panneau #shapes s'il est ouvert (meme comportement
    // qu'armShapeTool) : entrer en mode cercle depuis le panneau ouvert
    // (raccourci C) ne laisse pas un mode actif sous le panneau — un
    // seul Echap suffit alors a tout annuler.
    state.shapesPanelOpen = false
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.circleMode = true
    state.circleOffsetAngle = 0
    state.currentAction = ACTION_NONE
    updateShapesButton()
    log('Mode cercle : 1er clic pose le centre, la souris regle rayon + angle de depart, 2e clic valide (molette = cotes, Echap = quitter)')
    requestDraw()
}

export const exitCircleMode = () => {
    if (!state.circleMode) return
    state.circleMode = false
    state.circleCenterModel = undefined
    state.circleRadiusModel = 0
    state.circleOffsetAngle = 0
    updateShapesButton()
    log('Mode cercle desactive')
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

export const beginCircleGesture = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawCenter = screenToModel(mouseScreen)
    const center = state.activeGrid ? snapToGrid(rawCenter) : rawCenter
    state.circleCenterModel = { x: center.x, y: center.y }
    state.circleRadiusModel = 0
    // L'angle de depart est pose a 0 par defaut ; le 1er mousemove
    // qui suit le mousedown alimentera circleOffsetAngle via
    // updateCircleGesture (memes coordonnees ecran que la souris du
    // geste, pour eviter tout drift entre les deux).
    state.circleOffsetAngle = 0
    requestDraw()
}

const updateCircleGesture = (mouseScreen) => {
    if (!state.circleCenterModel) return
    const rawEdge = screenToModel(mouseScreen)
    const edge = state.activeGrid ? snapToGrid(rawEdge) : rawEdge
    state.circleRadiusModel = Math.hypot(
        edge.x - state.circleCenterModel.x,
        edge.y - state.circleCenterModel.y,
    )
    // Angle de depart du polygone : angle du vecteur curseur - centre
    // en coords screen (PAS model — l'axe Y inverse de model perturbe
    // l'intuition : « je veux le sommet 0 vers la souris », il faut
    // donc raisonner dans le repere visuel). atan2(dy, dx) en
    // screen retourne l'angle trigonometrique du vecteur dans le
    // repere ecran (Y pointe vers le bas sur canvas), applique tel
    // quel a `circleGeometry(center, radius, segments, offset)` :
    // pour le sommet i, l'angle devient (i/n)*TAU + offset, calcule
    // en coords model. Le rendu (modelToScreen flippe Y)
    // reprojette symetriquement : le sommet 0 tombe donc sur la
    // position visible de la souris. Memes maths que la position
    // du label d'identifiant de sommet (§7.8) et la conversion
    // souris-to-model.
    const centerScreen = modelToScreen(state.circleCenterModel)
    state.circleOffsetAngle = Math.atan2(
        mouseScreen.y - centerScreen.y,
        mouseScreen.x - centerScreen.x,
    )
    requestDraw()
}

export const commitCircleGesture = (e) => {
    if (!state.circleCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Refraichir rayon + angle sur la position exacte du 2e mousedown
    // au cas ou le curseur aurait bouge entre le dernier mousemove
    // et ce mousedown (peu probable en pratique mais symetrique avec
    // l'ancien geste « mouseup avec rayon = distance finale »).
    updateCircleGesture(mouseScreen)
    const center = state.circleCenterModel
    const radius = state.circleRadiusModel
    const offsetAngle = state.circleOffsetAngle
    state.circleCenterModel = undefined
    state.circleRadiusModel = 0
    state.circleOffsetAngle = 0
    if (radius * state.ctx.zoomLevel < CIRCLE_MIN_RADIUS_PX) {
        log('Cercle ignore : rayon trop petit')
        requestDraw()
        return
    }
    createCircle(center, radius, state.circleSegments, offsetAngle)
}

export const cancelCircleGesture = () => {
    state.circleCenterModel = undefined
    state.circleRadiusModel = 0
    state.circleOffsetAngle = 0
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// Commite un cercle dans la forme active : append du pointList et des
// tris de circleGeometry (indices decales du nombre de points deja
// presents) + entry d'historique replaceShape (before/after clone du
// shape actif — meme pattern que deleteSelectedPoint). `offsetAngle`
// (defaut 0) est transmis tel quel a circleGeometry ; le caller
// (commitCircleGesture) le derive de la position du curseur dans le
// repere screen pour que le sommet 0 du polygone pointe vers la
// souris sur le canvas.
export const createCircle = (center, radius, segments, offsetAngle = 0) => {
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedBefore = cloneShape(shape)
    const { pointList, tris } = circleGeometry(center, radius, segments, offsetAngle)
    const base = shape.pointList.length
    for (let i = 0; i < pointList.length; i++) {
        shape.pointList.push({ x: pointList[i].x, y: pointList[i].y })
    }
    for (let i = 0; i < tris.length; i++) {
        shape.tris.push({
            p1: tris[i].p1 + base,
            p2: tris[i].p2 + base,
            p3: tris[i].p3 + base,
        })
    }
    const clonedAfter = cloneShape(shape)
    saveState({
        patches: [replaceShapePatch(
            shapeIdx,
            clonedBefore.pointList, clonedBefore.tris,
            clonedAfter.pointList, clonedAfter.tris,
        )],
    })
    state.nearestPoint = undefined
    state.nearestLine = undefined
    log(`Cercle cree : ${Math.round(segments)} cotes, rayon ${radius.toFixed(1)}${offsetAngle !== 0 ? ', angle de depart ' + (offsetAngle * 180 / Math.PI).toFixed(2) + ' deg' : ''}`)
    // Spec utilisateur : le mode cercle se desactive apres la creation
    // (le bouton est desélectionne) — un cercle = un geste, pas un
    // mode persistant. Le prochain cercle necessite un nouveau clic
    // sur le bouton. exitCircleMode re-log, met a jour le bouton et
    // repaint (requestDraw + updateMouseHover) — il couvre donc le
    // rafraichissement final.
    exitCircleMode()
    persistState()
}
// ===== Formes prédéfinies (panneau #shapes) =====
//
// Le bouton #shapes ouvre un panneau flottant (meme pattern que
// #triangleColorPanel : positionne sous le bouton, ferme au clic
// exterieur / Echap) listant des formes prédéfinies : rectangle,
// carre, polygones reguliers (triangle, pentagone, hexagone) et
// etoile. Choisir une forme arme l'outil (bouton en accent vert +
// libellé, panneau ferme) : le geste clic + glisser sur le canvas
// pose l'ancre (1er coin pour rect/carre, centre pour les autres)
// puis la taille ; le relâchement genere la forme (points + triangles)
// et desarme l'outil (comme le cercle). Echap ferme le panneau ou
// desarme l'outil sans creer ; clic droit / Backspace annulent le
// trace en cours sans desarmer.

// Positionne un panneau flottant juste sous le bouton declencheur en
// le gardant ENTIEREMENT dans la fenetre : si le bouton est proche du
// bord droit ou bas, un positionnement brut a rect.left / rect.bottom
// ferait deborder le panneau du viewport (partiellement masque, voire
// scroll horizontal). On mesure les dimensions reelles du panneau
// (apres display — d'ou le hidden = false ici) et on redecale top/left
// tant que necessaire, avec une petite marge. Partage par #shapesPanel
// et #triangleColorPanel : les deux panneaux ont la meme contrainte de
// positionnement (bouton declencheur dans la toolbar).
const positionPanelUnderButton = (btn, panel) => {
    const MARGIN = 8
    const rect = btn.getBoundingClientRect()
    panel.style.top = (rect.bottom + 4) + 'px'
    panel.style.left = rect.left + 'px'
    panel.hidden = false
    const panelRect = panel.getBoundingClientRect()
    let left = panelRect.left
    let top = panelRect.top
    if (left + panelRect.width > window.innerWidth - MARGIN) {
        left = Math.max(MARGIN, window.innerWidth - panelRect.width - MARGIN)
    }
    if (top + panelRect.height > window.innerHeight - MARGIN) {
        top = Math.max(MARGIN, window.innerHeight - panelRect.height - MARGIN)
    }
    if (left !== panelRect.left) panel.style.left = left + 'px'
    if (top !== panelRect.top) panel.style.top = top + 'px'
}

export const openShapesPanel = () => {
    const btn = document.querySelector('#shapes')
    const panel = document.querySelector('#shapesPanel')
    if (!btn || !panel) return
    positionPanelUnderButton(btn, panel)
    state.shapesPanelOpen = true
    updateShapesButton()
}

export const closeShapesPanel = () => {
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.shapesPanelOpen = false
    updateShapesButton()
}

export const toggleShapesPanel = () => {
    if (state.shapesPanelOpen) closeShapesPanel()
    else openShapesPanel()
}

// Arme l'outil pour une forme du panneau : ferme le panneau et attend
// le geste clic + glisser. Reste arme jusqu'a la creation (desarme
// automatique) ou Echap (annulation).
export const armShapeTool = (kind) => {
    if (!SHAPE_DEFS[kind]) return
    // Exclusion mutuelle avec le mode cercle (un seul geste de
    // creation actif a la fois).
    if (state.circleMode) exitCircleMode()
    state.shapesPanelOpen = false
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.shapeKind = kind
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    state.currentAction = ACTION_NONE
    updateShapesButton()
    log(`Forme armee : ${SHAPE_DEFS[kind].label} (clic + glisser pour la taille)`)
    requestDraw()
}

export const disarmShapeTool = () => {
    if (state.shapeKind === undefined) return
    state.shapeKind = undefined
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    updateShapesButton()
    log('Outil forme desarme')
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

export const beginShapeGesture = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawAnchor = screenToModel(mouseScreen)
    const anchor = state.activeGrid ? snapToGrid(rawAnchor) : rawAnchor
    state.shapeAnchorModel = { x: anchor.x, y: anchor.y }
    state.shapeCurrentModel = { x: anchor.x, y: anchor.y }
    state.shapeRadiusModel = 0
    requestDraw()
}

const updateShapeGesture = (mouseScreen) => {
    if (state.shapeKind === undefined || !state.shapeAnchorModel) return
    const rawCurrent = screenToModel(mouseScreen)
    const current = state.activeGrid ? snapToGrid(rawCurrent) : rawCurrent
    state.shapeCurrentModel = { x: current.x, y: current.y }
    state.shapeRadiusModel = Math.hypot(
        current.x - state.shapeAnchorModel.x,
        current.y - state.shapeAnchorModel.y,
    )
    requestDraw()
}

export const cancelShapeGesture = () => {
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

export const commitShapeGesture = (e) => {
    if (state.shapeKind === undefined || !state.shapeAnchorModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    updateShapeGesture(mouseScreen)
    const kind = state.shapeKind
    const anchor = state.shapeAnchorModel
    const current = state.shapeCurrentModel
    const radius = state.shapeRadiusModel
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    const minSizePx = CIRCLE_MIN_RADIUS_PX
    if (kind === 'rect' || kind === 'square') {
        const dx = current.x - anchor.x
        const dy = current.y - anchor.y
        if (Math.abs(dx) * state.ctx.zoomLevel < minSizePx && Math.abs(dy) * state.ctx.zoomLevel < minSizePx) {
            log('Forme ignoree : taille trop petite')
            requestDraw()
            return
        }
        let corner2 = current
        if (kind === 'square') {
            const side = Math.max(Math.abs(dx), Math.abs(dy))
            corner2 = { x: anchor.x + (dx < 0 ? -side : side), y: anchor.y + (dy < 0 ? -side : side) }
        }
        createShape(kind, anchor, corner2, 0)
    } else {
        if (radius * state.ctx.zoomLevel < minSizePx) {
            log('Forme ignoree : taille trop petite')
            requestDraw()
            return
        }
        createShape(kind, anchor, undefined, radius)
    }
}

// Commite une forme dans la forme active : append du pointList et des
// tris de la geometrie du kind (indices decales du nombre de points
// existants) + entry d'historique replaceShape (meme pattern que
// createCircle / deleteSelectedPoint), puis desarme automatiquement
// (un geste = une forme, comme le cercle).
export const createShape = (kind, anchor, current, radius) => {
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedBefore = cloneShape(shape)
    let geometry
    if (kind === 'rect' || kind === 'square') {
        geometry = rectGeometry(anchor, current)
    } else if (kind === 'star') {
        geometry = starGeometry(anchor, radius, SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO)
    } else {
        const n = { tri: 3, penta: 5, hexa: 6 }[kind]
        geometry = circleGeometry(anchor, radius, n)
    }
    const base = shape.pointList.length
    for (let i = 0; i < geometry.pointList.length; i++) {
        shape.pointList.push({ x: geometry.pointList[i].x, y: geometry.pointList[i].y })
    }
    for (let i = 0; i < geometry.tris.length; i++) {
        shape.tris.push({
            p1: geometry.tris[i].p1 + base,
            p2: geometry.tris[i].p2 + base,
            p3: geometry.tris[i].p3 + base,
        })
    }
    const clonedAfter = cloneShape(shape)
    saveState({
        patches: [replaceShapePatch(
            shapeIdx,
            clonedBefore.pointList, clonedBefore.tris,
            clonedAfter.pointList, clonedAfter.tris,
        )],
    })
    state.nearestPoint = undefined
    state.nearestLine = undefined
    log(`${SHAPE_DEFS[kind].label} cree : ${geometry.pointList.length} points, ${geometry.tris.length} triangles`)
    disarmShapeTool()
    persistState()
}

// Cablage du panneau #shapes : bouton (ouvrir/fermer/desarmer) +
// boutons de formes (armer) + fermeture au clic exterieur (meme
// pattern que wireTriangleColorPanel).
export const wireShapesPanel = () => {
    const btn = document.querySelector('#shapes')
    const panel = document.querySelector('#shapesPanel')
    if (!btn || !panel) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        if (state.shapesPanelOpen) {
            closeShapesPanel()
        } else if (state.shapeKind !== undefined) {
            disarmShapeTool()
        } else if (state.circleMode) {
            exitCircleMode()
        } else {
            openShapesPanel()
        }
    })
    panel.querySelectorAll('button[data-shape]').forEach((shapeBtn) => {
        shapeBtn.addEventListener('click', (e) => {
            if (e.button !== 0) return
            // Le cercle vit dans le panneau depuis le deplacement du
            // bouton : choisir « Cercle » entre dans le mode cercle
            // (raccourci C equivalent) au lieu d'armer un shapeKind.
            // enterCircleMode ferme le panneau lui-meme.
            if (shapeBtn.dataset.shape === 'circle') {
                enterCircleMode()
                return
            }
            armShapeTool(shapeBtn.dataset.shape)
        })
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.shapesPanelOpen) return
        const target = e.target
        if (!target) return
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        closeShapesPanel()
    })
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
        // Le fill est une propriete du TRIANGLE, pas du sommet : il doit
        // survivre au re-indexage. Regression fixee : sa perte effaçait la
        // couleur de TOUS les triangles survivants a chaque suppression
        // (sommet, segment ou triangle). Même convention que cloneShape
        // (fill: string seulement).
        fill: typeof t.fill === 'string' ? t.fill : undefined,
    }))
    return idxMap
}

// ===== Suppression d'un point =====

// (modifyShapeModel-spec §4.1, alterne invariants I1-I8) :
// suppression d'un sommet = retirer ses refs des slots puis compacter
// (invariant I2). Les tris avec < 2 sommets survivants disparaissent
// (regle §4.1 'segment oppose survit').
//
// (delta) on capture l'état avant+après du shape actif et on
// émet un `replaceShapePatch` (DESIGN §8). C'est PLUS ÉCONOME qu'un
// cloneScene plein dès que la scène contient plusieurs formes
// (pour une scène mono-shape, le seuil shouldUseSnapshot bascule en
// snapshot, parité avec l'ancien comportement).
export const deleteSelectedPoint = () => {
    const shape = activeShape()
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getIndicesAtSamePosition(state.nearestPoint.point)
    }
    if (targets.length === 0) return

    // Capture pré-mutation du shape actif (pour la branche BEFORE du patch).
    const shapeIdx = state.activeShapeIndex
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris

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
            // Le fill du tri survive (regression : sa perte effaçait la
            // couleur des triangles survivants apres suppression).
            fill: typeof t.fill === 'string' ? t.fill : undefined,
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

    // (delta) capture post-mutation du shape actif et saveState
    // avec patch replaceShape (snapshot fallback automatique si
    // mono-shape, voir shouldUseSnapshot).
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
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un segment (mode 'segment') =====

// §4.1 : suppression des triangles dont 2+ slots matchent les
// endpoints du segment. Les triangles avec 0-1 match survivent (leurs
// autres slots conservent leur ref). Compact pointList invariant I2.
//
// (delta) replaceShapePatch pré + post, voir deleteSelectedPoint.
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

    const shapeIdx = state.activeShapeIndex
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris

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
    updateColorButtonState()
    persistState()
}

// ===== Suppression d'un triangle (mode 'triangle') =====

// §4.1 : suppression stricte des triangles dont les 3 slots
// matchent le triangle selectionne (matchCount === 3). Distinct du
// mode segment : on ne supprime pas les triangles partageant un sommet.
// Compact pointList I2.
//
// (delta) replaceShapePatch pré + post, voir deleteSelectedPoint.
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

    const shapeIdx = state.activeShapeIndex
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris

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
            requestDraw()
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
    requestDraw()
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
    // Filet défensif : tout patch deferred non committé d'un grab
    // précédent est effacé. Sans cela, un grab interrompu avant
    // mouseup (très rare, ex. via Ctrl+Z mid-grab) laisserait un
    // _pendingGrabPatch orphelin qui pourrait être commité à tort
    // par un grab futur. Reset pour partir propre.
    state._pendingGrabPatch = null

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

    // (delta) commit le patch deferred capturé dans
    // resolveMouseMoveOnBoard à la première tick de mouvement
    // significatif. L'AFTER est résolu ici depuis le live state
    // (les points mutés sont à leur position finale).
    if (state._pendingGrabPatch) {
        saveState({ patches: [state._pendingGrabPatch] })
        state._pendingGrabPatch = null
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

    // Mode cercle : le glisser regle le rayon du cercle en cours de
    // tracé (geste de construction, pas un lasso ni un grab).
    // updateMouseHover repaint (la preview est dans renderTransient)
    // et met a jour le HUD coordonnees. La garde !previewMode laisse
    // la molette zoomer normalement si un P a été pressé en mode
    // cercle.
    if (state.circleMode && !state.previewMode) {
        updateCircleGesture(mouseScreen)
        state.lastMousePos = mouseScreen
        updateMouseHover(mouseScreen)
        return
    }
    // Forme predéfinie armee : le glisser regle la taille (coin oppose
    // pour rect/carre, rayon pour les polygones/etoile). Meme pattern
    // que le cercle : preview via renderTransient + HUD coordonnees.
    if (state.shapeKind !== undefined && !state.previewMode) {
        updateShapeGesture(mouseScreen)
        state.lastMousePos = mouseScreen
        updateMouseHover(mouseScreen)
        return
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
            // (feature/performance) signale que la scene stable a change
            // (state.selectedPoints mute a la volee pendant le drag du
            // lasso). Sans le flag `sceneDirty` leve ici, renderSceneToOffscreen
            // garderait le cache offscreen avec l'ancienne selection et les
            // points engages ne seraient visibles qu'apres un grab/rotate (qui
            // appelle requestDraw). Le rAF interne a requestDraw coalescera
            // les 60+ ticks de drag en au plus 1 paint / frame. Meme pattern
            // que la branche grab au-dessus.
            requestDraw()
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
                // (delta) movePointsPatch *deferred* : on capture
                // le BEFORE (startX/startY de chaque item du
                // grabbedGroup) à ce tick, l'AFTER est résolu en
                // lisant le live state à la fin du geste (mouseup).
                // Cf. §8 DESIGN.md (deferred fill).
                state._pendingGrabPatch = movePointsPatch(
                    state.grabbedGroup.map(item => ({
                        s: item.shapeIndex, i: item.pointIndex,
                        x: item.startX, y: item.startY,
                    })),
                    null,
                )
                state.grabHistorySaved = true
            }
            state.grabbedGroup.forEach(item => {
                applyGrabToPoint(item, getGrabTargetPosition(item, dx, dy))
            })
            // (feature/performance) signale que la scene stable a
            // change (positions des points drags mutees a la volee
            // dans pointList). Sans ce flag, updateMouseHover pourrait
            // early-return sur une signature inchangee et laisser la
            // nouvelle position invisible. Le rAF interne a requestDraw
            // coalescera les 60+ ticks de drag en au plus 1 paint / frame.
            requestDraw()
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
//
// (delta) le patch movePoints sur tous les points de toutes les
// formes est *deferred* : capture du BEFORE à la première tick, fill
// du AFTER au commit à la fin du geste (debounce 400 ms). Gros patch
// (~5 N points × 2 directions) mais reste ≪ full cloneScene qui
// clonerait aussi les tris — gain typique marqué sur mesh multi-tris.
export const rotateEachShapeAroundPivot = (pivotModel, angle) => {
    if (!state.shapes || state.shapes.length === 0) return
    if (!state.isEachShapeRotating) {
        // Capture BEFORE pour movePoints deferred : tous les points
        // de toutes les formes, avant le premier tick de rotation.
        const beforeEntries = []
        state.shapes.forEach((shape, sidx) => {
            if (!Array.isArray(shape.pointList)) return
            for (let i = 0; i < shape.pointList.length; i++) {
                const p = shape.pointList[i]
                if (!p) continue
                beforeEntries.push({ s: sidx, i: i, x: p.x, y: p.y })
            }
        })
        state._pendingEachShapeRotatePatch = movePointsPatch(beforeEntries, null)
        state.isEachShapeRotating = true
        state.selectedPoints = []
        updateSelectionHud()
        log('AltGr + molette detecte - rotation de chaque forme autour du curseur (5 deg/tick)')
    }
    clearTimeout(state.eachShapeRotateTimer)
    state.eachShapeRotateTimer = setTimeout(() => {
        state.isEachShapeRotating = false
        if (state._pendingEachShapeRotatePatch) {
            saveState({ patches: [state._pendingEachShapeRotatePatch] })
            state._pendingEachShapeRotatePatch = null
        }
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

    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

// Q1c : state.selectedPoints est un array d'indices ; on
// mute directement pointList[idx]. Une rotation d'un point partage
// par N triangles produit N mises a jour identiques sur la meme
// coord - l'effet visuel est identique, la complexite est O(N) en
// selectedPoints au lieu de O(M*N) en tri*slots.
//
// (delta) movePoints deferred sur selectedPoints du shape actif.
// Capture BEFORE à la première tick, commit au debounce du wheel
// timer. Patch compact (O(N) sur N sélectionnés) ≪ full cloneScene.
export const rotateSelectedPoints = (center, angle) => {
    if (state.selectedPoints.length < 2 || state.isSelectionDimmed) return
    if (!state.isWheelRotating) {
        const activeShapeRef = state.shapes[state.activeShapeIndex]
        const pointList = Array.isArray(activeShapeRef.pointList) ? activeShapeRef.pointList : []
        const beforeEntries = []
        state.selectedPoints.forEach(idx => {
            const p = pointList[idx]
            if (!p) return
            beforeEntries.push({ s: state.activeShapeIndex, i: idx, x: p.x, y: p.y })
        })
        state._pendingSelectedRotatePatch = movePointsPatch(beforeEntries, null)
        state.isWheelRotating = true
    }
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = setTimeout(() => {
        state.isWheelRotating = false
        if (state._pendingSelectedRotatePatch) {
            saveState({ patches: [state._pendingSelectedRotatePatch] })
            state._pendingSelectedRotatePatch = null
        }
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

    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// ===== Coloration des triangles (mode 'triangle') =====

// ===== Panneau flottant de coloration =====

// Helper dedie au panneau de couleurs : bascule la classe
// `.swatch-active` sur l'element N (data-index) du conteneur ; si
// l'index est null / invalide, retire la classe partout
// (utilise apres un clic sur Reset du panneau). Centralise la
// sequence « retirer partout, ajouter sur un » qui etait
// repetee en showTriangleColorPanel + buildColorSwatches +
// wireTriangleColorPanel (input + reset). host : le
// #triangleColorSwatches ; dataIndex : entier >= 0, ou null
// pour desactiver tous les swatches.
const setActiveSwatch = (host, dataIndex) => {
    if (!host) return
    host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
    if (dataIndex === null || dataIndex === undefined) return
    const target = host.querySelector('.swatch[data-index="' + String(dataIndex) + '"]')
    if (target) target.classList.add('swatch-active')
}

// (evolution peinture) le panneau est un toggle panel :
//   - ouvert une fois : le pinceau est immédiatement armé avec une
//     couleur par défaut (1er preset, swatch visuellement
//     sélectionne). L'utilisateur peut peindre des le premier clic
//     gauche sur un triangle, sans cliquer une couleur.
//   - clic sur un swatch / input color picker : maj brushColor
//     (le pinceau reste armé).
//   - clic sur le bouton Reset du panneau : désarme le pinceau
//     (brushMode = false, le panneau reste ouvert à la recherche
//     d'une nouvelle couleur). Distinct du comportement historique
//     « applique TRIANGLE_COLOR_CLEAR aux triangles selectionnes »
//     car le panneau n'est plus un outil d'application sur la
//     selection — c'est un nuancier pour le pinceau.
//   - fermeture (re-clic bouton / Escape / clic exterieur) : panneau
//     cache + brushMode = false + brushColor = undefined.
//
// Le bouton est désormais TOUJOURS interactif (cf. markup main.html,
// pas d'attribut disabled) et hud.js updateColorButtonState ne le
// disabled plus. L'ancienne garde
// `selectionMode==='triangle' && selectedTriangles.length>0`
// est retirée : c'est précisément le verrou que l'évolution fait
// sauter.
export const toggleTriangleColorPanel = () => {
    const btn = document.querySelector('#triangleColor')
    const panel = document.querySelector('#triangleColorPanel')
    if (!btn || !panel) return
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
    // Pré-armement du pinceau avec le 1er preset (swatch visuellement
    // sélectionne). On évite ainsi un « deux clics » inutile à
    // l'ouverture : des que le panneau est visible, l'utilisateur
    // peut peindre. Le 1er swatch est mis en surbrillance via la
    // classe .swatch-active et le color input picker est
    // resynchronise sur la valeur hex correspondante (les affinités
    // swatch <-> picker ne sont pas strictement symétriques : le
    // picker travaille en #rrggbb, les swatches en rgba avec alpha
    // alpha definie dans TRIANGLE_COLOR_PRESETS, intentionnellement
    // non persistee dans le color picker — on accepte que le
    // passage picker -> preset ne preserve pas l'alpha, comme
    // avant).
    positionPanelUnderButton(btn, panel)
    state.isTriangleColorPanelOpen = true
    btn.classList.add('color-panel-open')
    const firstPreset = TRIANGLE_COLOR_PRESETS[0]
    state.brushColor = firstPreset.fill
    state.brushMode = true
    setActiveSwatch(document.querySelector('#triangleColorSwatches'), 0)
    const input = document.querySelector('#triangleColorInput')
    if (input && firstPreset) input.value = firstPreset.bg
    updateColorButtonState()
}

export const hideTriangleColorPanel = () => {
    const panel = document.querySelector('#triangleColorPanel')
    const btn = document.querySelector('#triangleColor')
    if (panel) panel.hidden = true
    state.isTriangleColorPanelOpen = false
    // Palette fermée → pinceau désarmé (cf. cahier des charges
    // évolution). On purge aussi brushColor pour que le prochain
    // show reparte proprement d'un état vierge (pas de couleur
    // orpheline si l'utilisateur a bricolé le picker entre-temps).
    state.brushMode = false
    state.brushColor = undefined
    if (btn) btn.classList.remove('color-panel-open')
    updateColorButtonState()
}

// Peint un seul triangle (sous le curseur en mode pinceau). Distinct
// de applyColorToSelectedTriangles (qui itère sur selectedTriangles) :
// ici on cible directement un index de tri, sans dépendre d'une
// sélection. Mêmes garde-fous que applyColorToSelectedTriangles
// (capture BEFORE/AFTER fills → patch setFills compact, persistState
// + requestDraw pour repeindre, mutation live de t.fill). Si color
// est undefined ou TRIANGLE_COLOR_CLEAR, on efface le fill (delete
// t.fill) — au cas où le pinceau serait réarmé sans couleur
// (improbable en pratique : show panneau arme toujours avec un
// preset, et Reset désarme sans fixer de couleur).
const paintSingleTriangle = (triangleIndex, color) => {
    if (!state.shapes || !state.shapes[state.activeShapeIndex]) return
    const tris = state.shapes[state.activeShapeIndex].tris
    if (!Array.isArray(tris) || triangleIndex < 0 || triangleIndex >= tris.length) return
    const tri = tris[triangleIndex]
    if (!tri) return
    // (Q2c) invariance : p1/p2/p3 doivent être des entiers (un tri
    // partiellement construit n'est pas peignable — on ne peint que
    // des triangles « complets »).
    if (!Number.isInteger(tri.p1) || !Number.isInteger(tri.p2) || !Number.isInteger(tri.p3)) return
    const shapeIdx = state.activeShapeIndex
    const beforeEntries = [{ s: shapeIdx, t: triangleIndex, fill: typeof tri.fill === 'string' ? tri.fill : undefined }]
    if (color === undefined || color === TRIANGLE_COLOR_CLEAR) {
        delete tri.fill
    } else if (typeof color === 'string' && color.length > 0) {
        tri.fill = color
    }
    const afterEntries = [{ s: shapeIdx, t: triangleIndex, fill: typeof tri.fill === 'string' ? tri.fill : undefined }]
    saveState({ patches: [setFillsPatch(beforeEntries, afterEntries)] })
    // workIsSaved est mis a 1 dans io.js apres saveMesh/loadState/
    // reset ; on le remet a 0 ici pour signaler au prochain
    // recomputeSceneDirty que la scene a diverge de la baseline.
    // workIsBackuped (champ legacy non lu) n'est plus pose.
    state.ctx.workIsSaved = 0
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    persistState()
}

// (evolution peinture) clic gauche sur le canvas en mode pinceau :
// trouve le triangle le plus proche du curseur (mêmes critères que
// findNearestTriangle : intérieur ou proche du centroide) et lui
// applique brushColor. Pas de creation de point / lasso / suppression
// — le mousedown handler global de main.js return tôt après l'appel
// pour court-circuiter toutes les autres branches.
// Si aucun triangle n'est atteignable (zone vide, point trop loin),
// on noop : le pinceau n'a rien à peindre, et ne touche pas à la
// sélection courante.
export const paintTriangleAtCursor = (e) => {
    if (!state.brushMode) return
    if (typeof state.brushColor !== 'string') return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawTarget = screenToModel(mouseScreen)
    const target = state.activeGrid ? snapToGrid(rawTarget) : rawTarget
    const nt = findNearestTriangle(target)
    if (!nt) return
    paintSingleTriangle(nt.triangleIndex, state.brushColor)
    log(`Peinture : triangle ${nt.triangleIndex}`)
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
        sw.title = 'Peindre avec ' + preset.bg
        sw.dataset.index = String(i)
        sw.addEventListener('click', (e) => {
            if (e.button !== 0) return
            // (evolution peinture) armer le pinceau avec la couleur
            // choisie, ne plus appliquer a la selection. La
            // sélection est orthogonale au pinceau : si elle contient
            // des triangles, on ne les peint PAS automatiquement,
            // l'utilisateur le fera au clic gauche sur chaque tri.
            state.brushColor = preset.fill
            state.brushMode = true
            setActiveSwatch(host, i)
            const input = document.querySelector('#triangleColorInput')
            if (input) input.value = preset.bg
            updateColorButtonState()
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
        // Le picker natif renvoie toujours du #rrggbb (alpha 1
        // implicite) : la conversion vers rgba avec alpha 0.45
        // comme les presets est possible mais perdrait l'intent
        // utilisateur (il peut vouloir une couleur opaque).
        // On respecte donc sa valeur hex telle quelle et on arme
        // le pinceau directement avec.
        state.brushColor = input.value
        state.brushMode = true
        // Swatch actif : on cherche un preset dont le .bg matche la
        // valeur hex du picker (comparaison case-insensitive). Si
        // la couleur custom n'est pas un preset, on desactive tous
        // les swatches (couleur libre active mais aucun preset ne
        // matche).
        const matchIdx = TRIANGLE_COLOR_PRESETS.findIndex(p => p.bg.toLowerCase() === input.value.toLowerCase())
        setActiveSwatch(document.querySelector('#triangleColorSwatches'), matchIdx >= 0 ? matchIdx : null)
        updateColorButtonState()
    })
    resetBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        // (evolution peinture) Reset = desarmer le pinceau, NE PAS
        // appliquer TRIANGLE_COLOR_CLEAR aux triangles selectionnes.
        // Le panneau reste ouvert pour permettre a l'utilisateur
        // de choisir une nouvelle couleur. On enleve la
        // surbrillance des swatches (aucune couleur n'est active)
        // et on remet la valeur du picker au preset[0] (cohérent
        // avec l'ancien comportement : picker "fraichement
        // initialisé" apres un reset). Pas de requestDraw /
        // persistState ici : on ne mute pas la scene.
        state.brushMode = false
        state.brushColor = undefined
        setActiveSwatch(document.querySelector('#triangleColorSwatches'), null)
        input.value = TRIANGLE_COLOR_PRESETS[0].bg
        updateColorButtonState()
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.isTriangleColorPanelOpen) return
        const target = e.target
        if (!target) return
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        // Le clic sur un triangle du canvas declenche
        // paintTriangleAtCursor via le mousedown handler global —
        // on NE ferme PAS le panneau sur un simple clic sur un tri
        // (l'utilisateur peut peindre plusieurs triangles d'affilée
        // sans rouvrir la palette). Un clic exterieur (toolbar,
        // overlay, console) ferme, comme avant.
        if (target.id === 'board') return
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
