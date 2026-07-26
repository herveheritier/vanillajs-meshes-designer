// Le systeme de coordonnees du modele est centre a (ctx.center.x,
// ctx.center.y) avec X vers la droite et Y vers le haut. Pour le
// rendu, on translate de ctx.center.x (decalage X) et on inverse
// ctx.center.y (Y inverse). Aucun appelant ne doit appeler drawPoint
// avec des coordonnees screen (utiliser drawMouse ou le draw direct).
drawPoint = (p, radius=3, color='#FFFFFF') => {
    if (!p) return
    _ctx.setLineDash([])
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.arc(ctx.center.x + p.x, ctx.center.y - p.y, radius, 0, TAU)
    _ctx.stroke()
}

// Le curseur de la souris reste affiche en coords screen (l'inverse de Y
// ne s'applique pas au pointeur physique).
drawMouse = (p) => {
    if (!p) return
    _ctx.setLineDash([])
    _ctx.strokeStyle = '#FFFFFF'
    _ctx.beginPath()
    _ctx.arc(p.x, p.y, 3, 0, TAU)
    _ctx.stroke()
}

drawBoard = () => {
    _ctx.fillStyle = '#000000'
    _ctx.fillRect(0,0,board.width,board.height)
    if(activeGrid) drawGrid()
    drawAxis()
    drawShapes()
    drawSelectedPoints()
    if (typeof isSelectingBox !== 'undefined' && isSelectingBox && selectionBoxStart && selectionBoxCurrent) {
        drawSelectionBox(selectionBoxStart, selectionBoxCurrent)
    }
}

drawSelectedPoints = () => {
    if (typeof selectedPoints === 'undefined' || !selectedPoints || selectedPoints.length === 0) return
    let isDimmed = typeof isSelectionDimmed !== 'undefined' && isSelectionDimmed
    let color = isDimmed ? 'rgba(0, 255, 255, 0.6)' : '#00FFFF'
    selectedPoints.forEach(p => {
        if (!p) return
        drawPoint(p, 6, color)
    })
}

drawSelectionBox = (p1, p2) => {
    if (!p1 || !p2) return
    let x = Math.min(p1.x, p2.x)
    let y = Math.min(p1.y, p2.y)
    let w = Math.abs(p2.x - p1.x)
    let h = Math.abs(p2.y - p1.y)
    _ctx.fillStyle = 'rgba(0, 255, 255, 0.15)'
    _ctx.fillRect(x, y, w, h)
    _ctx.strokeStyle = '#00FFFF'
    _ctx.setLineDash([4, 4])
    _ctx.strokeRect(x, y, w, h)
    _ctx.setLineDash([])
}

drawAxis = () => {
    _ctx.setLineDash(PATTERN_AXIS)
    _ctx.strokeStyle = COLOR_AXIS
    _ctx.beginPath()
    _ctx.moveTo(0, ctx.center.y)
    _ctx.lineTo(board.getBoundingClientRect().width, ctx.center.y)
    _ctx.stroke()
    _ctx.beginPath()
    _ctx.moveTo(ctx.center.x, 0)
    _ctx.lineTo(ctx.center.x, board.getBoundingClientRect().height)
    _ctx.stroke()
}

// Rend toutes les formes. Les inactives sont dessinees EN PREMIER
// (gris, dash elargi) puis la forme active PAR-DESSUS avec les couleurs
// d'origine. Cela permet a l'actif de rester toujours lisible meme
// quand une inactive lui passe devant dans l'ordre du tableau.
drawShapes = () => {
    if (typeof shapes === 'undefined' || !Array.isArray(shapes) || shapes.length === 0) return
    for (let i = 0; i < shapes.length; i++) {
        if (i === activeShapeIndex) continue
        drawShape(shapes[i], false)
    }
    drawShape(shapes[activeShapeIndex], true)
}

drawShape = (shape, isActive) => {
    if (!shape || !shape.triangles || shape.triangles.length === 0) return
    let lineColor = isActive ? COLOR_LINES : COLOR_LINES_INACTIVE
    let linePattern = isActive ? PATTERN_LINES : PATTERN_LINES_INACTIVE
    let pointColor = isActive ? '#FFFF00' : POINT_COLOR_INACTIVE
    shape.triangles.forEach(t => {
        drawTriangle(t.p1, t.p2, t.p3, linePattern, lineColor)
        drawPoint(t.p1, 2, pointColor)
        drawPoint(t.p2, 2, pointColor)
        drawPoint(t.p3, 2, pointColor)
    })
}

// pattern et color sont optionnels (compat avec l'ancien code qui
// appelait drawTriangle(p1,p2,p3) sans param de style).
drawTriangle = (p1, p2, p3, pattern, color) => {
    if (!p1) return
    _ctx.setLineDash(pattern !== undefined ? pattern : PATTERN_LINES)
    _ctx.strokeStyle = color !== undefined ? color : COLOR_LINES
    _ctx.beginPath()
    _ctx.moveTo(ctx.center.x + p1.x, ctx.center.y - p1.y)
    if (p2 !== undefined) {
        _ctx.lineTo(ctx.center.x + p2.x, ctx.center.y - p2.y)
        if (p3 !== undefined) {
            _ctx.lineTo(ctx.center.x + p3.x, ctx.center.y - p3.y)
            _ctx.lineTo(ctx.center.x + p1.x, ctx.center.y - p1.y)
        }
    }
    _ctx.stroke()
}

drawLine = (p1, p2, pattern, color) => {
    if (!p1 || !p2) return
    _ctx.setLineDash(pattern)
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.moveTo(ctx.center.x + p1.x, ctx.center.y - p1.y)
    _ctx.lineTo(ctx.center.x + p2.x, ctx.center.y - p2.y)
    _ctx.stroke()
}

drawGrid = () => {
    const step = typeof GRID_STEP !== 'undefined' ? GRID_STEP : 32
    if (!step || step <= 0) return
    _ctx.setLineDash([])
    _ctx.strokeStyle = '#333333'
    _ctx.beginPath()
    // Lignes verticales: symetriques autour de ctx.center.x (model x=0
    // est au centre du canvas apres centrage de l'axe X).
    let maxOffsetX = Math.max(ctx.center.x, board.width - ctx.center.x)
    for (let k = 1; k * step <= maxOffsetX; k++) {
        let xLeft = ctx.center.x - k * step
        let xRight = ctx.center.x + k * step
        if (xLeft >= 0) {
            _ctx.moveTo(xLeft, 0)
            _ctx.lineTo(xLeft, board.height)
        }
        if (xRight <= board.width) {
            _ctx.moveTo(xRight, 0)
            _ctx.lineTo(xRight, board.height)
        }
    }
    // Lignes horizontales: symetriques autour de ctx.center.y.
    let maxOffsetY = Math.max(ctx.center.y, board.height - ctx.center.y)
    for (let k = 1; k * step <= maxOffsetY; k++) {
        let yTop = ctx.center.y - k * step
        let yBottom = ctx.center.y + k * step
        if (yTop >= 0) {
            _ctx.moveTo(0, yTop)
            _ctx.lineTo(board.width, yTop)
        }
        if (yBottom <= board.height) {
            _ctx.moveTo(0, yBottom)
            _ctx.lineTo(board.width, yBottom)
        }
    }
    _ctx.stroke()
}
