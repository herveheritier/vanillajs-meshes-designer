
drawPoint = (p,radius=3,color='#FFFFFF') => {
    if(!p) return
    _ctx.setLineDash([])
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.arc(p.x,p.y,radius,0,TAU)
    _ctx.stroke()
}

drawMouse = (p) => {
    drawPoint(p,3,'#FFFFFF')
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
    selectedPoints.forEach(p => {
        if (!p) return
        drawPoint(p, 6, '#00FFFF')
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

drawShapes = () => {
    if(triangles.length===0) return
    triangles.forEach( (e,i,a) => {
        drawTriangle(e.p1,e.p2,e.p3)
        drawPoint(e.p1,2,'#FFFF00')
        drawPoint(e.p2,2,'#FFFF00')
        drawPoint(e.p3,2,'#FFFF00')
    })
}

drawTriangle = (p1,p2,p3) => {
    _ctx.setLineDash(PATTERN_LINES)
    _ctx.strokeStyle = COLOR_LINES
    _ctx.beginPath()
    _ctx.moveTo(p1.x,p1.y)
    if(p2!==undefined) {
        _ctx.lineTo(p2.x,p2.y)
        if(p3!==undefined) {
            _ctx.lineTo(p3.x,p3.y)
            _ctx.lineTo(p1.x,p1.y)
        }
    }
    _ctx.stroke()
}

drawLine = (p1,p2,pattern,color) => {
    if(!p1 || !p2) return
    _ctx.setLineDash(pattern)
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.moveTo(p1.x,p1.y)
    _ctx.lineTo(p2.x,p2.y)
    _ctx.stroke()
}

drawGrid = () => {
    const step = typeof GRID_STEP !== 'undefined' ? GRID_STEP : 32
    _ctx.setLineDash([])
    _ctx.strokeStyle = '#333333'
    _ctx.beginPath()
    for (let x = step; x < board.width; x += step) {
        _ctx.moveTo(x, 0)
        _ctx.lineTo(x, board.height)
    }
    for (let y = step; y < board.height; y += step) {
        _ctx.moveTo(0, y)
        _ctx.lineTo(board.width, y)
    }
    _ctx.stroke()
}
