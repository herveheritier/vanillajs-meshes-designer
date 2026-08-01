// Rationale : voir DESIGN.md §2.3

import { state } from './state.js'
import { modelToScreen, screenToModel } from './geometry.js'
import {
    TAU,
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
    COLOR_SELECTION_BOX_FILL,
    COLOR_SELECTION_BOX_STROKE,
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

export const drawMouse = (p) => {
    if (!p) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_CURSOR
    state._ctx.beginPath()
    state._ctx.arc(p.x, p.y, 3, 0, TAU)
    state._ctx.stroke()
}

// Label d'identifiant stable du sommet survole (cf. §7.8) : petite
// pill sombre sous le point avec l'index 0-based du vertex dans
// activeShapeIndex (convention dev-friendly alignee sur les arrays
// JS de getAllVertices()). Permet d'identifier chaque point sans
// ambiguite quand plusieurs refs partagent la meme position.
// Position sous le cercle vert (offset Y +14) pour eviter la
// collision visuelle avec les elements superieurs du stack.
// Choix d'un fond semi-transparent pour rester lisible sur
// n'importe quelle zone du canvas (sombre ou deja coloree par un
// triangle custom).
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

// Liste des slots triangles qui partagent le sommet survole (cf.
// §7.9). Pill 2 lignes : header golden "stack (N)" + body blanc
// "T1.p1, T3.p2, ...". Position sous le label §7.8 (offset Y +32)
// sans overlap avec le label (+14/+21) ni avec le canvas bottom
// edge (pas de flip -- un stack de plusieurs refs est rare ; si
// besoin ajouter un clamp bottom-edge ici).
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

export const drawBoard = () => {
    state._ctx.fillStyle = CANVAS_BACKGROUND
    state._ctx.fillRect(0, 0, state.board.width, state.board.height)
    if (state.activeGrid) drawGrid()
    drawAxis()
    drawShapes()
    drawSelectedPoints()
    if (typeof state.reticleMode !== 'undefined' && state.reticleMode > 0) drawReticle()
    if (
        typeof state.isSelectingBox !== 'undefined' &&
        state.isSelectingBox &&
        state.selectionBoxStart &&
        state.selectionBoxCurrent
    ) {
        drawSelectionBox(state.selectionBoxStart, state.selectionBoxCurrent)
    }
}

// Phase 3 (modifyShapeModel-spec §3.7) : avec state.selectedPoints
// = indices dans activeShape().pointList (Q1c), chaque entree du
// tableau est un nombre, pas une ref JS. On resout via
// pointList[idx] avant de deleguer au drawPoint. Indices non-
// integer ou hors range sont ignores (defense — ne devrait pas
// arriver dans le pipeline normal post-Phase 2).
export const drawSelectedPoints = () => {
    if (typeof state.selectedPoints === 'undefined' || !state.selectedPoints || state.selectedPoints.length === 0) return
    let isDimmed = typeof state.isSelectionDimmed !== 'undefined' && state.isSelectionDimmed
    let color = isDimmed ? COLOR_SELECTED_POINT_DIMMED : COLOR_SELECTED_POINT
    const pointList = state.shapes[state.activeShapeIndex]?.pointList || []
    state.selectedPoints.forEach((idx) => {
        if (!Number.isInteger(idx)) return
        const p = pointList[idx]
        if (!p) return
        drawPoint(p, 6, color)
    })
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
    let w = state.board.width
    let h = state.board.height
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

export const drawReticle = () => {
    if (typeof state.reticleMode === 'undefined' || state.reticleMode === 0) return
    if (typeof state.lastMousePos === 'undefined' || !state.lastMousePos) return
    let m = screenToModel(state.lastMousePos)
    if (!m) return
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
        if (sp.y >= 0 && sp.y <= state.board.height) {
            state._ctx.beginPath()
            state._ctx.moveTo(0, sp.y)
            state._ctx.lineTo(state.board.width, sp.y)
            state._ctx.stroke()
        }
        if (sp.x >= 0 && sp.x <= state.board.width) {
            state._ctx.beginPath()
            state._ctx.moveTo(sp.x, 0)
            state._ctx.lineTo(sp.x, state.board.height)
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
    for (let i = 0; i < state.shapes.length; i++) {
        if (i === state.activeShapeIndex) continue
        drawShape(state.shapes[i], false)
    }
    drawShape(state.shapes[state.activeShapeIndex], true)
}

// Phase 3 (modifyShapeModel-spec §3.7) : le tableau est `tris` (Phase 1),
// les slots p1/p2/p3 sont des indices dans shape.pointList. On resout
// les coordonnees via pointList[t.pX] avant de deleguer a drawTriangle /
// drawPoint. Les slots `undefined` (Q1b triangles partiels) sont
// correctement filtres — drawTriangle gere deja le cas p1 absent / p2
// absent / p3 absent, et drawPoint ignore les coords absents (guard
// `if (!p) return`).
export const drawShape = (shape, isActive) => {
    if (!shape || !Array.isArray(shape.tris) || shape.tris.length === 0) return
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    let lineColor = isActive ? COLOR_LINES : COLOR_LINES_INACTIVE
    let linePattern = isActive ? PATTERN_LINES : PATTERN_LINES_INACTIVE
    let pointColor = isActive ? POINT_COLOR_ACTIVE : POINT_COLOR_INACTIVE
    shape.tris.forEach((t) => {
        const p1 = Number.isInteger(t.p1) ? pointList[t.p1] : undefined
        const p2 = Number.isInteger(t.p2) ? pointList[t.p2] : undefined
        const p3 = Number.isInteger(t.p3) ? pointList[t.p3] : undefined
        let fill = isActive ? (t.fill !== undefined ? t.fill : COLOR_TRIANGLE_FILL_ACTIVE) : undefined
        drawTriangle(p1, p2, p3, linePattern, lineColor, fill)
        drawPoint(p1, 2, pointColor)
        drawPoint(p2, 2, pointColor)
        drawPoint(p3, 2, pointColor)
    })
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

export const drawGrid = () => {
    const baseStep = typeof state.GRID_STEP !== 'undefined' ? state.GRID_STEP : 32
    if (!baseStep || baseStep <= 0) return
    const step = baseStep * state.ctx.zoomLevel
    if (step <= 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_GRID
    state._ctx.beginPath()
    let originScreenX = state.ctx.center.x - state.ctx.viewCenter.x * state.ctx.zoomLevel
    let originScreenY = state.ctx.center.y + state.ctx.viewCenter.y * state.ctx.zoomLevel
    let n_min_x = Math.ceil(-originScreenX / step)
    let n_max_x = Math.floor((state.board.width - originScreenX) / step)
    for (let n = n_min_x; n <= n_max_x; n++) {
        let x_screen = originScreenX + n * step
        state._ctx.moveTo(x_screen, 0)
        state._ctx.lineTo(x_screen, state.board.height)
    }
    let n_min_y = Math.ceil((originScreenY - state.board.height) / step)
    let n_max_y = Math.floor(originScreenY / step)
    for (let n = n_min_y; n <= n_max_y; n++) {
        let y_screen = originScreenY - n * step
        state._ctx.moveTo(0, y_screen)
        state._ctx.lineTo(state.board.width, y_screen)
    }
    state._ctx.stroke()
}
