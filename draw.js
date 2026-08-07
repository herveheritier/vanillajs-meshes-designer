import { state } from './state.js'
import { modelToScreen, screenToModel, getMultiPointIndices } from './geometry.js'
import {
    TAU,
    ACTION_GRABBING,
    COLOR_AXIS,
    COLOR_LINES,
    COLOR_LINES_INACTIVE,
    CANVAS_BACKGROUND,
    COLOR_CURSOR,
    COLOR_RETICLE,
    COLOR_GRID,
    POINT_COLOR_ACTIVE,
    POINT_COLOR_INACTIVE,
    COLOR_TRIANGLE_FILL_ACTIVE,
    COLOR_SELECTED_POINT,
    COLOR_SELECTED_POINT_DIMMED,
    COLOR_MULTI_POINT,
    MULTI_POINT_RADIUS,
    COLOR_SELECTION_BOX_FILL,
    COLOR_SELECTION_BOX_STROKE,
    COLOR_CIRCLE_PREVIEW,
    SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO, STAR_INNER_RATIO_MIN, STAR_INNER_RATIO_MAX,
    ANNULUS_INNER_RATIO_MIN, ANNULUS_INNER_RATIO_MAX,
    PATTERN_AXIS,
    PATTERN_LINES,
    PATTERN_LINES_INACTIVE,
} from './constants.js'

export const drawPoint = (p, radius = 3, color = '#FFFFFF') => {
    if (!p) return
    let sp = modelToScreen(p)
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, radius, 0, TAU)
    state._ctx.stroke()
}

// ===== Performance : drawPointsBatch =====
// Factorise N drawPoint en un seul beginPath + N sub-paths + 1 stroke
// (opt #1). moveTo avant chaque arc : arc() ne reset pas le current
// point, sans lui le path tracerait une ligne parasite entre centres.
export const drawPointsBatch = (points, radius, color) => {
    if (!points || points.length === 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!p) continue
        const sp = modelToScreen(p)
        state._ctx.moveTo(sp.x, sp.y)
        state._ctx.arc(sp.x, sp.y, radius, 0, TAU)
    }
    state._ctx.stroke()
}

// Le curseur est peint ici (le board a `cursor: none`) ; en mode
// pinceau, disque de la couleur courante + ring blanc lisible sur
// fond noir ou deja colore.
const BRUSH_CURSOR_RADIUS = 7
export const drawMouse = (p) => {
    if (!p) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_CURSOR
    state._ctx.beginPath()
    state._ctx.arc(p.x, p.y, 3, 0, TAU)
    state._ctx.stroke()
    if (state.brushMode && typeof state.brushColor === 'string') {
        state._ctx.beginPath()
        state._ctx.fillStyle = state.brushColor
        state._ctx.arc(p.x, p.y, BRUSH_CURSOR_RADIUS, 0, TAU)
        state._ctx.fill()
        state._ctx.strokeStyle = '#ffffff'
        state._ctx.lineWidth = 1
        state._ctx.stroke()
    }
}

// Pill sombre avec l'index du vertex survole (cf. §7.8), sous le point (Y+14).
const VERTEX_LABEL_OFFSET_Y = 14
const VERTEX_LABEL_HEIGHT = 14
const VERTEX_LABEL_PADDING_X = 6
const VERTEX_LABEL_FONT = '10px monospace'
const VERTEX_LABEL_COLOR = '#FFFFFF'
const VERTEX_LABEL_BACKGROUND = 'rgba(0, 0, 0, 0.6)'
export const drawVertexLabel = (p, label) => {
    if (!p || label === undefined || label === null) return
    const sp = modelToScreen(p)
    state._ctx.font = VERTEX_LABEL_FONT
    state._ctx.textAlign = 'center'
    state._ctx.textBaseline = 'middle'
    const text = String(label)
    const w = state._ctx.measureText(text).width + VERTEX_LABEL_PADDING_X * 2
    const x0 = sp.x - w / 2
    const y0 = sp.y + VERTEX_LABEL_OFFSET_Y - VERTEX_LABEL_HEIGHT / 2
    state._ctx.fillStyle = VERTEX_LABEL_BACKGROUND
    state._ctx.fillRect(x0, y0, w, VERTEX_LABEL_HEIGHT)
    state._ctx.fillStyle = VERTEX_LABEL_COLOR
    state._ctx.fillText(text, sp.x, sp.y + VERTEX_LABEL_OFFSET_Y)
}

// Slots triangles partageant le sommet survole (cf. §7.9) : pill 2 lignes sous le label.
const STACK_LIST_OFFSET_Y = 32
const STACK_LIST_HEIGHT = 14
const STACK_LIST_PADDING_X = 6
const STACK_LIST_PADDING_Y = 4
const STACK_LIST_FONT = '10px monospace'
const STACK_LIST_HEADER_COLOR = '#FFD700'
const STACK_LIST_BODY_COLOR = '#FFFFFF'
const STACK_LIST_BACKGROUND = 'rgba(0, 0, 0, 0.7)'
export const drawStackList = (p, refs) => {
    if (!p || !Array.isArray(refs) || refs.length === 0) return
    const sp = modelToScreen(p)
    state._ctx.font = STACK_LIST_FONT
    state._ctx.textAlign = 'center'
    state._ctx.textBaseline = 'middle'
    const headerText = `stack (${refs.length})`
    const bodyText = refs.map(r => `T${r.triangleIndex}.${r.slotId}`).join(', ')
    const headerWidth = state._ctx.measureText(headerText).width
    const bodyWidth = state._ctx.measureText(bodyText).width
    const contentWidth = Math.max(headerWidth, bodyWidth)
    const w = contentWidth + STACK_LIST_PADDING_X * 2
    const h = STACK_LIST_HEIGHT * 2 + STACK_LIST_PADDING_Y * 2
    const x0 = sp.x - w / 2
    const y0 = sp.y + STACK_LIST_OFFSET_Y
    state._ctx.fillStyle = STACK_LIST_BACKGROUND
    state._ctx.fillRect(x0, y0, w, h)
    state._ctx.fillStyle = STACK_LIST_HEADER_COLOR
    state._ctx.fillText(headerText, sp.x, y0 + STACK_LIST_PADDING_Y + STACK_LIST_HEIGHT / 2)
    state._ctx.fillStyle = STACK_LIST_BODY_COLOR
    state._ctx.fillText(bodyText, sp.x, y0 + STACK_LIST_PADDING_Y + STACK_LIST_HEIGHT * 1.5)
}

// ===== Scene cache =====
// La scene STABLE (shapes, zoom/viewCenter, selection, grille) est rendue
// une fois dans un offscreen puis blittee (drawImage) ; le TRANSITOIRE
// (reticule, selectionBox, curseur, previews de geste) est repeint a
// chaque frame par-dessus. invalidateScene() force le re-render ;
// requestDraw() coalesce via rAF (au plus 1 drawBoard/frame) ;
// isSceneDirty() pour les tests. sceneDirty demarre a true (premier
// repaint integral) ; frameScheduled limite les callbacks rAF a 1.
let offscreen = null
let offCtx = null
let sceneDirty = true
let frameScheduled = false

// ===== HiDPI =====
// Bitmap en pixels PHYSIQUES (CSS x dpr), coords internes en pixels CSS ;
// conversion aux 2 seules frontieres : taille du bitmap (main.js) et
// transform dpr posee ici. cssBoardW/H derivent la taille CSS du board.
export const getDevicePixelRatio = () => (
    typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1
)

const applyDprTransform = (ctx) => {
    const dpr = getDevicePixelRatio()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

const cssBoardW = () => state.board.width / getDevicePixelRatio()
const cssBoardH = () => state.board.height / getDevicePixelRatio()

// Compteurs de rendu effectif (cf. DESIGN.md §2.4), sans condition sur
// fpsVisible (cout microscopique) ; le sampling ne tourne que HUD actif.
let statsRedraws = 0
let statsOffscreen = 0

// Snapshot atomique + reset, pour eviter une race avec drawBoard.
export const consumeDrawStats = () => {
    const res = { redraws: statsRedraws, offscreen: statsOffscreen }
    statsRedraws = 0
    statsOffscreen = 0
    return res
}

export const invalidateScene = () => {
    sceneDirty = true
}

export const isSceneDirty = () => sceneDirty

export const requestDraw = () => {
    sceneDirty = true
    if (frameScheduled) return
    frameScheduled = true
    requestAnimationFrame(() => {
        frameScheduled = false
        drawBoard()
    })
}

const ensureOffscreen = () => {
    if (offscreen) return
    offscreen = document.createElement('canvas')
    offCtx = offscreen.getContext('2d')
    sceneDirty = true
}

const syncOffscreenSize = () => {
    if (!offscreen) return
    const w = state.board.width
    const h = state.board.height
    if (offscreen.width !== w || offscreen.height !== h) {
        offscreen.width = w
        offscreen.height = h
        sceneDirty = true
    }
}

// Rendu de la scene stable dans l'offscreen : `state._ctx` est
// temporairement swap vers offCtx (try/finally : un helper qui throw
// ne casse pas le pipeline).
const renderSceneToOffscreen = () => {
    // Instrumentation dev gatee par state.debugRenderTime (default false) :
    // `state.debugRenderTime = true` active console.time('renderScene').
    if (state.debugRenderTime) console.time('renderScene')
    const visibleCtx = state._ctx
    state._ctx = offCtx
    try {
        applyDprTransform(offCtx)
        offCtx.fillStyle = CANVAS_BACKGROUND
        offCtx.fillRect(0, 0, cssBoardW(), cssBoardH())
        // Kiosque (cf. EVOLUTIONS.md) : remplace TOUTE la scene par les
        // cartes de selection des plans (la chrome est masquee cote CSS).
        if (state.kioskMode) {
            drawKiosk()
        } else {
            // Preview (cf. DESIGN.md §2.6) : scene reduite a la geometrie.
            if (!state.previewMode) {
                if (state.activeGrid) drawGrid()
                drawAxis()
            }
            drawShapes()
            if (!state.previewMode) {
                drawSelectedPoints()
                drawMultiPointMarkers()
            }
        }
    } finally {
        state._ctx = visibleCtx
    }
    if (state.debugRenderTime) console.timeEnd('renderScene')
}

// Calques transitoires (runtime, pas modele) repeints a chaque drawBoard.
const renderTransient = () => {
    // Preview : aucun calque transitoire.
    if (state.previewMode) return
    // Kiosque : guide vertical matérialisant l'axe piloté par le pointeur
    // (l'inclinaison des cartes suit son abscisse) + curseur standard.
    if (state.kioskMode) {
        if (state.lastMousePos) {
            state._ctx.setLineDash([4, 6])
            state._ctx.strokeStyle = KIOSK_GUIDE_COLOR
            state._ctx.beginPath()
            state._ctx.moveTo(state.lastMousePos.x, 0)
            state._ctx.lineTo(state.lastMousePos.x, cssBoardH())
            state._ctx.stroke()
            state._ctx.setLineDash([])
            drawMouse(state.lastMousePos)
        }
        return
    }
    if (typeof state.reticleMode !== 'undefined' && state.reticleMode > 0) drawReticle()
    if (
        typeof state.isSelectingBox !== 'undefined' &&
        state.isSelectingBox &&
        state.selectionBoxStart &&
        state.selectionBoxCurrent
    ) {
        drawSelectionBox(state.selectionBoxStart, state.selectionBoxCurrent)
    }
    // Previews transitoires des gestes de creation (cercle, etoile, anneau, forme).
    if (state.circleMode && state.circleCenterModel) drawCirclePreview()
    if (state.starMode && state.starCenterModel) drawStarModePreview()
    if (state.annulusMode && state.annulusCenterModel) drawAnnulusPreview()
    if (state.shapeKind !== undefined && state.shapeAnchorModel) drawShapeToolPreview()
    // Fusion par deplacement : anneau orange (couleur multi-points) du
    // rayon COURANT autour du candidat cible pendant le drag arme.
    if (state.mergeOnDropActive && typeof state.mergeDropCandidate === 'number' && state.currentAction === ACTION_GRABBING) {
        const shape = state.shapes[state.activeShapeIndex]
        const pt = shape && Array.isArray(shape.pointList) ? shape.pointList[state.mergeDropCandidate] : undefined
        if (pt) {
            const sp = modelToScreen(pt)
            state._ctx.setLineDash([3, 3])
            state._ctx.strokeStyle = COLOR_MULTI_POINT
            state._ctx.beginPath()
            state._ctx.arc(sp.x, sp.y, state.mergeDropRadius, 0, TAU)
            state._ctx.stroke()
            state._ctx.setLineDash([])
        }
    }
    // Le curseur est repeint a CHAQUE drawBoard (pas seulement au mousemove),
    // sinon tout requestDraw isole le blittait par-dessus et le faisait
    // disparaître au 1er clic d'un geste. state.lastMousePos est maintenu
    // par les chemins de saisie, donc il survit au repaint.
    if (state.lastMousePos) drawMouse(state.lastMousePos)
}

// ===== Previews transitoires de creation (cercle + formes) =====

// Socle radial partage : cercle pointille + ligne de rayon + marqueur
// de centre. `angle` = direction du rayon, projete en SCREEN via
// modelToScreen pour pointer exactement vers le sommet 0 genere.
const drawRadialBase = (center, radius, angle = 0) => {
    const sp = modelToScreen(center)
    const zoom = state.ctx.zoomLevel
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, radius * zoom, 0, TAU)
    state._ctx.stroke()
    state._ctx.setLineDash([])
    // Point ou le sommet 0 du polygone genere apparaitra (angle = 0 :
    // rayon horizontal historique).
    const endpoint = modelToScreen({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
    })
    state._ctx.beginPath()
    state._ctx.moveTo(sp.x, sp.y)
    state._ctx.lineTo(endpoint.x, endpoint.y)
    state._ctx.stroke()
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, 3, 0, TAU)
    state._ctx.stroke()
}

// Outline fermee en points SCREEN (WYSIWYG strict entre preview et commit).
const strokeScreenPolyline = (pts) => {
    if (!pts || pts.length === 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
    state._ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
        if (i === 0) state._ctx.moveTo(pts[i].x, pts[i].y)
        else state._ctx.lineTo(pts[i].x, pts[i].y)
    }
    state._ctx.closePath()
    state._ctx.stroke()
}

// Preview du cercle : polygone des N cotes (frontiere de l'eventail) +
// socle radial aligne sur circleOffsetAngle — ligne et polygone
// restent colineaires car derives du meme offset.
const drawCirclePreview = () => {
    const center = state.circleCenterModel
    const r = state.circleRadiusModel
    if (!center || r <= 0) return
    const n = Math.max(3, Math.round(state.circleSegments) || 24)
    const offset = state.circleOffsetAngle
    const rim = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offset
        rim.push(modelToScreen({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }))
    }
    drawRadialBase(center, r, offset)
    strokeScreenPolyline(rim)
}

// Preview etoile : contour (sommets exterieurs/interieurs alternes,
// meme formule que starGeometry) + ligne de rayon vers le 1er pic
// (angle -PI/2 + offset). En phase 2, starInnerRatio deforme
// l'etoile en direct.
const drawStarModePreview = () => {
    const center = state.starCenterModel
    const r = state.starRadiusModel
    if (!center || r <= 0) return
    const n = SHAPE_STAR_POINTS
    const rInner = Math.max(STAR_INNER_RATIO_MIN, Math.min(STAR_INNER_RATIO_MAX, state.starInnerRatio)) * r
    const offset = state.starOffsetAngle
    const pts = []
    for (let i = 0; i < n; i++) {
        const aOuter = (i / n) * TAU - Math.PI / 2 + offset
        const aInner = ((i + 0.5) / n) * TAU - Math.PI / 2 + offset
        pts.push(modelToScreen({ x: center.x + r * Math.cos(aOuter), y: center.y + r * Math.sin(aOuter) }))
        pts.push(modelToScreen({ x: center.x + rInner * Math.cos(aInner), y: center.y + rInner * Math.sin(aInner) }))
    }
    drawRadialBase(center, r, -Math.PI / 2 + offset)
    strokeScreenPolyline(pts)
}

// Preview anneau : couronne exterieure (socle radial) + trou (cercle
// pointille + polyline interne, ratio courant). En phase 1, le
// mouvement regle annulusInnerRatio en direct.
const drawAnnulusPreview = () => {
    const center = state.annulusCenterModel
    const r = state.annulusOuterRadiusModel
    if (!center || r <= 0) return
    const n = Math.max(3, Math.round(state.circleSegments) || 24)
    const offset = state.annulusOffsetAngle
    const innerRatio = Math.max(ANNULUS_INNER_RATIO_MIN, Math.min(ANNULUS_INNER_RATIO_MAX, state.annulusInnerRatio))
    const rInner = innerRatio * r
    const outer = []
    const inner = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offset
        outer.push(modelToScreen({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }))
        inner.push(modelToScreen({ x: center.x + rInner * Math.cos(a), y: center.y + rInner * Math.sin(a) }))
    }
    drawRadialBase(center, r, offset)
    strokeScreenPolyline(outer)
    // Le trou : cercle du rayon interne + polyline interieure.
    const sp = modelToScreen(center)
    const zoom = state.ctx.zoomLevel
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, rInner * zoom, 0, TAU)
    state._ctx.stroke()
    state._ctx.setLineDash([])
    strokeScreenPolyline(inner)
}

// Preview de la forme armee : rect/square = 2 coins, polygones =
// socle radial, etoile = contour alterne.
const drawShapeToolPreview = () => {
    const kind = state.shapeKind
    const anchor = state.shapeAnchorModel
    const current = state.shapeCurrentModel
    const radius = state.shapeRadiusModel
    if (!kind || !anchor || !current || radius <= 0) return
    if (kind === 'rect' || kind === 'square') {
        let c2 = current
        if (kind === 'square') {
            const dx = current.x - anchor.x
            const dy = current.y - anchor.y
            const side = Math.max(Math.abs(dx), Math.abs(dy))
            c2 = { x: anchor.x + (dx < 0 ? -side : side), y: anchor.y + (dy < 0 ? -side : side) }
        }
        const s1 = modelToScreen(anchor)
        const s2 = modelToScreen(c2)
        state._ctx.setLineDash([4, 4])
        state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
        state._ctx.beginPath()
        state._ctx.rect(
            Math.min(s1.x, s2.x),
            Math.min(s1.y, s2.y),
            Math.abs(s2.x - s1.x),
            Math.abs(s2.y - s1.y),
        )
        state._ctx.stroke()
        return
    }
    if (kind === 'star') {
        const n = SHAPE_STAR_POINTS
        const rInner = SHAPE_STAR_INNER_RATIO * radius
        const pts = []
        for (let i = 0; i < n; i++) {
            const aOuter = (i / n) * TAU - Math.PI / 2
            const aInner = ((i + 0.5) / n) * TAU - Math.PI / 2
            pts.push(modelToScreen({ x: anchor.x + radius * Math.cos(aOuter), y: anchor.y + radius * Math.sin(aOuter) }))
            pts.push(modelToScreen({ x: anchor.x + rInner * Math.cos(aInner), y: anchor.y + rInner * Math.sin(aInner) }))
        }
        drawRadialBase(anchor, radius)
        strokeScreenPolyline(pts)
        return
    }
    // Polygones reguliers : meme preview que le cercle, N fixe, orientation par souris.
    const n = { tri: 3, penta: 5, hexa: 6 }[kind]
    const offset = typeof state.shapeOffsetAngle === 'number' ? state.shapeOffsetAngle : 0
    const rim = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + offset
        rim.push(modelToScreen({ x: anchor.x + radius * Math.cos(a), y: anchor.y + radius * Math.sin(a) }))
    }
    // Triangle : un seul triangle (pas d'eventail), contour seul sans
    // socle radial — le resultat n'a ni centre ni rayon.
    if (kind === 'tri') {
        strokeScreenPolyline(rim)
        return
    }
    drawRadialBase(anchor, radius, offset)
    strokeScreenPolyline(rim)
}

export const drawBoard = () => {
    statsRedraws++
    // Transform dpr (jamais retiree : les overlays d'editor.js s'appuient dessus).
    applyDprTransform(state._ctx)
    ensureOffscreen()
    syncOffscreenSize()
    if (sceneDirty) {
        statsOffscreen++
        renderSceneToOffscreen()
        sceneDirty = false
    }
    // Blit offscreen (pixels physiques) vers une boite CSS px : 1:1 via la transform dpr.
    state._ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, cssBoardW(), cssBoardH())
    renderTransient()
}

// selectedPoints = indices pointList du plan actif : resolution
// en coords (indices non-integer / hors range ignores) puis batch.
export const drawSelectedPoints = () => {
    if (typeof state.selectedPoints === 'undefined' || !state.selectedPoints || state.selectedPoints.length === 0) return
    let isDimmed = typeof state.isSelectionDimmed !== 'undefined' && state.isSelectionDimmed
    let color = isDimmed ? COLOR_SELECTED_POINT_DIMMED : COLOR_SELECTED_POINT
    const pointList = state.shapes[state.activeShapeIndex]?.pointList || []
    const resolved = []
    state.selectedPoints.forEach((idx) => {
        if (!Number.isInteger(idx)) return
        const p = pointList[idx]
        if (!p) return
        resolved.push(p)
    })
    drawPointsBatch(resolved, 6, color)
}

// Anneaux orange autour des positions multi-points du PLAN ACTIF
// (candidats a la fusion #mergePoints, cf. DESIGN.md §7.10). Rendu
// apres drawSelectedPoints pour rester visible sur un sommet selectionne.
export const drawMultiPointMarkers = () => {
    const shape = state.shapes[state.activeShapeIndex]
    const multi = getMultiPointIndices(shape)
    if (multi.size === 0) return
    const points = []
    multi.forEach((idx) => {
        const p = shape.pointList[idx]
        if (p) points.push(p)
    })
    drawPointsBatch(points, MULTI_POINT_RADIUS, COLOR_MULTI_POINT)
}

export const drawSelectionBox = (p1, p2) => {
    if (!p1 || !p2) return
    let x = Math.min(p1.x, p2.x)
    let y = Math.min(p1.y, p2.y)
    let w = Math.abs(p2.x - p1.x)
    let h = Math.abs(p2.y - p1.y)
    state._ctx.fillStyle = COLOR_SELECTION_BOX_FILL
    state._ctx.fillRect(x, y, w, h)
    state._ctx.strokeStyle = COLOR_SELECTION_BOX_STROKE
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeRect(x, y, w, h)
    state._ctx.setLineDash([])
}

export const drawAxis = () => {
    let originScreenX = state.ctx.center.x + (0 - state.ctx.viewCenter.x) * state.ctx.zoomLevel
    let originScreenY = state.ctx.center.y - (0 - state.ctx.viewCenter.y) * state.ctx.zoomLevel
    let w = cssBoardW()
    let h = cssBoardH()
    state._ctx.setLineDash(PATTERN_AXIS)
    state._ctx.strokeStyle = COLOR_AXIS
    if (originScreenY >= 0 && originScreenY <= h) {
        state._ctx.beginPath()
        state._ctx.moveTo(0, originScreenY)
        state._ctx.lineTo(w, originScreenY)
        state._ctx.stroke()
    }
    if (originScreenX >= 0 && originScreenX <= w) {
        state._ctx.beginPath()
        state._ctx.moveTo(originScreenX, 0)
        state._ctx.lineTo(originScreenX, h)
        state._ctx.stroke()
    }
}

// Centroide deduped des points du grab : ancre du reticule mode 2
// pendant la drag (reflete en temps reel l'entite manipulee). null si
// grabbedGroup vide ou tous les indices resolvent vers undefined.
const grabbedReticleAnchor = () => {
    if (!Array.isArray(state.grabbedGroup) || state.grabbedGroup.length === 0) return null
    if (state.moveAllActive) return null
    const seen = new Set()
    let sumX = 0, sumY = 0, count = 0
    state.grabbedGroup.forEach((item) => {
        const key = item.shapeIndex + ':' + item.pointIndex
        if (seen.has(key)) return
        seen.add(key)
        const pt = state.shapes[item.shapeIndex] && state.shapes[item.shapeIndex].pointList && state.shapes[item.shapeIndex].pointList[item.pointIndex]
        if (!pt) return
        sumX += pt.x
        sumY += pt.y
        count++
    })
    if (count === 0) return null
    return { x: sumX / count, y: sumY / count }
}

export const drawReticle = () => {
    if (typeof state.reticleMode === 'undefined' || state.reticleMode === 0) return
    // Mode 2 : ancre = centroide du grab en cours (position live) ;
    // moveAllActive (AltGr) et fin de grab retombent sur le curseur.
    let m = null
    if (state.reticleMode === 2) {
        m = grabbedReticleAnchor()
    }
    if (!m) {
        if (typeof state.lastMousePos === 'undefined' || !state.lastMousePos) return
        m = screenToModel(state.lastMousePos)
        if (!m) return
    }
    let positions = [{ x: m.x, y: m.y }]
    if (state.reticleMode === 2) {
        positions.push({ x: -m.x, y: m.y })
        positions.push({ x: m.x, y: -m.y })
        positions.push({ x: -m.x, y: -m.y })
    }
    state._ctx.setLineDash(PATTERN_AXIS)
    state._ctx.strokeStyle = COLOR_RETICLE
    positions.forEach((pos) => {
        let sp = modelToScreen(pos)
        if (sp.y >= 0 && sp.y <= cssBoardH()) {
            state._ctx.beginPath()
            state._ctx.moveTo(0, sp.y)
            state._ctx.lineTo(cssBoardW(), sp.y)
            state._ctx.stroke()
        }
        if (sp.x >= 0 && sp.x <= cssBoardW()) {
            state._ctx.beginPath()
            state._ctx.moveTo(sp.x, 0)
            state._ctx.lineTo(sp.x, cssBoardH())
            state._ctx.stroke()
        }
    })
}

export const drawShapes = () => {
    if (
        typeof state.shapes === 'undefined' ||
        !Array.isArray(state.shapes) ||
        state.shapes.length === 0
    ) return
    // Preview « plans » (cf. DESIGN.md §2.6) : TOUS les plans rendus
    // remplis dans l'ordre du tableau (le plus haut recouvre les
    // precedents).
    if (state.previewPlans) {
        for (let i = 0; i < state.shapes.length; i++) {
            drawShape(state.shapes[i], true)
        }
        return
    }
    for (let i = 0; i < state.shapes.length; i++) {
        if (i === state.activeShapeIndex) continue
        drawShape(state.shapes[i], false)
    }
    drawShape(state.shapes[state.activeShapeIndex], true)
}

// tris = indices dans pointList ; resolution en coords, slots undefined
// (triangles partiels) filtres.
export const drawShape = (shape, isActive) => {
    if (!shape || !Array.isArray(shape.tris) || shape.tris.length === 0) return
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    let lineColor = isActive ? COLOR_LINES : COLOR_LINES_INACTIVE
    let linePattern = isActive ? PATTERN_LINES : PATTERN_LINES_INACTIVE
    let pointColor = isActive ? POINT_COLOR_ACTIVE : POINT_COLOR_INACTIVE

    // 3 passes au lieu d'un drawTriangle par tri (opt #3) : fill par
    // groupe de couleur (active shape), stroke global unique, vertex
    // en batch. resolvedTris = resolution unique des indices en coords.
    const vertexPoints = []
    const resolvedTris = []
    shape.tris.forEach((t) => {
        const p1 = Number.isInteger(t.p1) ? pointList[t.p1] : undefined
        const p2 = Number.isInteger(t.p2) ? pointList[t.p2] : undefined
        const p3 = Number.isInteger(t.p3) ? pointList[t.p3] : undefined
        const fill = isActive ? (t.fill !== undefined ? t.fill : COLOR_TRIANGLE_FILL_ACTIVE) : undefined
        if (p1) vertexPoints.push(p1)
        if (p2) vertexPoints.push(p2)
        if (p3) vertexPoints.push(p3)
        resolvedTris.push({ p1, p2, p3, fill })
    })

    // === Fill pass (active shape, tris completes) ===
    // fill() applique le fillStyle courant a TOUS les sub-paths du
    // beginPath courant : un beginPath par groupe de couleur distinct.
    if (isActive) {
        const fillGroups = new Map()
        for (let i = 0; i < resolvedTris.length; i++) {
            const r = resolvedTris[i]
            if (!r.fill || !r.p3) continue
            const arr = fillGroups.get(r.fill) || []
            arr.push(r)
            fillGroups.set(r.fill, arr)
        }
        for (const [color, tris] of fillGroups.entries()) {
            // SAFE-BELT : des windings heterogenes en screen-space (apres
            // le Y-flip de modelToScreen) ou un tri degenere (cross = 0)
            // feraient un trou sous fillRule=nonzero -> fallback per-tri.
            const screenTris = tris.map((r) => {
                const s1 = modelToScreen(r.p1)
                const s2 = modelToScreen(r.p2)
                const s3 = modelToScreen(r.p3)
                return { r, s1, s2, s3 }
            })
            let uniformSign = true
            let firstSign = null
            let hasDegenerate = false
            for (let i = 0; i < screenTris.length; i++) {
                const t = screenTris[i]
                const cp = (t.s2.x - t.s1.x) * (t.s3.y - t.s1.y) - (t.s2.y - t.s1.y) * (t.s3.x - t.s1.x)
                if (cp === 0) { hasDegenerate = true; continue }
                const sign = cp > 0
                if (firstSign === null) firstSign = sign
                else if (sign !== firstSign) { uniformSign = false; break }
            }
            uniformSign = uniformSign && !hasDegenerate
            state._ctx.fillStyle = color
            if (uniformSign) {
                state._ctx.beginPath()
                for (let i = 0; i < screenTris.length; i++) {
                    const t = screenTris[i]
                    state._ctx.moveTo(t.s1.x, t.s1.y)
                    state._ctx.lineTo(t.s2.x, t.s2.y)
                    state._ctx.lineTo(t.s3.x, t.s3.y)
                    state._ctx.closePath()
                }
                state._ctx.fill()
            } else {
                // Fallback : un path par tri, rendu identique a l'ancien drawTriangle.
                for (let i = 0; i < screenTris.length; i++) {
                    const t = screenTris[i]
                    state._ctx.beginPath()
                    state._ctx.moveTo(t.s1.x, t.s1.y)
                    state._ctx.lineTo(t.s2.x, t.s2.y)
                    state._ctx.lineTo(t.s3.x, t.s3.y)
                    state._ctx.closePath()
                    state._ctx.fill()
                }
            }
        }
    }

    // === Stroke pass (tous les tris) ===
    // 1 beginPath + 1 stroke global ; setLineDash/setStrokeStyle fixes
    // une fois par shape. Les tris partiels (p3 absent) ne ferment pas
    // leur sub-path.
    state._ctx.setLineDash(linePattern)
    state._ctx.strokeStyle = lineColor
    state._ctx.beginPath()
    for (let i = 0; i < resolvedTris.length; i++) {
        const r = resolvedTris[i]
        if (!r.p1) continue
        const s1 = modelToScreen(r.p1)
        state._ctx.moveTo(s1.x, s1.y)
        if (r.p2) {
            const s2 = modelToScreen(r.p2)
            state._ctx.lineTo(s2.x, s2.y)
            if (r.p3) {
                const s3 = modelToScreen(r.p3)
                state._ctx.lineTo(s3.x, s3.y)
                state._ctx.closePath()
            }
        }
    }
    state._ctx.stroke()

    // Points de controle sautes en preview (seule la geometrie reste visible).
    if (!state.previewMode) drawPointsBatch(vertexPoints, 2, pointColor)
}

// ===== Kiosque de sélection des plans (cf. EVOLUTIONS.md) =====
// Mode « kiosque » : chaque plan est rendu comme une CARTE inclinée
// autour d'un axe vertical virtuel (effet cover-flow). La position
// horizontale du pointeur (state.lastMousePos.x) pilote un « focus »
// continu : le plan sous le focus est mis en avant (face au spectateur,
// pleine opacité), les autres s'inclinent, rétrécissent et s'estompent
// avec l'écart. Un clic sélectionne le plan MIS EN AVANT
// (kioskSelectedIndex = le focus, jamais un précédent/suivant) et sort
// du mode (viewport.js exitKiosk).
const KIOSK_MAX_TILT_RAD = 1.15       // ~66° : inclinaison max des cartes lointaines
const KIOSK_TILT_RAD_PER_STEP = Math.PI / 4  // 45° par carte d'écart au focus
const KIOSK_PERSPECTIVE_D = 2.5       // distance du spectateur (en demi-largeurs de carte) : perspective du kiosque
const KIOSK_MIN_SCALE = 0.4           // taille min des cartes lointaines
const KIOSK_SCALE_FALLOFF = 1.4       // décroissance gaussienne de la taille
const KIOSK_CARD_H_RATIO = 0.6        // hauteur de carte / hauteur canvas
const KIOSK_CARD_SPACING_RATIO = 0.35 // espacement max entre cartes / largeur (réduit : la perspective élargit l'empreinte)
const KIOSK_CARD_SPAN_RATIO = 0.88    // envergure totale max / largeur
const KIOSK_EDGE_RATIO = 0.3          // épaisseur du faux-3D / hauteur carte
const KIOSK_MAX_PARALLAX_Y = 18       // surélévation des cartes lointaines (px)
const KIOSK_ASPECT_MIN = 0.35
const KIOSK_ASPECT_MAX = 2.8
const KIOSK_PANEL_BG = 'rgba(30, 30, 30, 0.9)'
const KIOSK_PANEL_BG_EDGE = 'rgba(16, 16, 16, 0.95)'
const KIOSK_DIM_MIN_ALPHA = 0.3
const KIOSK_DIM_FALLOFF = 3.0        // décroissance exponentielle de l'atténuation (fondu progressif, réglage utilisateur : plus lent que 2)
const KIOSK_LABEL_FONT = 'bold 18px monospace' // numéro de plan en gros (facilite le choix)
const KIOSK_LABEL_OFFSET = 16
const KIOSK_GUIDE_COLOR = 'rgba(0, 255, 0, 0.25)'

// Focus CONTINU 0..N-1 dérivé d'une abscisse : règle linéaire (bords
// du canvas => 1er / dernier plan mis en avant) PARTAGÉE par l'affichage
// (kioskFocus, piloté par le pointeur) et la sélection au clic
// (kioskSelectedIndex) — l'affichage et le clic ne peuvent diverger.
const kioskFocusAt = (x) => {
    const n = state.shapes.length
    if (n <= 1) return 0
    const w = cssBoardW()
    if (!w) return 0
    const t = Math.max(0, Math.min(1, x / w))
    return t * (n - 1)
}

// Focus continu suivi par le pointeur (pilote l'inclinaison et le plan
// mis en avant). Sans pointeur (boot), retombe sur le plan actif.
export const kioskFocus = () => {
    if (!state.lastMousePos || !state.board) return state.activeShapeIndex
    return kioskFocusAt(state.lastMousePos.x)
}

// Sélection au clic = le plan MIS EN AVANT (focus arrondi), évalué à
// l'abscisse du clic. Même règle que l'affichage : le plan sélectionné
// est TOUJOURS celui mis en valeur, même si le pointeur n'est pas
// au-dessus de sa carte (marges, interstices) — un clic ne peut plus
// déclencher un plan précédent/suivant (régression des hit-tests
// précédents « centre le plus proche » puis « ordre de profondeur », qui
// divergeaient tous deux du focus affiché).
export const kioskSelectedIndex = (screenX) => {
    const n = state.shapes.length
    if (n === 0) return -1
    // Garde défensive : sans board, retombe sur le plan actif (comme
    // kioskFocus) au lieu de crasher dans cssBoardW().
    if (!state.board) return state.activeShapeIndex
    return Math.min(n - 1, Math.max(0, Math.round(kioskFocusAt(screenX))))
}

// Bounding box du plan (vide => carte neutre 1×1 centree a l'origine).
export const planBounds = (shape) => {
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    if (pointList.length === 0) return { cx: 0, cy: 0, bw: 1, bh: 1 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < pointList.length; i++) {
        const p = pointList[i]
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
    }
    if (!Number.isFinite(minX)) return { cx: 0, cy: 0, bw: 1, bh: 1 }
    return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        bw: Math.max(maxX - minX, 1e-3),
        bh: Math.max(maxY - minY, 1e-3),
    }
}

// Dimensions écran d'une carte (AVANT inclinaison) : hauteur = ratio du
// canvas × scale, largeur = hauteur × aspect du plan. La perspective est
// appliquée ensuite par projectKioskPoint (trapèze), pas par un scale.
const cardDims = (bounds, scale) => {
    const aspect = Math.max(KIOSK_ASPECT_MIN, Math.min(KIOSK_ASPECT_MAX, bounds.bw / bounds.bh))
    const cardH = cssBoardH() * KIOSK_CARD_H_RATIO * scale
    const cardW = cardH * aspect
    return { cardH, cardW, halfW: cardW / 2, halfH: cardH / 2 }
}

// Projection perspective d'un point local (u, v) ∈ [-1, 1]² de la carte :
// rotation de `tilt` autour de l'axe vertical CENTRAL (u·cos, profondeur
// u·sin), puis échelle D/(D - u·sin) — le bord qui s'approche du
// spectateur est agrandi, l'opposé rétréci : vraie impression d'un plan
// incliné (trapèze), pas une simple compression orthographique. Garde
// défensive sur le dénominateur (jamais atteint : |u·sin| ≤ 0.91 < D).
const projectKioskPoint = (c, d, u, v) => {
    const sinT = Math.sin(c.tilt)
    const cosT = Math.cos(c.tilt)
    const s = KIOSK_PERSPECTIVE_D / Math.max(KIOSK_PERSPECTIVE_D - u * sinT, 0.25)
    return {
        x: c.x + u * cosT * d.halfW * s,
        y: c.y + v * d.halfH * s,
    }
}

// Layout complet du kiosque : positions + inclinaison + scale de chaque
// carte (ordre du tableau), index du plan mis en avant. Servi à
// drawKiosk (rendu) et au focus/sélection (kioskFocus/kioskSelectedIndex).
export const computeKioskLayout = () => {
    const n = state.shapes.length
    const focus = kioskFocus()
    const w = cssBoardW()
    const spacing = Math.min(
        w * KIOSK_CARD_SPACING_RATIO,
        (w * KIOSK_CARD_SPAN_RATIO) / Math.max(n - 1, 1),
    )
    const cards = []
    for (let i = 0; i < n; i++) {
        const dx = i - focus
        const tilt = Math.max(-KIOSK_MAX_TILT_RAD, Math.min(KIOSK_MAX_TILT_RAD, dx * KIOSK_TILT_RAD_PER_STEP))
        const scale = KIOSK_MIN_SCALE + (1 - KIOSK_MIN_SCALE) * Math.exp(-Math.abs(dx) / KIOSK_SCALE_FALLOFF)
        const slotX = w / 2 + dx * spacing
        const card = {
            index: i,
            dx,
            tilt,
            scale,
            x: slotX,
            y: cssBoardH() / 2 - Math.min(Math.abs(dx), 3) * (KIOSK_MAX_PARALLAX_Y / 3),
        }
        // Recentrage : la projection perspective rend l'empreinte ASYMÉTRIQUE
        // (bord proche agrandi) ; on décale la carte pour que le MILIEU de
        // son empreinte projetée reste sur son slot — sans cela les cartes
        // extrêmes (fortement inclinées) débordent de l'écran côté bord
        // proche. Layout et hit-test partagent cette même position. Le
        // milieu d'empreinte est mémorisé pour centrer l'étiquette dessus.
        const d = cardDims(planBounds(state.shapes[i]), scale)
        const fp = cardFootprint(card, d)
        card.fpMid = (fp.left + fp.right) / 2
        card.x += slotX - card.fpMid
        cards.push(card)
    }
    return { cards }
}



// Bande d'épaisseur du faux-3D : côté opposé à l'inclinaison (le bord
// qui « recule »). CONTRAT partagé entre le rendu (drawKioskCard) et
// l'empreinte de layout (cardFootprint, recentrage) — side/uFar/edgeW/
// sFar doivent rester identiques des deux côtés (une divergence =
// bande dessinée qui ne colle pas à l'empreinte du layout).
const cardBand = (c, d) => {
    const sinT = Math.sin(c.tilt)
    const side = c.dx < 0 ? 1 : -1
    const uFar = side === -1 ? -1 : 1
    return {
        side,
        uFar,
        edgeW: Math.abs(sinT) * d.cardH * KIOSK_EDGE_RATIO,
        sFar: KIOSK_PERSPECTIVE_D / (KIOSK_PERSPECTIVE_D - uFar * sinT),
    }
}

// Empreinte écran d'une carte : span X de la face PROJETÉE (bords
// u = ±1 dans la perspective) + bande d'épaisseur du faux-3D du côté
// opposé à l'inclinaison. Sert au RECENTRAGE anti-clipping du layout
// (computeKioskLayout) et reste le pendant exact de la bande dessinée
// par drawKioskCard via cardBand (mêmes side/uFar/edgeW/sFar).
const cardFootprint = (c, d) => {
    const { side, edgeW } = cardBand(c, d)
    const left = projectKioskPoint(c, d, -1, 0).x - (side === -1 ? edgeW : 0)
    const right = projectKioskPoint(c, d, 1, 0).x + (side === 1 ? edgeW : 0)
    return { left, right }
}

// Rendu d'une carte : bande d'épaisseur (faux-3D) du côté opposé à
// l'inclinaison, puis face en TRAPÈZE (perspective : le bord proche est
// agrandi, le lointain rétréci — vraie impression d'un plan incliné).
const drawKioskCard = (c) => {
    const shape = state.shapes[c.index]
    const bounds = planBounds(shape)
    const d = cardDims(bounds, c.scale)
    const ctx = state._ctx
    // Fondu progressif : l'opacité suit une courbe exponentielle de
    // l'écart au focus (KIOSK_DIM_FALLOFF), rehaussée par la prominence
    // du plan (1 au focus, 0 dès |dx| ≥ 1) — le passage d'un plan à un
    // autre est un glissement continu, pas un basculement d'opacité.
    const prom = Math.max(0, 1 - Math.abs(c.dx))
    const dim = KIOSK_DIM_MIN_ALPHA + (1 - KIOSK_DIM_MIN_ALPHA) * Math.exp(-Math.abs(c.dx) / KIOSK_DIM_FALLOFF)
    const alpha = prom + (1 - prom) * dim

    // Bande d'épaisseur : collée au bord lointain (côté qui « recule »).
    const { side, uFar, edgeW, sFar } = cardBand(c, d)
    const farX = projectKioskPoint(c, d, uFar, 0).x
    if (edgeW > 0.5) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = KIOSK_PANEL_BG_EDGE
        ctx.fillRect(Math.min(farX, farX + side * edgeW), c.y - d.halfH * sFar, edgeW, d.cardH * sFar)
    }

    // Face : quadrilatère aux 4 coins projetés (trapèze en perspective).
    const tl = projectKioskPoint(c, d, -1, -1)
    const tr = projectKioskPoint(c, d, 1, -1)
    const br = projectKioskPoint(c, d, 1, 1)
    const bl = projectKioskPoint(c, d, -1, 1)
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(tl.x, tl.y)
    ctx.lineTo(tr.x, tr.y)
    ctx.lineTo(br.x, br.y)
    ctx.lineTo(bl.x, bl.y)
    ctx.closePath()
    ctx.fillStyle = KIOSK_PANEL_BG
    ctx.fill()
    // Géométrie du plan : bbox -> carte (fit plein, la perspective
    // s'occupe de l'écrasement), chaque sommet projeté individuellement.
    const fit = Math.min(d.cardW / bounds.bw, d.cardH / bounds.bh)
    // Trait plein dès que le plan devient majoritaire (prom > 0.5) : la
    // bascule du style suit la transition d'opacité, pas le round() du focus.
    drawShapeInCard(shape, bounds, c, d, fit, prom > 0.5)
    ctx.globalAlpha = 1
    // Nom du plan en gros : fondu croisé entre les deux cartes voisines
    // du focus — l'ancien nom s'efface pendant que le nouveau apparaît.
    if (prom > 0.02) drawKioskLabel(c, d, prom)
}

// Triangles du plan en coords locales (bbox centrée, fit appliqué), puis
// PROJETÉS sommet par sommet dans la perspective de la carte (le trapèze
// rendu n'est pas affine : un scale global ne suffirait pas).
// Fill par-tri (globalAlpha posé par la carte), stroke global, aucune
// dépendance à modelToScreen — la carte est un monde local.
const drawShapeInCard = (shape, bounds, c, d, fit, isFocused) => {
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    if (tris.length === 0) return
    const ctx = state._ctx
    // Coordonnée locale (px carte, avant inclinaison) puis projection :
    // u ∈ [-1, 1] (axe horizontal de rotation) = x / halfW, v = y / halfH.
    const project = (p) => projectKioskPoint(c, d, ((p.x - bounds.cx) * fit) / d.halfW, ((p.y - bounds.cy) * fit) / d.halfH)
    const resolved = []
    for (let i = 0; i < tris.length; i++) {
        const t = tris[i]
        const p1 = Number.isInteger(t.p1) ? pointList[t.p1] : undefined
        const p2 = Number.isInteger(t.p2) ? pointList[t.p2] : undefined
        const p3 = Number.isInteger(t.p3) ? pointList[t.p3] : undefined
        resolved.push({ p1, p2, p3, fill: t.fill !== undefined ? t.fill : COLOR_TRIANGLE_FILL_ACTIVE })
    }
    // Fill per-tri (aucun safe-belt nécessaire : un path par triangle).
    for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i]
        if (!r.p1 || !r.p2 || !r.p3) continue
        const s1 = project(r.p1)
        const s2 = project(r.p2)
        const s3 = project(r.p3)
        ctx.fillStyle = r.fill
        ctx.beginPath()
        ctx.moveTo(s1.x, s1.y)
        ctx.lineTo(s2.x, s2.y)
        ctx.lineTo(s3.x, s3.y)
        ctx.closePath()
        ctx.fill()
    }
    // Stroke global (pointillés pour les cartes atténuées).
    ctx.setLineDash(isFocused ? [] : PATTERN_LINES_INACTIVE)
    ctx.strokeStyle = isFocused ? COLOR_LINES : COLOR_LINES_INACTIVE
    ctx.beginPath()
    for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i]
        if (!r.p1) continue
        const s1 = project(r.p1)
        ctx.moveTo(s1.x, s1.y)
        if (r.p2) {
            const s2 = project(r.p2)
            ctx.lineTo(s2.x, s2.y)
            if (r.p3) {
                const s3 = project(r.p3)
                ctx.lineTo(s3.x, s3.y)
                ctx.closePath()
            }
        }
    }
    ctx.stroke()
    ctx.setLineDash([])
}

// Nom « Plan N » du plan mis en évidence (ou en transition vers lui) :
// texte vert GROS (KIOSK_LABEL_FONT), centré sur le milieu de l'empreinte
// projetée (centre VISUEL, qui diffère du centre géométrique c.x sous la
// perspective), sous le bas du trapèze (bord PROCHE agrandi). `alpha`
// pilote le fondu croisé entre les deux cartes voisines du focus.
const drawKioskLabel = (c, d, alpha) => {
    const ctx = state._ctx
    const text = `Plan ${c.index + 1}`
    ctx.font = KIOSK_LABEL_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const sMax = KIOSK_PERSPECTIVE_D / (KIOSK_PERSPECTIVE_D - Math.abs(Math.sin(c.tilt)))
    const y = c.y + d.halfH * sMax + KIOSK_LABEL_OFFSET
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#55ff55'
    ctx.fillText(text, c.fpMid !== undefined ? c.fpMid : c.x, y)
    ctx.globalAlpha = 1
}

// Rendu complet : cartes du plus lointain au plus proche du focus (le
// plan mis en avant passe AU-DESSUS des voisins qui le chevauchent).
// Aucun cadre ni anneau : le plan mis en évidence ne se distingue que par
// son nom vert (drawKioskLabel) et sa pleine opacité (les autres dimmés).
export const drawKiosk = () => {
    const n = state.shapes.length
    if (n === 0) return
    const { cards } = computeKioskLayout()
    const ordered = [...cards].sort((a, b) => Math.abs(b.dx) - Math.abs(a.dx))
    for (let i = 0; i < ordered.length; i++) {
        drawKioskCard(ordered[i])
    }
}

export const drawTriangle = (p1, p2, p3, pattern, color, fill) => {
    if (!p1) return
    let s1 = modelToScreen(p1)
    state._ctx.setLineDash(pattern !== undefined ? pattern : PATTERN_LINES)
    state._ctx.strokeStyle = color !== undefined ? color : COLOR_LINES
    state._ctx.beginPath()
    state._ctx.moveTo(s1.x, s1.y)
    if (p2 !== undefined) {
        let s2 = modelToScreen(p2)
        state._ctx.lineTo(s2.x, s2.y)
        if (p3 !== undefined) {
            let s3 = modelToScreen(p3)
            state._ctx.lineTo(s3.x, s3.y)
            state._ctx.closePath()
            if (fill !== undefined) {
                state._ctx.fillStyle = fill
                state._ctx.fill()
            }
        }
    }
    state._ctx.stroke()
}

export const drawLine = (p1, p2, pattern, color) => {
    if (!p1 || !p2) return
    let s1 = modelToScreen(p1)
    let s2 = modelToScreen(p2)
    state._ctx.setLineDash(pattern)
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    state._ctx.moveTo(s1.x, s1.y)
    state._ctx.lineTo(s2.x, s2.y)
    state._ctx.stroke()
}

// ===== LOD grille (opt #2) =====
// En dessous de 4 px d'espacement, les lignes fusionnent et le cout
// canvas explose (a zoom 0.1 / pas 32 : ~6000 moveTo+lineTo inutiles).
const MIN_GRID_STEP_PX = 4

export const drawGrid = () => {
    const baseStep = typeof state.GRID_STEP !== 'undefined' ? state.GRID_STEP : 32
    if (!baseStep || baseStep <= 0) return
    const step = baseStep * state.ctx.zoomLevel
    if (step <= 0) return
    if (step < MIN_GRID_STEP_PX) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_GRID
    state._ctx.beginPath()
    let originScreenX = state.ctx.center.x - state.ctx.viewCenter.x * state.ctx.zoomLevel
    let originScreenY = state.ctx.center.y + state.ctx.viewCenter.y * state.ctx.zoomLevel
    let n_min_x = Math.ceil(-originScreenX / step)
    let n_max_x = Math.floor((cssBoardW() - originScreenX) / step)
    for (let n = n_min_x; n <= n_max_x; n++) {
        let x_screen = originScreenX + n * step
        state._ctx.moveTo(x_screen, 0)
        state._ctx.lineTo(x_screen, cssBoardH())
    }
    let n_min_y = Math.ceil((originScreenY - cssBoardH()) / step)
    let n_max_y = Math.floor(originScreenY / step)
    for (let n = n_min_y; n <= n_max_y; n++) {
        let y_screen = originScreenY - n * step
        state._ctx.moveTo(0, y_screen)
        state._ctx.lineTo(cssBoardW(), y_screen)
    }
    state._ctx.stroke()
}
