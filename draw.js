
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
    if(activeGrid) drawGrid()
    _ctx.fillStyle = '#000000'
    _ctx.fillRect(0,0,board.width,board.height)
    drawAxis()
    drawShapes()
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
    step = 16
    for(let x=step;x<_ctx.canvas.width;x+=step) {
        for(let y=step;y<_ctx.canvas.height;y+=step) {
            drawLine({x:x,y:y},{x:x+4,y:y+4},[],'#FFFFFF')
        }
    }
}
