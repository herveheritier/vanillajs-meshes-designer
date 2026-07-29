// Module draw.js : primitives de rendu canvas. Converti en ES6 module
// (type="module") : importe les constantes + state + helpers
// geometriques depuis leurs modules respectifs, exporte les
// fonctions de dessin. Aucun appelant ne doit appeler drawPoint
// avec des coordonnees screen (utiliser drawMouse ou le draw direct).
//
// Conventions :
//   - Le state (formes, selection, viewport, hover, ...) est lu
//     depuis state.js (import { state }). Toutes les fonctions
//     qui en ont besoin accedent via state.X.
//   - Le contexte canvas 2D (_ctx) et le board (ref DOM) sont
//     initialises dans main.js (state._ctx = state.board.getContext('2d'))
//     puis stockes dans state pour etre accessibles ici.
//   - Toutes les fonctions qui dessinent sont exportees en
//     named exports (cf. main.js qui importe).

import { state } from './state.js'
import { modelToScreen, screenToModel } from './geometry.js'
import {
    TAU,
    COLOR_AXIS,
    COLOR_LINES,
    COLOR_LINES_INACTIVE,
    POINT_COLOR_INACTIVE,
    PATTERN_AXIS,
    PATTERN_LINES,
    PATTERN_LINES_INACTIVE,
} from './constants.js'

// Le systeme de coordonnees du modele est centre a (state.ctx.center.x,
// state.ctx.center.y) avec X vers la droite et Y vers le haut.
// Pour le rendu, on translate de state.ctx.center.x (decalage X)
// et on inverse state.ctx.center.y (Y inverse).
export const drawPoint = (p, radius = 3, color = '#FFFFFF') => {
    if (!p) return
    let sp = modelToScreen(p)
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, radius, 0, TAU)
    state._ctx.stroke()
}

// Le curseur de la souris reste affiche en coords screen (l'inverse
// de Y ne s'applique pas au pointeur physique).
export const drawMouse = (p) => {
    if (!p) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = '#FFFFFF'
    state._ctx.beginPath()
    state._ctx.arc(p.x, p.y, 3, 0, TAU)
    state._ctx.stroke()
}

export const drawBoard = () => {
    state._ctx.fillStyle = '#000000'
    state._ctx.fillRect(0, 0, state.board.width, state.board.height)
    if (state.activeGrid) drawGrid()
    drawAxis()
    drawShapes()
    drawSelectedPoints()
    // Reticule : guide visuel au curseur. Mode 0 = off (early
    // return), mode 1 = crosshair simple au curseur, mode 2 =
    // crosshair au curseur + 3 miroirs aux positions (-x,y),
    // (x,-y), (-x,-y). Place apres drawSelectedPoints pour etre
    // visible au-dessus des formes et des points, mais avant
    // drawSelectionBox (overlay de selection qui reste au-dessus
    // de tout).
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
    let color = isDimmed ? 'rgba(0, 255, 255, 0.6)' : '#00FFFF'
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
    state._ctx.fillStyle = 'rgba(0, 255, 255, 0.15)'
    state._ctx.fillRect(x, y, w, h)
    state._ctx.strokeStyle = '#00FFFF'
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeRect(x, y, w, h)
    state._ctx.setLineDash([])
}

// L'axe suit l'origine (0,0) du modele en coords SCREEN. On utilise
// ici une projection directe (camera transform : zoom + viewCenter
// + center) plutot que modelToScreen. Numeriquement, depuis la
// suppression de la rotation de viewport, les deux donnent le meme
// resultat pour le point (0,0) ; mais la formule directe reste plus
// explicite ("l'axe depend uniquement du viewport") et protege
// contre tout couplage futur si modelToScreen evolue (filtres,
// snapping, etc).
//
// Avec le geste AltGr + molette, la "rotation de scene" mute les
// vertices de chaque forme (cf. rotateEachShapeAroundPivot dans
// main.js) ; les axes representent le REPERE modele (frame de
// reference fixe), donc ils restent ancres sur l'ecran pendant que
// le contenu tourne autour. Si l'origine est hors canvas apres un
// zoom, l'axe n'est pas trace (un seul stroke pour eviter de casser
// le motif dash).
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

// Reticule : crosshair(s) au curseur en coords modele. Mode 1 =
// simple (1 crosshair au curseur), mode 2 = projection
// symetrique (curseur + miroirs aux 3 positions
// signe-changees sur les 2 axes : (-x,y), (x,-y), (-x,-y)).
// Meme look que drawAxis (PATTERN_AXIS, lignes pleine largeur
// dans la zone visible) mais en n&b (blanc au lieu de
// COLOR_AXIS vert) pour distinguer le guide curseur des axes
// d'origine. Skip si curseur hors canvas (lastMousePos
// indefini). Les lignes sont clippees par les bornes du board
// pour eviter de tracer en dehors.
export const drawReticle = () => {
    if (typeof state.reticleMode === 'undefined' || state.reticleMode === 0) return
    if (typeof state.lastMousePos === 'undefined' || !state.lastMousePos) return
    let m = screenToModel(state.lastMousePos)
    if (!m) return
    // Mode 1 : juste le curseur. Mode 2 : + 3 miroirs. Quand le
    // curseur est sur un axe (m.x=0 ou m.y=0) ou a l'origine, les
    // 4 positions reduisent a 1 ou 2 positions uniques — on
    // retrace alors la meme ligne 2-4 fois (idempotent visuellement,
    // cout negligeable).
    let positions = [{ x: m.x, y: m.y }]
    if (state.reticleMode === 2) {
        positions.push({ x: -m.x, y: m.y })
        positions.push({ x: m.x, y: -m.y })
        positions.push({ x: -m.x, y: -m.y })
    }
    state._ctx.setLineDash(PATTERN_AXIS)
    state._ctx.strokeStyle = '#FFFFFF'
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

// Rend toutes les formes. Les inactives sont dessinees EN PREMIER
// (gris, dash elargi) puis la forme active PAR-DESSUS avec les couleurs
// d'origine. Cela permet a l'actif de rester toujours lisible meme
// quand une inactive lui passe devant dans l'ordre du tableau.
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
    let pointColor = isActive ? '#FFFF00' : POINT_COLOR_INACTIVE
    shape.triangles.forEach((t) => {
        drawTriangle(t.p1, t.p2, t.p3, linePattern, lineColor)
        drawPoint(t.p1, 2, pointColor)
        drawPoint(t.p2, 2, pointColor)
        drawPoint(t.p3, 2, pointColor)
    })
}

// pattern et color sont optionnels (compat avec l'ancien code qui
// appelait drawTriangle(p1,p2,p3) sans param de style).
export const drawTriangle = (p1, p2, p3, pattern, color) => {
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
            state._ctx.lineTo(s1.x, s1.y)
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

// La grille est alignee sur les axes du modele (donc sur
// l'origine (0,0) du repere) et non pas sur le centre du board.
// C'est ce que fait snapToGrid (arrondi au multiple de
// GRID_STEP le plus proche depuis 0) ; on aligne ici
// l'affichage sur la meme ancre pour que les intersections
// dessinees correspondent exactement aux positions vers
// lesquelles un point va se snapper. Voir l'historique du
// fix dans git (commit "Anchor drawGrid on model origin").
export const drawGrid = () => {
    const baseStep = typeof state.GRID_STEP !== 'undefined' ? state.GRID_STEP : 32
    if (!baseStep || baseStep <= 0) return
    const step = baseStep * state.ctx.zoomLevel
    if (step <= 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = '#333333'
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
