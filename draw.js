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

export const drawSelectedPoints = () => {
    if (typeof state.selectedPoints === 'undefined' || !state.selectedPoints || state.selectedPoints.length === 0) return
    let isDimmed = typeof state.isSelectionDimmed !== 'undefined' && state.isSelectionDimmed
    let color = isDimmed ? COLOR_SELECTED_POINT_DIMMED : COLOR_SELECTED_POINT
    state.selectedPoints.forEach((p) => {
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

export const drawShape = (shape, isActive) => {
    if (!shape || !shape.triangles || shape.triangles.length === 0) return
    let lineColor = isActive ? COLOR_LINES : COLOR_LINES_INACTIVE
    let linePattern = isActive ? PATTERN_LINES : PATTERN_LINES_INACTIVE
    let pointColor = isActive ? POINT_COLOR_ACTIVE : POINT_COLOR_INACTIVE
    shape.triangles.forEach((t) => {
        let fill = isActive ? (t.fill !== undefined ? t.fill : COLOR_TRIANGLE_FILL_ACTIVE) : undefined
        drawTriangle(t.p1, t.p2, t.p3, linePattern, lineColor, fill)
        drawPoint(t.p1, 2, pointColor)
        drawPoint(t.p2, 2, pointColor)
        drawPoint(t.p3, 2, pointColor)
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
