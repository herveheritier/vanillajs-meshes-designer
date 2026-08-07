// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    ACTION_NONE, ACTION_GRABBING,
    COLOR_HOVER_NEAREST_LINE, LINE_WIDTH_HOVER_NEAREST_LINE,
    COLOR_HOVER_NEAREST_POINT,
    COLOR_HOVER_NEAREST_TRIANGLE_STROKE, COLOR_HOVER_NEAREST_TRIANGLE_FILL,
    TRIANGLE_COLOR_PRESETS, TRIANGLE_COLOR_CLEAR, TRIANGLE_COLOR_DEFAULT_ALPHA, TAU,
    COLOR_PALETTE_STORAGE_KEY, COLOR_ALPHA_STORAGE_KEY, triangleFillFromBg,
    POINT_HIT_RADIUS_PX, LINE_HIT_RADIUS_PX, TRIANGLE_CENTROID_HIT_RADIUS_PX,
    CIRCLE_MIN_RADIUS_PX, CIRCLE_DEFAULT_SEGMENTS,
    SHAPE_DEFS, SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO,
    STAR_INNER_RATIO_MIN, STAR_INNER_RATIO_MAX,
    ANNULUS_INNER_RATIO_MIN, ANNULUS_INNER_RATIO_MAX, ANNULUS_INNER_RATIO_DEFAULT,
} from './constants.js'
import { drawBoard, drawPoint, drawVertexLabel, drawStackList, requestDraw, isSceneDirty } from './draw.js'
import { updateSelectionHud, updateColorButtonState, updateShapesButton, updateClipboardButtons, updateAlignButton, updateAlignPanelButtons, showActionComment, showHoverComment, isActionCommentActive } from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import { modelToScreen } from './geometry.js'
import {
    screenToModel, snapToGrid,
    activeTriangles, getAllVertices, getPointsAtSamePosition, getVertexIndex, getStackTriangleRefs, isPointSelected,
    getIndicesAtSamePosition,
    adjacentPoints, computeOrthogonalProjection, isInsideSegmentByDot,
    circleGeometry, triangleGeometry, rectGeometry, starGeometry, annulusGeometry,
} from './geometry.js'
import { saveState, movePointsPatch, insertPointPatch, replaceShapePatch, setFillsPatch, cloneShape } from './history.js'
import { persistState, importMeshFromFile } from './io.js'
import { log } from './log.js'

// ===== find : point/line/triangle les plus proches =====

// (modifyShapeModel-spec §3.6) : scanne directement le pointList
// canonique du plan actif (Q1a per-shape). Renvoie un point avec son
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
// slots tris.pX = indices pointList ; renvoie aussi pointIndices pour
// que les callers fassent cluster/selection par indice.
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

// Clef de dedup : tant que la signature visuelle (curseur, nearest*,
// selection dimmed, lasso) est inchangee ET que le cache scene n'est
// pas dirty, aucun redraw n'est necessaire. isSceneDirty() absorbe
// les mutations raw (drag qui mute pointList sans requestDraw).
let lastHoverSignature = null
const computeHoverSignature = (cursorScreen) => {
    const npKey = state.nearestPoint ? state.nearestPoint.pointIndex : '_'
    const nlKey = state.nearestLine ? state.nearestLine.triangleIndex + ':' + state.nearestLine.lineIndex : '_'
    const ntKey = state.nearestTriangle ? state.nearestTriangle.triangleIndex : '_'
    const cKey = cursorScreen ? (Math.round(cursorScreen.x) + ',' + Math.round(cursorScreen.y)) : '_'
    const boxKey = state.isSelectingBox && state.selectionBoxStart && state.selectionBoxCurrent
        ? '1|' + Math.round(state.selectionBoxCurrent.x) + ',' + Math.round(state.selectionBoxCurrent.y)
        : '0'
    // selectionMode / brushMode changent le MESSAGE de survol sans
    // changer les nearest* : inclus pour forcer le recalcul du toast
    // a la bascule de mode.
    return cKey + '|' + npKey + '|' + nlKey + '|' + ntKey + '|' + (state.isSelectionDimmed ? 'd' : 'n') + '|' + boxKey + '|' + state.selectionMode + '|' + (state.brushMode ? 'b' : 'n') + '|' + (state.activeConstructionTriangle ? 'c' : 'n')
}

export const updateMouseHover = (cursorScreen) => {
    // Preview / kiosque : aucun overlay de survol (aides d'edition, pas de geometrie).
    if (state.previewMode || state.kioskMode) return
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    // Modes de construction : les overlays de survol sont du bruit ;
    // seule la preview (renderTransient) + le curseur + le toast de
    // phase (computeHoverComment) sont dessines.
    if (state.circleMode || state.starMode || state.annulusMode || state.shapeKind !== undefined) {
        updateHoverComment()
        drawBoard()
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

    // Skip de frame si la signature est inchangee ET que le cache
    // scene est valide (le 2e terme absorbe les drags qui muent
    // pointList sans requestDraw).
    const signature = computeHoverSignature(cursorScreen)
    if (signature === lastHoverSignature && !isSceneDirty()) return
    lastHoverSignature = signature

    // Le toast de survol ne se met à jour que quand la signature change
    // (dedup cote showHoverComment).
    updateHoverComment()

    // Le curseur est repeint par renderTransient ; les overlays de
    // survol se dessinent par-dessus.
    drawBoard()

    if (state.nearestPoint && state.nearestPoint.point) {
        drawPoint(state.nearestPoint.point, 5, COLOR_HOVER_NEAREST_POINT)
        // §7.8 : index 0-based du sommet (fallback '?' si absent).
        const vertexIdx = getVertexIndex(state.nearestPoint.point)
        drawVertexLabel(state.nearestPoint.point, vertexIdx >= 0 ? vertexIdx : '?')
        // §7.9 : pill des slots partageant la position, si > 1 ref.
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

// ===== Commentaire contextuel de survol (toast prospectif) =====
// Le toast dit ce que l'utilisateur PEUT faire maintenant, au moment
// où il peut le faire (cf. DESIGN.md §7.15). Hierarchie : construction
// (phase courante) > triangle partiel en cours > pinceau > survol
// d'element (meme ordre que le clic) > zone vide (post-action d'abord,
// sinon message generique). Messages persistants tant que le survol dure.
const computeHoverComment = () => {
    const shape = activeShape()
    const tris = shape && Array.isArray(shape.tris) ? shape.tris : []
    const lastTri = tris.at(-1)

    // 1. Construction : le geste arme prime sur un triangle partiel laisse en attente.
    if (state.circleMode) {
        return state.circleCenterModel
            ? '2e clic gauche : valide le cercle — molette pour les côtés, clic droit pour annuler'
            : '1er clic gauche : pose le centre du cercle — la molette règle le nombre de côtés'
    }
    if (state.starMode) {
        if (state.starPhase === 0) {
            return state.starCenterModel
                ? '2e clic gauche : verrouille rayon et angle — la souris règle la profondeur'
                : '1er clic gauche : pose le centre de l\'étoile'
        }
        return '3e clic gauche : valide l\'étoile — clic droit pour annuler'
    }
    if (state.annulusMode) {
        if (state.annulusPhase === 0) {
            return state.annulusCenterModel
                ? '2e clic gauche : verrouille le rayon externe — la souris règle le trou'
                : '1er clic gauche : pose le centre de l\'anneau'
        }
        return '3e clic gauche : valide l\'anneau — clic droit pour annuler'
    }
    if (state.shapeKind !== undefined) {
        return state.shapeAnchorModel
            ? '2e clic gauche : valide la forme — clic droit pour annuler'
            : '1er clic gauche : pose l\'ancre de la forme — clic droit pour annuler'
    }

    // 2. Triangle partiel : p2 manquant toujours resumable ; p3 manquant
    //    seulement si c'est le activeConstructionTriangle.
    if (lastTri && lastTri.p2 === undefined) {
        return 'Cliquez pour poser le 2e sommet — le 3e clic ferme le triangle'
    }
    if (lastTri && lastTri.p3 === undefined && lastTri === state.activeConstructionTriangle) {
        return 'Cliquez pour poser le 3e sommet — il fermera le triangle'
    }

    // 3. Pinceau : le clic peint le triangle sous le curseur.
    if (state.brushMode) {
        return state.nearestTriangle
            ? 'Clic gauche pour peindre ce triangle avec la couleur choisie'
            : 'Survolez un triangle puis cliquez pour le peindre'
    }

    // 4. Survol d'element, meme ordre de resolution que le clic.
    if (state.selectionMode === 'triangle' && (state.nearestTriangle || state.nearestLine)) {
        return 'Clic gauche pour sélectionner ce triangle — clic droit pour le déplacer'
    }
    if (state.selectionMode === 'segment' && state.nearestLine) {
        return 'Clic gauche pour sélectionner ce segment — clic droit pour le déplacer'
    }
    if (state.nearestPoint) {
        return 'Clic gauche pour sélectionner ce sommet — clic droit pour le déplacer'
    }
    if (state.nearestLine) {
        // Mode vertex : le clic sur un segment branche un nouveau
        // triangle (addPoint -> push-new-tri).
        return 'Clic gauche pour créer un nouveau triangle à partir de ce segment'
    }

    // 5. Zone vide : le post-action finit ses 3 s, sinon message generique.
    if (isActionCommentActive()) return null
    if (tris.length === 0) {
        return 'Cliquez pour poser le 1er point de votre plan'
    }
    return 'Survolez un segment pour y brancher un nouveau triangle — ou cliquez sur un sommet pour le sélectionner'
}

// Diffuse le commentaire de survol (dedup cote showHoverComment) ;
// no-op si la zone vide laisse un post-action finir ses 3 s (null).
const updateHoverComment = () => {
    const text = computeHoverComment()
    if (text === null) return
    showHoverComment(text)
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
    // lastMousePos = position du clic pour que le pointeur survive au repaint.
    state.lastMousePos = mouseScreen
    requestDraw()
}

// Dedup tol 1 px sur le pointList canonique, puis push + assignation
// de l'INDEX dans le slot du tri (invariants I3/I5). Entry historique
// en patch insertPoint (DESIGN §8) : 4 cas atomiques (push | modify-p2
// | modify-p3 | push-new-tri), lastTriAfter construit au saveState.
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

    // Patch construit AVANT la mutation (toutes les entrees connues) ;
    // lastTriIndexBefore = -1 si shape vide, triDelta = 1 si push de
    // tri (0 si modif in-place — le pre-fix < 0 etait ambigu car 0 est
    // un index valide).
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
    // Toast prospectif : guide le geste suivant du triangle en cours.
    const stepComment = {
        push: 'Cliquez pour poser le 2e sommet — le 3e clic ferme le triangle',
        'modify-p2': 'Cliquez pour poser le 3e sommet — il fermera le triangle',
        'modify-p3': 'Cliquez sur un segment pour y brancher un nouveau triangle — Ctrl+Z pour défaire',
        'push-new-tri': 'Cliquez pour poser le 2e sommet de ce nouveau triangle',
    }[action]
    if (stepComment) showActionComment(stepComment)
    persistState()
}

// selectedPoints = tous les indices pointList (1 sommet == 1 entree, I3).
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

// ===== Presse-papiers interne : couper / copier / coller =====
// INTERNE a l'app (pas navigator.clipboard : format modele + fragile
// sous file://). Capture les points selectionnes du PLAN ACTIF +
// les tris ENTIEREMENT contenus (partiels jamais copies), fill
// conserve. Le coller cible le plan actif (coords absolues) avec un
// decalage d'un demi-pas de grille par collage (clipboard.offset) pour
// cascader les copies.

// Capture de la selection : { points, tris } (indices relatifs a la
// liste copiee) ou null si rien a copier.
const captureClipboard = () => {
    if (state.selectedPoints.length === 0) return null
    const shape = activeShape()
    if (!shape) return null
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const selectedSet = new Set(state.selectedPoints)
    const rel = new Map()
    const points = []
    state.selectedPoints.forEach((idx, relIdx) => {
        const p = pointList[idx]
        if (!p) return
        rel.set(idx, relIdx)
        points.push({ x: p.x, y: p.y })
    })
    if (points.length === 0) return null
    const tris = (Array.isArray(shape.tris) ? shape.tris : [])
        .filter(t => Number.isInteger(t.p1) && Number.isInteger(t.p2) && Number.isInteger(t.p3)
            && selectedSet.has(t.p1) && selectedSet.has(t.p2) && selectedSet.has(t.p3)
            // Indice perime (hors pointList) = pas d'image relative -> exclu.
            && rel.has(t.p1) && rel.has(t.p2) && rel.has(t.p3))
        .map(t => ({
            p1: rel.get(t.p1),
            p2: rel.get(t.p2),
            p3: rel.get(t.p3),
            // Le fill survit au copier/coller (propriete du triangle).
            fill: typeof t.fill === 'string' ? t.fill : undefined,
        }))
    return { points, tris }
}

// Copie la selection (selection conservee). Ctrl+C / bouton #copy.
export const copySelection = () => {
    const captured = captureClipboard()
    if (!captured) return false
    state.clipboard = { points: captured.points, tris: captured.tris, offset: 0 }
    log(`Copie : ${captured.points.length} point${captured.points.length > 1 ? 's' : ''}, ${captured.tris.length} triangle${captured.tris.length > 1 ? 's' : ''}`)
    showActionComment(
        `Ctrl+V pour coller dans le plan actif — la sélection est dans le presse-papiers`
    )
    updateClipboardButtons()
    return true
}

// Coupe : copie puis suppression via deleteSelectedPoint (chemin de
// verite unique). Presse-papiers reste rempli. Ctrl+X / bouton #cut.
export const cutSelection = () => {
    const captured = captureClipboard()
    if (!captured) return false
    state.clipboard = { points: captured.points, tris: captured.tris, offset: 0 }
    deleteSelectedPoint()
    updateClipboardButtons()
    log(`Coupe : ${captured.points.length} point${captured.points.length > 1 ? 's' : ''}, ${captured.tris.length} triangle${captured.tris.length > 1 ? 's' : ''}`)
    showActionComment(
        `Ctrl+V pour coller — le contenu est dans le presse-papiers`
    )
    return true
}

// Colle dans le PLAN ACTIF : points appends (decalage GRID_STEP/2 par
// collage), tris re-indexes, copie collée = selection courante. Ctrl+V.
export const pasteClipboard = () => {
    const clip = state.clipboard
    if (!clip || !Array.isArray(clip.points) || clip.points.length === 0) return false
    const shape = activeShape()
    if (!shape) return false
    const shapeIdx = state.activeShapeIndex
    const clonedBefore = cloneShape(shape)
    // Décalage de collage : un demi-pas de grille par collage cumulé
    // (premier collage = +GRID_STEP/2, deuxième = +GRID_STEP, …) pour
    // cascader les copies et les distinguer de la source.
    const shift = (clip.offset + 1) * (state.GRID_STEP / 2)
    const base = (Array.isArray(shape.pointList) ? shape.pointList : []).length
    for (const p of clip.points) {
        shape.pointList.push({ x: p.x + shift, y: p.y + shift })
    }
    const clipTris = Array.isArray(clip.tris) ? clip.tris : []
    for (const t of clipTris) {
        shape.tris.push({
            p1: Number.isInteger(t.p1) ? t.p1 + base : undefined,
            p2: Number.isInteger(t.p2) ? t.p2 + base : undefined,
            p3: Number.isInteger(t.p3) ? t.p3 + base : undefined,
            fill: typeof t.fill === 'string' ? t.fill : undefined,
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
    clip.offset++
    // La copie collée devient la sélection courante (prête à déplacer).
    const pasted = []
    for (let i = 0; i < clip.points.length; i++) pasted.push(base + i)
    state.selectedPoints = pasted
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    updateColorButtonState()
    log(`Collage : ${clip.points.length} point${clip.points.length > 1 ? 's' : ''}, ${clipTris.length} triangle${clipTris.length > 1 ? 's' : ''}`)
    showActionComment(
        `Ctrl+Z pour annuler — la copie collée est sélectionnée, glissez-la pour la déplacer`
    )
    persistState()
    return true
}

// ===== Alignement / répartition des points sélectionnés =====
// 4 actions (cf. DESIGN.md §7.14) : aligner X/Y = les points prennent
// la coord du PREMIER selectionne (ancre, Y/X conserve) ; repartir X/Y
// = espacement uniforme entre les extremes (qui restent en place).
// Une entry undo unique (replaceShapePatch) ; no-op si align < 2 ou
// repartir < 3 points ; boutons grises via updateAlignPanelButtons.

// Aligne les points sélectionnés sur la coordonnée X du premier point
// sélectionné. Retourne true si au moins un point a bougé.
export const alignSelectedPointsX = () => {
    return alignOrDistribute('align', 'x')
}

// Aligne les points sélectionnés sur la coordonnée Y du premier point
// sélectionné. Retourne true si au moins un point a bougé.
export const alignSelectedPointsY = () => {
    return alignOrDistribute('align', 'y')
}

// Répartit uniformément les points sélectionnés selon X entre les deux
// extrêmes (qui restent en place). Retourne true si au moins un point
// a bougé.
export const distributeSelectedPointsX = () => {
    return alignOrDistribute('distribute', 'x')
}

// Répartit uniformément les points sélectionnés selon Y entre les deux
// extrêmes (qui restent en place). Retourne true si au moins un point
// a bougé.
export const distributeSelectedPointsY = () => {
    return alignOrDistribute('distribute', 'y')
}

// Commun align/repartir : ancre = premier selectionne (align), tri par
// coord puis pas egal entre extremes (repartir). Une entry undo par appel.
const alignOrDistribute = (mode, axis) => {
    const shape = activeShape()
    if (!shape) return false
    const selected = state.selectedPoints
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    // Bornes : align >= 2, repartir >= 3.
    const minCount = mode === 'align' ? 2 : 3
    if (selected.length < minCount) return false
    const valid = selected.filter(idx => Number.isInteger(idx) && pointList[idx])
    if (valid.length < minCount) return false

    // Map { idx -> nouvelle coord } calculee sans muter (clone before du patch).
    const target = new Map()
    if (mode === 'align') {
        // Ancre = premier selectionne VALIDE (selected[0] peut etre perime).
        const anchor = pointList[valid[0]]
        if (!anchor) return false
        const anchorCoord = axis === 'x' ? anchor.x : anchor.y
        valid.forEach((idx) => {
            if (idx === valid[0]) return
            target.set(idx, anchorCoord)
        })
    } else {
        // Tri par coord : extremes en place, rangs intermediaires a pas egal.
        const sorted = [...valid].sort((a, b) => (axis === 'x' ? pointList[a].x - pointList[b].x : pointList[a].y - pointList[b].y))
        const n = sorted.length
        const min = axis === 'x' ? pointList[sorted[0]].x : pointList[sorted[0]].y
        const max = axis === 'x' ? pointList[sorted[n - 1]].x : pointList[sorted[n - 1]].y
        if (!(max > min)) return false  // tous les points déjà sur la même coordonnée : rien à répartir
        const step = (max - min) / (n - 1)
        sorted.forEach((idx, i) => {
            if (i === 0 || i === n - 1) return
            target.set(idx, min + step * i)
        })
    }
    if (target.size === 0) return false

    const shapeIdx = state.activeShapeIndex
    const clonedBefore = cloneShape(shape)
    // Mutation réelle (map appliquée sur les coords).
    target.forEach((coord, idx) => {
        if (axis === 'x') pointList[idx].x = coord
        else pointList[idx].y = coord
    })
    const clonedAfter = cloneShape(shape)
    saveState({
        patches: [replaceShapePatch(
            shapeIdx,
            clonedBefore.pointList, clonedBefore.tris,
            clonedAfter.pointList, clonedAfter.tris,
        )],
    })
    const verb = mode === 'align' ? 'Aligne' : 'Repartit'
    const coordLabel = axis === 'x' ? 'X' : 'Y'
    log(`${verb} ${target.size} point${target.size > 1 ? 's' : ''} selon ${coordLabel}`)
    showActionComment(
        `Ctrl+Z pour annuler — Alt+${coordLabel === 'X' ? '→' : '←'}` +
        `${mode === 'distribute' ? ' (avec Maj)' : ''} pour ${mode === 'align' ? 'aligner' : 'répartir'} aussi selon ${coordLabel === 'X' ? 'Y' : 'X'}`
    )
    state.nearestPoint = undefined
    state.nearestLine = undefined
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    persistState()
    return true
}

// ===== Panneau #align (aligner / répartir) =====
// Panneau flottant de 4 actions (meme pattern que #shapesPanel) qui
// reste OUVERT apres une action (enchainer align X puis align Y) ;
// fermeture par re-clic, Echap ou clic exterieur.
export const openAlignPanel = () => {
    const btn = document.querySelector('#align')
    const panel = document.querySelector('#alignPanel')
    if (!btn || !panel) return
    positionPanelUnderButton(btn, panel)
    state.alignPanelOpen = true
    updateAlignButton()
}

export const closeAlignPanel = () => {
    const panel = document.querySelector('#alignPanel')
    if (panel) panel.hidden = true
    state.alignPanelOpen = false
    updateAlignButton()
}

export const toggleAlignPanel = () => {
    if (state.alignPanelOpen) closeAlignPanel()
    else openAlignPanel()
}

// Cablage du panneau #align : bouton (ouvrir/fermer) + 4 actions +
// fermeture au clic exterieur (même pattern que wireShapesPanel).
export const wireAlignPanel = () => {
    const btn = document.querySelector('#align')
    const panel = document.querySelector('#alignPanel')
    if (!btn || !panel) return
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleAlignPanel()
    })
    const actions = {
        alignX: alignSelectedPointsX,
        alignY: alignSelectedPointsY,
        distributeX: distributeSelectedPointsX,
        distributeY: distributeSelectedPointsY,
    }
    Object.keys(actions).forEach((key) => {
        const actionBtn = panel.querySelector(`#${key}`)
        if (!actionBtn) return
        actionBtn.addEventListener('click', (e) => {
            if (e.button !== 0) return
            actions[key]()
        })
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.alignPanelOpen) return
        const target = e.target
        if (!target) return
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        closeAlignPanel()
    })
}

// ===== Creation d'un cercle (outil cercle) =====
// Mode transitoire, geste en 2 temps : 1er clic = centre (snapToGrid),
// mousemove = rayon + angle (sommet 0 vers la souris, l'utilisateur
// peut relacher entre les clics), 2e clic = valide (rayon trop petit
// < CIRCLE_MIN_RADIUS_PX = ignore). Molette = N, Echap = quitte, clic
// droit / Backspace = annule le trace sans desarmer.
export const toggleCircleMode = () => {
    if (state.circleMode) exitCircleMode()
    else enterCircleMode()
}

const enterCircleMode = () => {
    // Exclusion mutuelle (un seul geste de creation actif) + fermeture
    // du panneau #shapes (un seul Echap suffit alors a tout annuler).
    if (state.starMode) exitStarMode()
    if (state.annulusMode) exitAnnulusMode()
    if (state.shapeKind !== undefined) disarmShapeTool()
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
    state.circleOffsetAngle = 0
    // lastMousePos sync : sans lui, un 1er clic sans mouvement
    // ferait disparaître le pointeur au repaint differe.
    state.lastMousePos = mouseScreen
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
    // Angle calcule en COORDS MODEL (Y up) : le vecteur (edge - center)
    // passe par screenToModel pour que le sommet 0 tombe sous la souris
    // a l'ecran (le Y-flip n'est compte qu'une fois, cote modelToScreen).
    // Rayon et angle derivent du meme point snappe (`edge`) — coherence
    // jusqu'au demi-pas de grille pres.
    state.circleOffsetAngle = Math.atan2(
        edge.y - state.circleCenterModel.y,
        edge.x - state.circleCenterModel.x,
    )
    requestDraw()
}

export const commitCircleGesture = (e) => {
    if (!state.circleCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Refraichit rayon + angle sur la position exacte du 2e mousedown.
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

// Commite un cercle : append des points/tris de circleGeometry (indices
// decales de base) + entry replaceShape. offsetAngle oriente le sommet 0.
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
    showActionComment(
        `C pour tracer un autre cercle (molette = côtés) — Ctrl+Z pour annuler`
    )
    // Spec utilisateur : le mode cercle se desactive apres la creation
    // (le bouton est desélectionne) — un cercle = un geste, pas un
    // mode persistant. Le prochain cercle necessite un nouveau clic
    // sur le bouton. exitCircleMode re-log, met a jour le bouton et
    // repaint (requestDraw + updateMouseHover) — il couvre donc le
    // rafraichissement final.
    exitCircleMode()
    persistState()
}
// ===== Creation d'une étoile (mode 3 clics) =====
//
// Mode transitoire calqué sur le mode cercle (meme logique de geste,
// cf. cahier des charges des evolutions) + une phase supplementaire
// pour la profondeur des branches :
//   1. 1er mousedown gauche = pose le centre (snapToGrid comme le
//      cercle), rayon 0, angle 0, phase 0.
//   2. mouvement de la souris (avec ou sans bouton enfonce) = regle
//      rayon + angle de depart. L'angle est calcule en coords MODEL
//      (meme convention que updateCircleGesture) ; +PI/2 compense le
//      -PI/2 canonique de starGeometry pour que le 1er pic (sommet
//      exterieur 0) pointe vers la souris.
//   3. 2e mousedown gauche = VERROUILLE rayon + angle (phase 1) : le
//      mouvement regle alors la profondeur des branches (ratio rayon
//      interne / externe = distance curseur - centre / rayon, clamp
//      STAR_INNER_RATIO_MIN..MAX).
//   4. 3e mousedown gauche = VALIDE l'etoile (rayon + angle +
//      profondeur courants), desarme le mode (comme le cercle).
//
// Echap quitte le mode (sans creer), clic droit / Backspace annulent
// le trace en cours (reinitialise centre + rayon + angle + phase,
// sans desarmer le mode).
export const enterStarMode = () => {
    // Exclusion mutuelle avec le mode cercle / anneau et l'outil
    // forme : un seul geste de creation actif a la fois (meme contrat
    // que enterCircleMode).
    if (state.circleMode) exitCircleMode()
    if (state.annulusMode) exitAnnulusMode()
    if (state.shapeKind !== undefined) disarmShapeTool()
    // Ferme le panneau #shapes s'il est ouvert (meme comportement
    // qu'enterCircleMode) : un seul Echap suffit alors a tout annuler.
    state.shapesPanelOpen = false
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.starMode = true
    state.starCenterModel = undefined
    state.starRadiusModel = 0
    state.starOffsetAngle = 0
    state.starPhase = 0
    state.starInnerRatio = SHAPE_STAR_INNER_RATIO
    state.currentAction = ACTION_NONE
    updateShapesButton()
    log('Mode etoile : 1er clic = centre, mouvement = rayon + angle, 2e clic = verrouille, mouvement = profondeur des branches, 3e clic = valider (Echap = quitter)')
    requestDraw()
}

export const exitStarMode = () => {
    if (!state.starMode) return
    state.starMode = false
    state.starCenterModel = undefined
    state.starRadiusModel = 0
    state.starOffsetAngle = 0
    state.starPhase = 0
    state.starInnerRatio = SHAPE_STAR_INNER_RATIO
    updateShapesButton()
    log('Mode etoile desactive')
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

export const beginStarGesture = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawCenter = screenToModel(mouseScreen)
    const center = state.activeGrid ? snapToGrid(rawCenter) : rawCenter
    state.starCenterModel = { x: center.x, y: center.y }
    state.starRadiusModel = 0
    state.starOffsetAngle = 0
    state.starPhase = 0
    state.starInnerRatio = SHAPE_STAR_INNER_RATIO
    // Sync lastMousePos (meme raison que beginCircleGesture : le
    // drawBoard differe repeint le curseur via renderTransient).
    state.lastMousePos = mouseScreen
    requestDraw()
}

const updateStarGesture = (mouseScreen) => {
    if (!state.starCenterModel) return
    const rawEdge = screenToModel(mouseScreen)
    const edge = state.activeGrid ? snapToGrid(rawEdge) : rawEdge
    const cx = state.starCenterModel.x
    const cy = state.starCenterModel.y
    if (state.starPhase === 0) {
        // Phase 1 : rayon + angle de depart. L'angle est evalue en
        // coords MODEL (meme raisonnement que updateCircleGesture : le
        // Y-flip de modelToScreen n'est compte qu'une fois). +PI/2
        // compense le -PI/2 canonique de starGeometry : le 1er pic
        // (sommet exterieur 0, angle = -PI/2 + offset) tombe pile sous
        // le curseur sur l'ecran.
        state.starRadiusModel = Math.hypot(edge.x - cx, edge.y - cy)
        state.starOffsetAngle = Math.atan2(edge.y - cy, edge.x - cx) + Math.PI / 2
    } else {
        // Phase 2 (apres le 2e clic) : la profondeur des branches suit
        // la distance curseur - centre, normalisee par le rayon
        // verrouille. Au bord (curseur a ~1 rayon) -> etoile plate
        // (ratio ~1) ; vers le centre -> branches profondes. Clamp
        // partage avec starGeometry (STAR_INNER_RATIO_MIN..MAX).
        state.starInnerRatio = state.starRadiusModel > 0
            ? Math.max(STAR_INNER_RATIO_MIN, Math.min(STAR_INNER_RATIO_MAX, Math.hypot(edge.x - cx, edge.y - cy) / state.starRadiusModel))
            : SHAPE_STAR_INNER_RATIO
    }
    requestDraw()
}

export const lockStarRadius = (e) => {
    if (!state.starCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Rafraichit rayon + angle sur la position exacte du 2e mousedown
    // (symetrique avec commitCircleGesture) puis passe en phase 2 : le
    // prochain mouvement reglera la profondeur des branches.
    updateStarGesture(mouseScreen)
    state.starPhase = 1
    requestDraw()
}

export const commitStarGesture = (e) => {
    if (!state.starCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Rafraichit la profondeur sur la position exacte du 3e mousedown
    // au cas ou le curseur aurait bouge entre le dernier mousemove
    // et ce mousedown.
    updateStarGesture(mouseScreen)
    const center = state.starCenterModel
    const radius = state.starRadiusModel
    const offsetAngle = state.starOffsetAngle
    const innerRatio = state.starInnerRatio
    state.starCenterModel = undefined
    state.starRadiusModel = 0
    state.starOffsetAngle = 0
    state.starPhase = 0
    state.starInnerRatio = SHAPE_STAR_INNER_RATIO
    if (radius * state.ctx.zoomLevel < CIRCLE_MIN_RADIUS_PX) {
        log('Etoile ignoree : rayon trop petit')
        requestDraw()
        return
    }
    createStar(center, radius, offsetAngle, innerRatio)
}

export const cancelStarGesture = () => {
    state.starCenterModel = undefined
    state.starRadiusModel = 0
    state.starOffsetAngle = 0
    state.starPhase = 0
    state.starInnerRatio = SHAPE_STAR_INNER_RATIO
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// Commite une étoile dans le plan actif : append du pointList et des
// tris de starGeometry (indices decales du nombre de points deja
// presents) + entry d'historique replaceShape (meme pattern que
// createCircle / deleteSelectedPoint). `offsetAngle` (compense du
// -PI/2, cf. updateStarGesture) et `innerRatio` (profondeur) sont
// transmis tels quels a starGeometry.
export const createStar = (center, radius, offsetAngle = 0, innerRatio = SHAPE_STAR_INNER_RATIO) => {
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedBefore = cloneShape(shape)
    const { pointList, tris } = starGeometry(center, radius, SHAPE_STAR_POINTS, innerRatio, offsetAngle)
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
    log(`Etoile creee : 5 branches, profondeur ${Math.round(innerRatio * 100)}%`)
    showActionComment(
        `Panneau Formes pour une autre étoile (3 clics) — Ctrl+Z pour annuler`
    )
    // Spec utilisateur : le mode étoile se desactive apres la creation
    // (comme le cercle) — une etoile = un geste. exitStarMode re-log,
    // met a jour le bouton et repaint (requestDraw + updateMouseHover).
    exitStarMode()
    persistState()
}
// ===== Creation d'un anneau (cercle perçé d'un trou, mode 3 clics) =====
//
// Mode transitoire calqué sur le mode étoile (meme logique que le
// cercle + un reglage supplementaire au 3e clic, cf. cahier des
// charges des evolutions « création d'un cercle percé d'un trou ») :
//   1. 1er mousedown gauche = pose le centre (snapToGrid comme le
//      cercle), rayon externe 0, angle 0, phase 0.
//   2. mouvement de la souris (avec ou sans bouton enfonce) = regle
//      le rayon EXTERIEUR + l'angle de depart. L'angle est calcule en
//      coords MODEL (meme convention que updateCircleGesture) : le
//      sommet exterieur 0 du futur anneau pointe vers la souris.
//   3. 2e mousedown gauche = VERROUILLE rayon externe + angle
//      (phase 1) : le mouvement regle alors la taille du TROU (ratio
//      rayon interne / externe = distance curseur - centre / rayon
//      externe, clamp ANNULUS_INNER_RATIO_MIN..MAX).
//   4. 3e mousedown gauche = VALIDE l'anneau (rayon externe + angle +
//      trou courants), desarme le mode (comme le cercle).
//
// La molette regle le nombre de cotes (meme compteur que le cercle,
// state.circleSegments — viewport.js onBoardWheel). Echap quitte le
// mode (sans creer), clic droit / Backspace annulent le trace en
// cours (sans desarmer le mode).
export const enterAnnulusMode = () => {
    // Exclusion mutuelle avec le mode cercle / étoile et l'outil forme
    // (un seul geste de creation actif a la fois, meme contrat que
    // enterCircleMode / enterStarMode).
    if (state.circleMode) exitCircleMode()
    if (state.starMode) exitStarMode()
    if (state.shapeKind !== undefined) disarmShapeTool()
    // Ferme le panneau #shapes s'il est ouvert : un seul Echap suffit
    // alors a tout annuler.
    state.shapesPanelOpen = false
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.annulusMode = true
    state.annulusCenterModel = undefined
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = ANNULUS_INNER_RATIO_DEFAULT
    state.currentAction = ACTION_NONE
    updateShapesButton()
    log('Mode anneau : 1er clic = centre, mouvement = rayon externe + angle, 2e clic = verrouille, mouvement = taille du trou, 3e clic = valider (molette = cotes, Echap = quitter)')
    requestDraw()
}

export const exitAnnulusMode = () => {
    if (!state.annulusMode) return
    state.annulusMode = false
    state.annulusCenterModel = undefined
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = ANNULUS_INNER_RATIO_DEFAULT
    updateShapesButton()
    log('Mode anneau desactive')
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

export const beginAnnulusGesture = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const rawCenter = screenToModel(mouseScreen)
    const center = state.activeGrid ? snapToGrid(rawCenter) : rawCenter
    state.annulusCenterModel = { x: center.x, y: center.y }
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = ANNULUS_INNER_RATIO_DEFAULT
    // Sync lastMousePos (meme raison que beginCircleGesture : le
    // drawBoard differe repeint le curseur via renderTransient).
    state.lastMousePos = mouseScreen
    requestDraw()
}

const updateAnnulusGesture = (mouseScreen) => {
    if (!state.annulusCenterModel) return
    const rawEdge = screenToModel(mouseScreen)
    const edge = state.activeGrid ? snapToGrid(rawEdge) : rawEdge
    const cx = state.annulusCenterModel.x
    const cy = state.annulusCenterModel.y
    if (state.annulusPhase === 0) {
        // Phase 1 : rayon externe + angle de depart (meme convention
        // que updateCircleGesture, le Y-flip n'est compte qu'une fois).
        state.annulusOuterRadiusModel = Math.hypot(edge.x - cx, edge.y - cy)
        state.annulusOffsetAngle = Math.atan2(edge.y - cy, edge.x - cx)
    } else {
        // Phase 2 (apres le 2e clic) : la taille du trou suit la
        // distance curseur - centre, normalisee par le rayon externe
        // verrouille. Au bord (curseur a ~1 rayon externe) -> anneau
        // fin (ratio ~1) ; vers le centre -> trou petit (disque plein).
        // Clamp partage avec annulusGeometry (ANNULUS_INNER_RATIO_MIN..MAX).
        state.annulusInnerRatio = state.annulusOuterRadiusModel > 0
            ? Math.max(ANNULUS_INNER_RATIO_MIN, Math.min(ANNULUS_INNER_RATIO_MAX, Math.hypot(edge.x - cx, edge.y - cy) / state.annulusOuterRadiusModel))
            : ANNULUS_INNER_RATIO_DEFAULT
    }
    requestDraw()
}

export const lockAnnulusRadius = (e) => {
    if (!state.annulusCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Rafraichit rayon externe + angle sur la position exacte du 2e
    // mousedown (symetrique avec commitCircleGesture) puis passe en
    // phase 2 : le prochain mouvement reglera la taille du trou.
    updateAnnulusGesture(mouseScreen)
    state.annulusPhase = 1
    requestDraw()
}

export const commitAnnulusGesture = (e) => {
    if (!state.annulusCenterModel) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    // Rafraichit la taille du trou sur la position exacte du 3e
    // mousedown au cas ou le curseur aurait bouge entre le dernier
    // mousemove et ce mousedown.
    updateAnnulusGesture(mouseScreen)
    const center = state.annulusCenterModel
    const outerRadius = state.annulusOuterRadiusModel
    const offsetAngle = state.annulusOffsetAngle
    const innerRatio = state.annulusInnerRatio
    state.annulusCenterModel = undefined
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = ANNULUS_INNER_RATIO_DEFAULT
    if (outerRadius * state.ctx.zoomLevel < CIRCLE_MIN_RADIUS_PX) {
        log('Anneau ignore : rayon trop petit')
        requestDraw()
        return
    }
    createAnnulus(center, outerRadius, offsetAngle, innerRatio)
}

export const cancelAnnulusGesture = () => {
    state.annulusCenterModel = undefined
    state.annulusOuterRadiusModel = 0
    state.annulusOffsetAngle = 0
    state.annulusPhase = 0
    state.annulusInnerRatio = ANNULUS_INNER_RATIO_DEFAULT
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// Commite un anneau dans le plan actif : append du pointList et des
// tris de annulusGeometry (indices decales du nombre de points deja
// presents) + entry d'historique replaceShape (meme pattern que
// createCircle / createStar / deleteSelectedPoint). `offsetAngle`
// (meme convention que le cercle) et `innerRatio` (taille du trou)
// sont transmis tels quels ; le nombre de cotes vient de
// state.circleSegments (compteur partage avec le cercle, reglable a
// la molette en mode anneau).
export const createAnnulus = (center, outerRadius, offsetAngle = 0, innerRatio = ANNULUS_INNER_RATIO_DEFAULT) => {
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedBefore = cloneShape(shape)
    const n = Math.max(3, Math.round(state.circleSegments) || CIRCLE_DEFAULT_SEGMENTS)
    const innerRadius = Math.max(ANNULUS_INNER_RATIO_MIN, Math.min(ANNULUS_INNER_RATIO_MAX, innerRatio)) * outerRadius
    const { pointList, tris } = annulusGeometry(center, outerRadius, innerRadius, n, offsetAngle)
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
    log(`Anneau cree : ${n} cotes, trou ${Math.round(innerRatio * 100)}% du rayon externe`)
    showActionComment(
        `Panneau Formes pour un autre anneau (3 clics) — Ctrl+Z pour annuler`
    )
    // Spec utilisateur : le mode anneau se desactive apres la creation
    // (comme le cercle / l'etoile) — un anneau = un geste. exitAnnulusMode
    // re-log, met a jour le bouton et repaint.
    exitAnnulusMode()
    persistState()
}
// ===== Formes prédéfinies (panneau #shapes) =====
//
// Le bouton #shapes ouvre un panneau flottant (meme pattern que
// #triangleColorPanel : positionne sous le bouton, ferme au clic
// exterieur / Echap) listant des formes prédéfinies : rectangle,
// carre, polygones reguliers (triangle, pentagone, hexagone) et
// etoile. Choisir une forme arme l'outil (bouton en accent vert +
// libellé, panneau ferme) : le geste suit le modele du cercle —
// 1er clic = ancre (1er coin pour rect/carre, centre pour les
// polygones), mouvement = taille ET orientation (angle du sommet 0
// vers la souris pour les polygones reguliers), 2e clic = valide
// (le relâchement du 1er clic ne cree rien). La forme est generee
// (points + triangles) et l'outil desarme (comme le cercle). Echap
// ferme le panneau ou desarme l'outil sans creer ; clic droit /
// Backspace annulent le trace en cours sans desarmer.

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

// Arme l'outil forme : ferme le panneau, attend le geste clic + glisser.
// Reste arme jusqu'a la creation (desarme auto) ou Echap.
export const armShapeTool = (kind) => {
    if (!SHAPE_DEFS[kind]) return
    // Un seul geste de creation actif a la fois : sort des modes cercle/etoile/anneau.
    if (state.circleMode) exitCircleMode()
    if (state.starMode) exitStarMode()
    if (state.annulusMode) exitAnnulusMode()
    state.shapesPanelOpen = false
    const panel = document.querySelector('#shapesPanel')
    if (panel) panel.hidden = true
    state.shapeKind = kind
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    state.shapeOffsetAngle = 0
    state.currentAction = ACTION_NONE
    updateShapesButton()
    log(`Forme armee : ${SHAPE_DEFS[kind].label} (1er clic = ancre, mouvement = taille${kind === 'rect' || kind === 'square' ? '' : ' + orientation'}, 2e clic = valider)`)
    requestDraw()
}

export const disarmShapeTool = () => {
    if (state.shapeKind === undefined) return
    state.shapeKind = undefined
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    state.shapeOffsetAngle = 0
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
    state.shapeOffsetAngle = 0
    // Meme sync que beginCircleGesture : lastMousePos pointe le 1er clic pour
    // que renderTransient repeigne le curseur (visible meme sans mouvement).
    state.lastMousePos = mouseScreen
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
    // Orientation souris des polygones (tri/penta/hexa) : angle en coords
    // MODEL (Y-flip compte une fois) pour que le sommet 0 pointe vers la souris.
    // rect/carre restent axis-aligned.
    if (state.shapeKind !== 'rect' && state.shapeKind !== 'square') {
        state.shapeOffsetAngle = Math.atan2(
            current.y - state.shapeAnchorModel.y,
            current.x - state.shapeAnchorModel.x,
        )
    }
    requestDraw()
}

export const cancelShapeGesture = () => {
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    state.shapeOffsetAngle = 0
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
    const offsetAngle = state.shapeOffsetAngle
    state.shapeAnchorModel = undefined
    state.shapeCurrentModel = undefined
    state.shapeRadiusModel = 0
    state.shapeOffsetAngle = 0
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
        createShape(kind, anchor, undefined, radius, offsetAngle)
    }
}

// Append la geometrie du kind au shape actif + patch replaceShape (meme
// pattern que createCircle), puis desarme (un geste = une forme).
// offsetAngle (defaut 0) oriente le sommet 0 des polygones vers la souris.
export const createShape = (kind, anchor, current, radius, offsetAngle = 0) => {
    const shapeIdx = state.activeShapeIndex
    const shape = activeShape()
    const clonedBefore = cloneShape(shape)
    let geometry
    if (kind === 'rect' || kind === 'square') {
        geometry = rectGeometry(anchor, current)
    } else if (kind === 'star') {
        geometry = starGeometry(anchor, radius, SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO)
    } else if (kind === 'tri') {
        // Triangle = 3 sommets + UN SEUL triangle (pas l'eventail de circleGeometry).
        geometry = triangleGeometry(anchor, radius, offsetAngle)
    } else if (kind === 'annulus') {
        // Branche defensive : SHAPE_DEFS.annulus existe donc un appel direct
        // (tests/console) produit un anneau coherent, pas un 24-gone.
        geometry = annulusGeometry(anchor, radius, ANNULUS_INNER_RATIO_DEFAULT * radius, state.circleSegments, offsetAngle)
    } else {
        const n = { penta: 5, hexa: 6 }[kind]
        geometry = circleGeometry(anchor, radius, n, offsetAngle)
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
    log(`${SHAPE_DEFS[kind].label} cree : ${geometry.pointList.length} points, ${geometry.tris.length} triangle${geometry.tris.length > 1 ? 's' : ''}`)
    showActionComment(
        `Panneau Formes pour une autre forme (2 clics) — Ctrl+Z pour annuler`
    )
    disarmShapeTool()
    persistState()
}

// Cable le panneau #shapes : bouton, boutons formes, fermeture clic exterieur.
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
        } else if (state.starMode) {
            exitStarMode()
        } else if (state.annulusMode) {
            exitAnnulusMode()
        } else {
            openShapesPanel()
        }
    })
    panel.querySelectorAll('button[data-shape]').forEach((shapeBtn) => {
        shapeBtn.addEventListener('click', (e) => {
            if (e.button !== 0) return
            // « Cercle » = mode cercle (raccourci C) ; enterCircleMode ferme le panneau.
            if (shapeBtn.dataset.shape === 'circle') {
                enterCircleMode()
                return
            }
            // « Etoile » = mode 3 clics (profondeur des branches au 3e clic).
            if (shapeBtn.dataset.shape === 'star') {
                enterStarMode()
                return
            }
            // « Anneau » = mode 3 clics : 1er = centre, 2e = rayon + angle,
            // mouvement = taille du trou, 3e = valider.
            if (shapeBtn.dataset.shape === 'annulus') {
                enterAnnulusMode()
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

// findNearest* renvoie des pointIndices ; collectUnderlyingPoints prend
// des coords et renvoie des indices (un seul aller-retour via pointList).
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
    // NB : le spread {...e} ne copie pas les getters du MouseEvent (shiftKey
    // etc.) — re-pose explicite obligatoire pour que le toggle Shift marche.
    // ctrlKey/metaKey forces a false : le geste gauche neutralise Ctrl/Cmd.
    const leftSelectionEvent = { ...e, ctrlKey: false, metaKey: false, shiftKey: e.shiftKey }

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

// coords -> indices pointList correspondants (I3 : pas de doublon).
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

// Match des tris par egalite d'indices sur les 3 slots (O(N)).
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
                // Garde de coherence : ne push i que si ses 3 indices sont dans selectedPoints.
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

// Q1c : 'meme point' = egalite stricte d'indice (I3). Si un indice du
// cluster est deja selectionne, on retire TOUT le cluster ; sinon ajout.
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

// Q1c : pointsAtPos = array d'indices ; ctrlToggles = toggle additif cluster (vertex).
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

// Compacte pointList apres mutation des tris (I2) : retire les points non
// references, re-indexe les slots, renvoie oldIdx -> newIdx.
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
        // Le fill appartient au TRIANGLE : il doit survivre au re-indexage
        // (regression fixee : sa perte effaçait la couleur des tris survivants).
        fill: typeof t.fill === 'string' ? t.fill : undefined,
    }))
    return idxMap
}

// ===== Suppression d'un point =====

// §4.1 : retirer les refs des slots puis compacter (I2) ; les tris avec
// < 2 sommets survivants disparaissent. Emet un replaceShapePatch (DESIGN §8).
export const deleteSelectedPoint = () => {
    const shape = activeShape()
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getIndicesAtSamePosition(state.nearestPoint.point)
    }
    if (targets.length === 0) return

    // Capture pre-mutation (branche BEFORE du patch).
    const shapeIdx = state.activeShapeIndex
    const clonedShapeBefore = cloneShape(shape)
    const pointListBefore = clonedShapeBefore.pointList
    const trisBefore = clonedShapeBefore.tris

    const targetSet = new Set(targets)
    // Un slot egal a une cible devient undefined ; tris < 2 survivants filtres.
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
            // Le fill du tri survive (regression fixee).
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

    // Capture post-mutation + saveState avec patch replaceShape.
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
    showActionComment(
        `Ctrl+Z pour annuler — sélectionnez un point pour le modifier`
    )
    persistState()
}

// ===== Suppression d'un segment (mode 'segment') =====

// §4.1 : supprime les tris dont 2+ slots matchent les endpoints du segment
// (0-1 match = survie). Compacte pointList (I2).
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
    showActionComment(
        `Ctrl+Z pour annuler — cliquez sur un autre segment pour le supprimer`
    )
    persistState()
}

// ===== Suppression d'un triangle (mode 'triangle') =====

// §4.1 : supprime uniquement les tris dont les 3 slots matchent
// (matchCount === 3), pas ceux partageant un seul sommet.
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
    showActionComment(
        `Ctrl+Z pour annuler — cliquez sur un autre triangle pour le supprimer ou le peindre`
    )
    persistState()
}

// ===== Grab (drag) d'un point =====

export const grabbed = () => state.currentAction === ACTION_GRABBING

// Pipeline indices : findNearest* -> collectUnderlyingPoints -> applySelectionModifiers.
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
// §3.6.1 sparse-replace mode-aware : predicat O(N) sur la topologie
// (pointList + tris) pour la parite click/drag WYSIWYG :
// - vertex : tous les indices selectionnes au meme coord (cluster, tol 0.01)
// - segment : <= 1 edge couverte (paire consecutive de slots, endpoints distincts)
// - triangle : <= 1 tri complet (3 slots dans selectedPoints)
// Early return des que covered > 1 ; anti-flicker gere plus bas.
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
        // Une edge partagee entre plusieurs tris reste UN seul segment logique :
        // dedup par paire non ordonnee (min-max), sinon le compteur gonfle a N.
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
    // Filet defensif : efface tout _pendingGrabPatch orphelin d'un grab
    // interrompu (sinon il serait committe a tort par un grab futur).
    state._pendingGrabPatch = null
    // Efface le candidat de fusion périmé du drag precedent (§7.11).
    state.mergeDropCandidate = undefined

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
        log(`AltGr detecte - deplacement de ${state.shapes.length} plan(s) : ${state.grabbedGroup.length} points`)
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

    // §3.6.1 sparse-replace WYSIWYG : parite click/drag, invariant I4
    // respecte (la detection n'insere aucun index).
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

    // Drag droit : deplace la selection commitee en groupe (le cas sparse
    // a deja ete remplace ci-dessus §3.6.1).
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

    // Shift conserve le comportement historique de selection cible (Ctrl traite plus haut).
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

// ===== Fusion par déplacement (2e fonction de #mergePoints) =====
// §7.11 : pendant un drag armé (1 point sélectionné), calcule a chaque
// tick le candidat cible (point le plus proche dans le rayon mergeDropRadius,
// px ecran via modelToleranceForPixels). Stocke dans state.mergeDropCandidate
// (indice pointList, undefined = aucun) : renderTransient l'affiche en
// anneau orange, merge.js.attemptDropMerge le consomme au relachement.
const mergeDropRadiusModel = () => modelToleranceForPixels(state.mergeDropRadius)
const updateMergeDropCandidate = () => {
    state.mergeDropCandidate = undefined
    if (!state.mergeOnDropActive || state.selectedPoints.length !== 1) return
    const idx = state.selectedPoints[0]
    const shape = activeShape()
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const dragged = pointList[idx]
    if (!dragged) return
    const limit = mergeDropRadiusModel()
    let best = undefined
    for (let i = 0; i < pointList.length; i++) {
        if (i === idx) continue
        const p = pointList[i]
        if (!p) continue
        const d = Math.hypot(p.x - dragged.x, p.y - dragged.y)
        if (d <= limit && (!best || d < best.d)) best = { i, d }
    }
    state.mergeDropCandidate = best ? best.i : undefined
}

// Structure d'entree : {shapeIndex, pointIndex, triangleIndex, slotId, startX, startY}.
// Coherence avec selectedPoints par construction (mutation directe de pointList[idx]).
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

    // (delta) commit le patch deferred capture a la 1re tick de mouvement
    // significatif ; l'AFTER est resolu ici depuis le live state.
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
    // Retourne true si le geste a réellement déplacé la géométrie (vs
    // clic droit de sélection) : main.js s'en sert pour la fusion par
    // déplacement (§7.11), jamais sur un clic droit simple.
    return movedScene
}

export const resolveMouseMoveOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }

    // Kiosque : le pointeur pilote l'inclinaison des cartes (focus),
    // aucun hit-test d'edition ; requestDraw pour le tilt en direct.
    if (state.kioskMode) {
        state.lastMousePos = mouseScreen
        requestDraw()
        return
    }

    // Mode cercle : le glisser regle le rayon (preview dans
    // renderTransient). La garde !previewMode laisse la molette zoomer.
    if (state.circleMode && !state.previewMode) {
        updateCircleGesture(mouseScreen)
        state.lastMousePos = mouseScreen
        updateMouseHover(mouseScreen)
        return
    }
    // Mode étoile (3 clics) : le glisser regle rayon + angle (phase 1)
    // puis la profondeur des branches (phase 2). Même pattern que le cercle.
    if (state.starMode && !state.previewMode) {
        updateStarGesture(mouseScreen)
        state.lastMousePos = mouseScreen
        updateMouseHover(mouseScreen)
        return
    }
    // Mode anneau (3 clics) : le glisser regle rayon externe + angle
    // (phase 1) puis la taille du trou (phase 2). Même pattern que le cercle.
    if (state.annulusMode && !state.previewMode) {
        updateAnnulusGesture(mouseScreen)
        state.lastMousePos = mouseScreen
        updateMouseHover(mouseScreen)
        return
    }
    // Forme armee : le glisser regle la taille (coin oppose pour
    // rect/carre, rayon pour les polygones). Même pattern que le cercle.
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
            // Q1c : selection lasso = array d'indices dans le pointList
            // canonique (I3 respecte : pas de doublon intra-coord).
            const inBoxIndices = []
            for (let i = 0; i < pointList.length; i++) {
                const p = pointList[i]
                if (!p) continue
                if (p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM) inBoxIndices.push(i)
            }
            state.selectedPoints = inBoxIndices
            // (perf) sceneDirty leve ici pour invalider le cache offscreen
            // (selection mute pendant le drag du lasso) ; le rAF interne a
            // requestDraw coalesce les ticks de drag en 1 paint / frame.
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
                // (delta) movePointsPatch *deferred* : BEFORE capture ici
                // (startX/startY de chaque item), AFTER resolu au mouseup.
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
            // (perf) sceneDirty leve ici pour invalider le cache offscreen
            // (positions des points drags mutees a la volee) ; le rAF interne
            // a requestDraw coalesce les ticks de drag en 1 paint / frame.
            requestDraw()
            // (§7.11) candidat cible du drag armé : recalculé a chaque tick
            // pour suivre le point déplacé (le dernier tick de endGrabbing
            // laisse le candidat a la position finale, lue par attemptDropMerge).
            updateMergeDropCandidate()
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

// Q2c : l'item porte un pointIndex direct ; on mute pointList[pointIndex]
// en place (couvre tous les slots partageant cet indice en O(1)).
const applyGrabToPoint = (item, targetPos) => {
    const shape = state.shapes[item.shapeIndex]
    if (!shape || !Array.isArray(shape.pointList)) return
    const pt = shape.pointList[item.pointIndex]
    if (!pt) return
    pt.x = targetPos.x
    pt.y = targetPos.y
}

// ===== Rotation runtime =====

// La rotation opere sur le pointList canonique (Q1a) : une seule
// mutation par sommet logique (au lieu de N mutations sur les slots).
//
// (delta) patch movePoints *deferred* sur tous les points : BEFORE a la
// 1re tick, AFTER au commit (debounce 400 ms). Gros patch (~5 N points)
// mais ≪ full cloneScene qui clonerait aussi les tris.
export const rotateEachShapeAroundPivot = (pivotModel, angle) => {
    if (!state.shapes || state.shapes.length === 0) return
    if (!state.isEachShapeRotating) {
        // Capture BEFORE pour movePoints deferred (tous les points,
        // avant le 1er tick de rotation).
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
        log('AltGr + molette detecte - rotation de chaque plan autour du curseur (5 deg/tick)')
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

// Q1c : selectedPoints = array d'indices ; on mute directement
// pointList[idx] — O(N) au lieu de O(M*N) en tri*slots.
//
// (delta) movePoints deferred sur selectedPoints : BEFORE a la 1re tick,
// commit au debounce du wheel timer (patch compact O(N) ≪ cloneScene).
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
            // Commentaire au COMMIT du geste (le debounce est reset par
            // chaque tick, le message ne partirait jamais sinon).
            showActionComment(
                `Molette pour continuer à pivoter — Ctrl+Z pour annuler`
            )
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

// Bascule la classe .swatch-active sur l'element data-index du
// conteneur (dataIndex null = retire partout). Centralise la sequence
// « retirer partout, ajouter sur un » de showTriangleColorPanel +
// buildColorSwatches + wireTriangleColorPanel.
const setActiveSwatch = (host, dataIndex) => {
    if (!host) return
    host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-active'))
    if (dataIndex === null || dataIndex === undefined) return
    const target = host.querySelector('.swatch[data-index="' + String(dataIndex) + '"]')
    if (target) target.classList.add('swatch-active')
}

// ===== Palette persistee et editable + opacite unique (cf. DESIGN.md §7.3.1 / §7.3.2) =====
//
// La palette des triangles est une PREFERENCE utilisateur : initialisee
// aux presets historiques, restauree au boot depuis localStorage,
// re-ecrite a chaque mutation. Ajouter (#colorPaletteAdd), retirer
// (clic droit, garde >= 1 couleur), modifier (double-clic = edition en
// direct, Entree valide / Echap annule), restaurer (#colorPaletteRestore).
//
// La palette ne stocke QUE des couleurs (bg hex). L'opacite de
// peinture est UNIQUE et GLOBALE (state.colorAlpha, curseur #colorAlpha) :
// le fill de chaque couleur est derive de (bg, colorAlpha) par
// triangleFillFromBg et applique a CHAQUE peinture (cf. §7.3.2).

// Sync le curseur #colorAlpha avec une valeur [0,1] (valeur du range +
// libelle % + state.colorAlpha). N'ecrit PAS localStorage : seule la
// manipulation MANUELLE du curseur persiste (cf. persistColorAlpha).
const setColorAlphaSlider = (alpha) => {
    const a = Math.max(0, Math.min(1, alpha))
    state.colorAlpha = a
    const slider = document.querySelector('#colorAlpha')
    const label = document.querySelector('#colorAlphaValue')
    const pct = Math.round(a * 100)
    if (slider) slider.value = String(pct)
    if (label) label.textContent = pct + '%'
}

// Lit l'opacite de travail courante [0,1] (valeur absente / non-finite
// = defaut).
const getColorAlphaSlider = () => {
    const a = state.colorAlpha
    return typeof a === 'number' && Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : TRIANGLE_COLOR_DEFAULT_ALPHA
}

// Persiste l'opacite de travail comme PREFERENCE. Appele UNIQUEMENT sur
// un reglage MANUEL du curseur : cliquer un swatch ou annuler une
// edition affiche une autre opacite sans ecraser la preference.
const persistColorAlpha = () => {
    try {
        localStorage.setItem(COLOR_ALPHA_STORAGE_KEY, JSON.stringify(getColorAlphaSlider()))
    } catch (e) { /* ignore */ }
}

// Recalcule le fill de TOUTES les entrees de la palette a l'opacite
// de travail courante (la palette ne stocke que des bg ; le fill est
// derive de (bg, colorAlpha)). Appele a chaque drag du curseur et au boot.
const refreshPaletteFills = () => {
    const a = getColorAlphaSlider()
    state.colorPalette.forEach(p => { p.fill = triangleFillFromBg(p.bg, a) })
}

// Valide une entree persistee : hex #rrggbb (courant + legacy) ou
// objet { bg: hex } (les anciennes clefs { bg, alpha } sont acceptees,
// l'alpha ignore : l'opacite est globale, pas par swatch).
const isValidPaletteEntry = (c) => {
    if (typeof c === 'string') return /^#[0-9a-f]{6}$/i.test(c)
    return !!c && typeof c === 'object' && typeof c.bg === 'string' &&
        /^#[0-9a-f]{6}$/i.test(c.bg)
}

// Convertit une entree persistee en { bg, fill } : fill derive au
// chargement a l'opacite de travail courante (jamais persiste).
const toPaletteEntry = (c) => {
    const bg = typeof c === 'string' ? c : c.bg
    return { bg, fill: triangleFillFromBg(bg, getColorAlphaSlider()) }
}

// Restaure palette ET opacite depuis localStorage. L'opacite est
// restauree EN PREMIER (les fills de la palette en sont derives). Cle
// absente / JSON invalide / liste mal formee = defaults presets.
export const restoreColorPalette = () => {
    try {
        const raw = localStorage.getItem(COLOR_ALPHA_STORAGE_KEY)
        if (raw !== null) {
            const a = Number(raw)
            if (Number.isFinite(a)) setColorAlphaSlider(a)
        }
    } catch (e) { /* ignore */ }
    let palette = TRIANGLE_COLOR_PRESETS.map(p => ({ bg: p.bg, fill: triangleFillFromBg(p.bg, getColorAlphaSlider()) }))
    try {
        const raw = localStorage.getItem(COLOR_PALETTE_STORAGE_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isValidPaletteEntry)) {
                palette = parsed.map(toPaletteEntry)
            }
        }
    } catch (e) { /* ignore */ }
    state.colorPalette = palette
}

// Ecrit la palette (liste des bg hex) dans localStorage. Le fill n'est
// jamais persiste. Pas de debounce : les edits sont des actions discretes.
export const persistColorPalette = () => {
    try {
        localStorage.setItem(COLOR_PALETTE_STORAGE_KEY, JSON.stringify(state.colorPalette.map(p => p.bg)))
    } catch (e) { /* ignore */ }
}

// Termine le mode edition : nettoie l'index et la surbrillance
// .swatch-editing, sans toucher a la couleur (deja commitee en direct).
const endPaletteEdit = () => {
    if (state.colorPaletteEditingIndex == null) return
    state.colorPaletteEditingIndex = undefined
    state.colorPaletteEditingBefore = undefined
    const host = document.querySelector('#triangleColorSwatches')
    if (host) host.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch-editing'))
}

// Annule le mode edition (Echap) : retour a la couleur d'origine,
// resync du pinceau (sans elle, le pinceau garderait la couleur
// annulee alors que le swatch affiche la couleur d'origine).
export const cancelPaletteEdit = () => {
    const idx = state.colorPaletteEditingIndex
    const before = state.colorPaletteEditingBefore
    if (idx != null && before && state.colorPalette[idx]) {
        const entry = state.colorPalette[idx]
        entry.bg = before
        refreshPaletteFills()
        state.brushColor = entry.fill
        const host = document.querySelector('#triangleColorSwatches')
        const sw = host && host.querySelector('.swatch[data-index="' + String(idx) + '"]')
        if (sw) sw.style.backgroundColor = entry.fill
        const input = document.querySelector('#triangleColorInput')
        if (input) input.value = before
        persistColorPalette()
    }
    endPaletteEdit()
    log('Edition de couleur annulee')
}

// Entre en mode edition sur le swatch `index` (double-clic) : le
// picker reflete sa couleur, le pinceau est arme, chaque input met a
// jour le swatch en direct. Le curseur d'opacite n'est PAS touche
// (opacite globale, §7.3.2).
const startPaletteEdit = (index) => {
    const entry = state.colorPalette[index]
    if (!entry) return
    endPaletteEdit()
    state.colorPaletteEditingIndex = index
    state.colorPaletteEditingBefore = entry.bg
    state.brushColor = entry.fill
    state.brushMode = true
    const input = document.querySelector('#triangleColorInput')
    if (input) {
        input.value = entry.bg
        input.focus()
    }
    const host = document.querySelector('#triangleColorSwatches')
    setActiveSwatch(host, index)
    if (host) {
        const target = host.querySelector('.swatch[data-index="' + String(index) + '"]')
        if (target) target.classList.add('swatch-editing')
    }
    log('Edition de la couleur ' + index + ' : modifiez le picker, Entree valide, Echap annule')
    updateColorButtonState()
}

// Ajoute la couleur courante du picker comme nouveau swatch (dedup
// case-insensitive sur le bg : deja presente = no-op arme). Persiste
// puis rearme le pinceau sur la nouvelle entree.
const addPaletteColorFromPicker = () => {
    const input = document.querySelector('#triangleColorInput')
    if (!input) return
    const hex = input.value
    const exists = state.colorPalette.some(p => p.bg.toLowerCase() === hex.toLowerCase())
    if (exists) {
        state.brushColor = triangleFillFromBg(hex, getColorAlphaSlider())
        state.brushMode = true
        log('Couleur deja dans la palette : ' + hex)
        updateColorButtonState()
        return
    }
    state.colorPalette.push({ bg: hex, fill: triangleFillFromBg(hex, getColorAlphaSlider()) })
    persistColorPalette()
    const host = document.querySelector('#triangleColorSwatches')
    buildColorSwatches()
    const newIndex = state.colorPalette.length - 1
    state.brushColor = state.colorPalette[newIndex].fill
    state.brushMode = true
    setActiveSwatch(host, newIndex)
    log('Couleur ajoutee a la palette : ' + hex)
    updateColorButtonState()
}

// Retire le swatch `index` (clic droit). Garde : impossible de retirer
// la DERNIERE couleur. Rearme le pinceau sur la couleur suivante.
const removePaletteColor = (index) => {
    if (state.colorPalette.length <= 1) {
        log('Retrait impossible : gardez au moins une couleur dans la palette')
        return
    }
    if (state.colorPaletteEditingIndex === index) endPaletteEdit()
    state.colorPalette.splice(index, 1)
    persistColorPalette()
    const host = document.querySelector('#triangleColorSwatches')
    buildColorSwatches()
    const activeIdx = Math.min(index, state.colorPalette.length - 1)
    const entry = state.colorPalette[activeIdx]
    if (entry) {
        state.brushColor = entry.fill
        state.brushMode = true
        setActiveSwatch(host, activeIdx)
    }
    log('Couleur retiree de la palette')
    updateColorButtonState()
}

// Revient aux 8 presets d'origine (bouton #colorPaletteRestore).
// L'opacite de travail n'est PAS touchee : « Defauts » restaure les
// COULEURS, pas la preference d'opacite (cf. §7.3.2).
const restoreDefaultPalette = () => {
    state.colorPalette = TRIANGLE_COLOR_PRESETS.map(p => ({ bg: p.bg }))
    // Fills derives a l'opacite de travail courante (meme chemin que refreshPaletteFills).
    refreshPaletteFills()
    endPaletteEdit()
    persistColorPalette()
    const host = document.querySelector('#triangleColorSwatches')
    buildColorSwatches()
    const first = state.colorPalette[0]
    if (first) {
        state.brushColor = first.fill
        state.brushMode = true
        setActiveSwatch(host, 0)
        const input = document.querySelector('#triangleColorInput')
        if (input) input.value = first.bg
    }
    log('Palette restauree aux couleurs par defaut')
    updateColorButtonState()
}

// (evolution peinture) le panneau est un toggle panel : a l'ouverture le
// pinceau est arme avec le 1er preset (peinture immediate) ; clic swatch
// / picker = maj brushColor ; Reset = desarme le pinceau (panneau ouvert) ;
// fermeture = panneau cache + brushMode false + brushColor undefined.
// Le bouton est TOUJOURS interactif (plus de garde disabled).
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
    // Pre-armement du pinceau avec le 1er preset (swatch .swatch-active,
    // picker resynchronise) : peinture immediate a l'ouverture, a
    // l'opacite de travail courante (cf. §7.3.2).
    positionPanelUnderButton(btn, panel)
    state.isTriangleColorPanelOpen = true
    btn.classList.add('color-panel-open')
    const firstPreset = state.colorPalette[0]
    if (!firstPreset) return
    // Arme le pinceau avec le 1er preset A L'OPACITE DE TRAVAIL courante
    // (et non l'alpha du preset) : l'opacite de l'utilisateur survit a
    // chaque ouverture — garantie « l'opacite reste a la derniere valeur ».
    state.brushColor = triangleFillFromBg(firstPreset.bg, getColorAlphaSlider())
    state.brushMode = true
    setActiveSwatch(document.querySelector('#triangleColorSwatches'), 0)
    const input = document.querySelector('#triangleColorInput')
    if (input) input.value = firstPreset.bg
    // Le curseur DOM est deja aligne sur state.colorAlpha (restaure au
    // boot / synchronise par setColorAlphaSlider) — pas de resync ici.
    updateColorButtonState()
}

export const hideTriangleColorPanel = () => {
    const panel = document.querySelector('#triangleColorPanel')
    const btn = document.querySelector('#triangleColor')
    if (panel) panel.hidden = true
    state.isTriangleColorPanelOpen = false
    // Palette fermee → pinceau desarme + brushColor purge (prochain show
    // repart d'un etat vierge). Une edition en cours est abandonnee.
    endPaletteEdit()
    state.brushMode = false
    state.brushColor = undefined
    if (btn) btn.classList.remove('color-panel-open')
    updateColorButtonState()
}

// Peint un seul triangle (index de tri, sans dependre d'une selection).
// Memes garde-fous que applyColorToSelectedTriangles : capture BEFORE/
// AFTER fills -> patch setFills compact + mutation live de t.fill. Si
// color est undefined / TRIANGLE_COLOR_CLEAR, on efface le fill.
const paintSingleTriangle = (triangleIndex, color) => {
    if (!state.shapes || !state.shapes[state.activeShapeIndex]) return
    const tris = state.shapes[state.activeShapeIndex].tris
    if (!Array.isArray(tris) || triangleIndex < 0 || triangleIndex >= tris.length) return
    const tri = tris[triangleIndex]
    if (!tri) return
    // (Q2c) on ne peint que des tris « complets » (slots entiers).
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
    // Signal de divergence de la scene vs baseline (remis a 0 par io.js).
    state.ctx.workIsSaved = 0
    requestDraw()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    persistState()
}

// (evolution peinture) clic gauche en mode pinceau : applique brushColor
// au triangle le plus proche (memes criteres que findNearestTriangle).
// Le mousedown global de main.js return tot apres l'appel. Zone vide =
// noop : le pinceau ne touche pas a la selection courante.
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
    showActionComment(`Ctrl+Z pour annuler — cliquez sur un autre triangle pour le peindre`)
}

// Construit les swatches depuis state.colorPalette. Trois gestes :
// clic gauche = arme le pinceau (+ fin d'edition), clic droit = retire
// la couleur, double-clic = mode edition (picker reflete la couleur).
const buildColorSwatches = () => {
    const host = document.querySelector('#triangleColorSwatches')
    if (!host) return
    while (host.firstChild) host.removeChild(host.firstChild)
    state.colorPalette.forEach((preset, i) => {
        const sw = document.createElement('button')
        sw.type = 'button'
        sw.className = 'swatch'
        // Le swatch affiche le fill (bg a l'opacite de travail courante) :
        // apercu WYSIWYG de la peinture (recalcule par refreshPaletteFills).
        sw.style.backgroundColor = preset.fill
        sw.title = 'Peindre avec ' + preset.bg + ' — clic droit : retirer de la palette, double-clic : modifier'
        sw.dataset.index = String(i)
        sw.addEventListener('click', (e) => {
            if (e.button !== 0) return
            // Arme le pinceau avec la couleur choisie (la selection est
            // orthogonale au pinceau : pas de peinture automatique).
            // L'opacite n'est PAS touchee (cf. §7.3.2).
            state.brushColor = preset.fill
            state.brushMode = true
            setActiveSwatch(host, i)
            const input = document.querySelector('#triangleColorInput')
            if (input) input.value = preset.bg
            endPaletteEdit()
            updateColorButtonState()
        })
        sw.addEventListener('contextmenu', (e) => {
            e.preventDefault()
            removePaletteColor(i)
        })
        sw.addEventListener('dblclick', (e) => {
            e.preventDefault()
            startPaletteEdit(i)
        })
        host.appendChild(sw)
    })
}

export const wireTriangleColorPanel = () => {
    const btn = document.querySelector('#triangleColor')
    const panel = document.querySelector('#triangleColorPanel')
    const input = document.querySelector('#triangleColorInput')
    const resetBtn = document.querySelector('#triangleColorReset')
    const addBtn = document.querySelector('#colorPaletteAdd')
    const restoreBtn = document.querySelector('#colorPaletteRestore')
    const alphaSlider = document.querySelector('#colorAlpha')
    const alphaLabel = document.querySelector('#colorAlphaValue')
    if (!btn || !panel || !input || !resetBtn || !addBtn || !restoreBtn || !alphaSlider || !alphaLabel) return
    buildColorSwatches()
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        toggleTriangleColorPanel()
    })
    input.addEventListener('input', () => {
        // Deux chemins : mode edition = maj EN DIRECT du swatch (persiste
        // a chaque tick) ; hors edition = arme le pinceau directement.
        // L'opacite de travail s'applique toujours (cf. §7.3.2).
        state.brushMode = true
        if (state.colorPaletteEditingIndex != null && state.colorPalette[state.colorPaletteEditingIndex]) {
            const entry = state.colorPalette[state.colorPaletteEditingIndex]
            entry.bg = input.value
            entry.fill = triangleFillFromBg(input.value, getColorAlphaSlider())
            state.brushColor = entry.fill
            const host = document.querySelector('#triangleColorSwatches')
            const sw = host && host.querySelector('.swatch[data-index="' + String(state.colorPaletteEditingIndex) + '"]')
            if (sw) sw.style.backgroundColor = entry.fill
            persistColorPalette()
        } else {
            state.brushColor = triangleFillFromBg(input.value, getColorAlphaSlider())
        }
        // Swatch actif = celui dont le .bg matche le picker (case-insensitive) ;
        // couleur libre hors palette = tous les swatches desactives.
        const matchIdx = state.colorPalette.findIndex(p => p.bg.toLowerCase() === input.value.toLowerCase())
        setActiveSwatch(document.querySelector('#triangleColorSwatches'), matchIdx >= 0 ? matchIdx : null)
        updateColorButtonState()
    })
    input.addEventListener('keydown', (e) => {
        if (state.colorPaletteEditingIndex == null) return
        if (e.key === 'Enter') {
            e.preventDefault()
            endPaletteEdit()
            log('Couleur modifiee dans la palette')
        }
        // Echap est gere au niveau document (main.js) : annule
        // l'edition sans fermer le panneau.
    })
    // (evolution opacite unique, §7.3.2) Le curseur regle l'opacite
    // GLOBALE : a chaque drag, recalcule les fills de la palette (apercu
    // WYSIWYG), arme le pinceau a la nouvelle opacite, et persiste la
    // preference (UNIQUEMENT ici — reglage MANUEL, les syncs d'affichage
    // ne doivent pas ecraser la preference).
    alphaSlider.addEventListener('input', () => {
        const pct = parseInt(alphaSlider.value, 10)
        const alpha = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : TRIANGLE_COLOR_DEFAULT_ALPHA
        setColorAlphaSlider(alpha)
        persistColorAlpha()
        refreshPaletteFills()
        buildColorSwatches()
        state.brushMode = true
        state.brushColor = triangleFillFromBg(input.value, alpha)
        const host = document.querySelector('#triangleColorSwatches')
        // Le rebuild des swatches efface les surbrillances : on restaure
        // le swatch ACTIF et la surbrillance d'edition le cas echeant
        // (l'edition porte sur la couleur, pas l'opacite).
        const matchIdx = state.colorPalette.findIndex(p => p.bg.toLowerCase() === input.value.toLowerCase())
        setActiveSwatch(host, matchIdx >= 0 ? matchIdx : null)
        if (host && state.colorPaletteEditingIndex != null) {
            const target = host.querySelector('.swatch[data-index="' + String(state.colorPaletteEditingIndex) + '"]')
            if (target) target.classList.add('swatch-editing')
        }
        updateColorButtonState()
    })
    resetBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        // (evolution peinture) Reset = desarmer le pinceau (NE PAS
        // appliquer TRIANGLE_COLOR_CLEAR a la selection). Panneau reste
        // ouvert, swatches desactives, picker remis a la 1re couleur.
        // Termine aussi une edition. Pas de mutation de la scene ici.
        endPaletteEdit()
        state.brushMode = false
        state.brushColor = undefined
        setActiveSwatch(document.querySelector('#triangleColorSwatches'), null)
        // Reset ne touche pas au curseur d'opacite (cf. §7.3.2).
        if (state.colorPalette[0]) input.value = state.colorPalette[0].bg
        updateColorButtonState()
    })
    // (evolution palette persitee) Ajouter : enregistre la couleur
    // courante du picker comme nouveau swatch de la palette.
    addBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        addPaletteColorFromPicker()
    })
    // (evolution palette persitee) Defauts : restaure les 8 presets
    // d'origine (ecrase la palette persitee).
    restoreBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        restoreDefaultPalette()
    })
    document.addEventListener('mousedown', (e) => {
        if (!state.isTriangleColorPanelOpen) return
        const target = e.target
        if (!target) return
        if (panel.contains(target)) return
        if (btn.contains(target)) return
        // Un clic sur un tri declenche paintTriangleAtCursor : on NE ferme
        // PAS le panneau (peinture en chaine). Un clic exterieur ferme.
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
