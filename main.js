const TAU = 2 * Math.PI
const COLOR_AXIS = '#00A000'
const COLOR_LINES = '#FFFFFF'
const PATTERN_AXIS = [2,1,3,1]
const PATTERN_LINES = [2,2]
const ACTION_NONE = undefined
const ACTION_GRABBING = 1
let ctx = {
    center: { x: 50, y: 50 }, 
    viewCenter: { x: 50, y: 50 },
    zoomLevel: 1
}
let triangles = []
let nearestLine = undefined
let nearestPoint = undefined
let lastMousePos = undefined
let currentAction = undefined
let grabbedPoint = []
let relativeGrabbingPosition = undefined
let activeGrid = false

let historyStack = []
let redoStack = []
const MAX_HISTORY = 50

cloneTriangles = (triArray) => {
    let pointMap = new Map()
    return triArray.map(t => {
        let nt = {}
        if (t.p1) {
            if (!pointMap.has(t.p1)) pointMap.set(t.p1, { x: t.p1.x, y: t.p1.y })
            nt.p1 = pointMap.get(t.p1)
        }
        if (t.p2) {
            if (!pointMap.has(t.p2)) pointMap.set(t.p2, { x: t.p2.x, y: t.p2.y })
            nt.p2 = pointMap.get(t.p2)
        }
        if (t.p3) {
            if (!pointMap.has(t.p3)) pointMap.set(t.p3, { x: t.p3.x, y: t.p3.y })
            nt.p3 = pointMap.get(t.p3)
        }
        return nt
    })
}

saveState = () => {
    historyStack.push(cloneTriangles(triangles))
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift()
    }
    redoStack = []
}

undo = () => {
    if (historyStack.length === 0) return
    currentAction = ACTION_NONE
    redoStack.push(cloneTriangles(triangles))
    triangles = historyStack.pop()
    nearestPoint = undefined
    nearestLine = undefined
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
    log("Undo")
}

redo = () => {
    if (redoStack.length === 0) return
    currentAction = ACTION_NONE
    historyStack.push(cloneTriangles(triangles))
    triangles = redoStack.pop()
    nearestPoint = undefined
    nearestLine = undefined
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
    log("Redo")
}

let board = document.querySelector('#board')
let body = document.querySelector('body')
let messageBoard = document.querySelector('#messageBoard')
body.style.overflow = 'hidden'
board.style.border = 'solid 1px black'
board.style.width = '99vw'
board.style.height = '99vh'
board.width=board.getBoundingClientRect().width
board.height=board.getBoundingClientRect().height
board.style.cursor = 'none'
ctx.center.x = board.width / 2
ctx.center.y = board.height / 2
ctx.viewCenter = ctx.center
let _ctx =  board.getContext("2d")
_ctx.fillStyle = '#000000'
_ctx.fillRect(0,0,board.width,board.height)
messageBoard.innerText = '*** CONSOLE ***'

document.querySelector('#grid').addEventListener("click",(e) => {
    activeGrid = !activeGrid
})

document.addEventListener("contextmenu", (e) => {
    if(e.target.id==='board') e.preventDefault();
}, false);

document.addEventListener('mousemove',(e) => {
    if(e.target.id==='board') resolveMouseMoveOnBoard(e)
})

document.addEventListener('mouseup',(e) => {
    if(grabbed()) endGrabbing(e)
    if(e.target.id==='board' && e.button===0) resolveMouseClickOnBoard(e)
})

document.addEventListener('mousedown',(e) => {
    if(e.target.id==='board' && e.button===2) beginGrabbing(e)
})

document.addEventListener('keydown',(e) => {
    if(e.code==='Backspace') {
        deleteSelectedPoint()
    } 
    if((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code==='KeyZ' || e.key==='z' || e.key==='Z')) {
        e.preventDefault()
        redo()
    } else if((e.ctrlKey || e.metaKey) && (e.code==='KeyZ' || e.key==='z' || e.key==='Z')) {
        e.preventDefault()
        undo()
    } else if((e.ctrlKey || e.metaKey) && (e.code==='KeyY' || e.key==='y' || e.key==='Y')) {
        e.preventDefault()
        redo()
    }
})

deleteSelectedPoint = () => {
    if(!nearestPoint || !nearestPoint.point) return
    let target = nearestPoint.point
    saveState()
    triangles = triangles.filter(t => {
        let hasP1 = t.p1 && adjacentPoints(t.p1, target, 0.01)
        let hasP2 = t.p2 && adjacentPoints(t.p2, target, 0.01)
        let hasP3 = t.p3 && adjacentPoints(t.p3, target, 0.01)
        return !(hasP1 || hasP2 || hasP3)
    })
    nearestPoint = undefined
    drawBoard()
    if(lastMousePos) {
        updateMouseHover(lastMousePos)
    }
}

log = (message) => {
    messageBoard.innerText += '\n'+message
}

grabbed = () => {
    return currentAction === ACTION_GRABBING
}

beginGrabbing = (e) => {
    currentAction = ACTION_GRABBING
    let point = { 
        x : e.x-board.getBoundingClientRect().x,
        y : e.y-board.getBoundingClientRect().y
    }
    grabbedPoint = []
    let np = findNearestPoint(point)
    if(!np || !np.point) return
    saveState()
    relativeGrabbingPosition = { dx:np.point.x - point.x, dy:np.point.y - point.y }
    grabbedPoint.push(np)
    triangles.forEach( (e,i) => {
        if(i<=np.triangleIndex) return
        [e.p1,e.p2,e.p3].forEach( (p,j) => {
            if(!p) return
            let d = Math.hypot(p.x-np.point.x,p.y-np.point.y)
            if(d < 0.01) grabbedPoint.push({ triangleIndex:i, pointId:`p${j+1}` })
        })
    })
}

endGrabbing = (e) => {
    currentAction = ACTION_NONE
    // Force the cursor to display after the grabbing; 
    // otherwise it will only appear after a move.
    resolveMouseMoveOnBoard(e) 
}

resolveMouseMoveOnBoard = (e) => {
    let point = undefined
    if(grabbed()) {
        point = { 
            x : e.x-board.getBoundingClientRect().x + relativeGrabbingPosition.dx,
            y : e.y-board.getBoundingClientRect().y + relativeGrabbingPosition.dy
        }
        grabbedPoint.forEach((e,i) => {
            triangles[e.triangleIndex][e.pointId] = point
        })
    } else {
        point = { 
            x : e.x-board.getBoundingClientRect().x,
            y : e.y-board.getBoundingClientRect().y
        }
    }
    lastMousePos = point
    updateMouseHover(point)
}

updateMouseHover = (point) => {
    drawBoard()
    drawMouse(point)
    nearestPoint = findNearestPoint(point)
    if(nearestPoint && nearestPoint.point) {
        drawPoint(nearestPoint.point, 5, '#00FF00')
    }
    nearestLine = findSelectedLine(point)
    if(nearestLine && nearestLine.firstPoint && nearestLine.secondPoint) {
        drawLine(nearestLine.firstPoint, nearestLine.secondPoint, [], '#00FF00')
    }
}

resolveMouseClickOnBoard = (e) =>  {
    let point = {
        x : rvx(e.x-board.getBoundingClientRect().x), 
        y : rvy(e.y-board.getBoundingClientRect().y)
    }
    addPoint(point)
    drawBoard()
    drawMouse(e.x-board.getBoundingClientRect().x,e.y-board.getBoundingClientRect().y)
}

findNearestPoint = (point) => {
    return findNextNearestPoint({ point:point, triangleIndex:-1 })
}

findNextNearestPoint = (nearestPoint) => {
    let shortDistance = Number.MAX_VALUE
    let shortIndex = -1
    let shortPointIndex = -1
    triangles.forEach( (e,i) => {
        if(i<=nearestPoint.triangleIndex) return
        [e.p1,e.p2,e.p3].forEach( (p,j) => {
            if(!p) return
            let d = Math.hypot(p.x-nearestPoint.point.x,p.y-nearestPoint.point.y)
            if(d < shortDistance) {
                shortIndex = i
                shortDistance = d
                shortPointIndex = j
            }
        })
    })
    if(shortIndex<0) return undefined
    let pointId = ['p1','p2','p3'][shortPointIndex]
    result =  { 
        triangleIndex:shortIndex, 
        distance:shortDistance, 
        pointIndex:shortPointIndex,
        triangle:triangles[shortIndex],
        pointId:pointId,
        point:triangles[shortIndex][pointId]
    }
    return result
} 

findNearestLine = (point) => {
    let shortDistance = Number.MAX_VALUE
    let shortPointIndex = -1
    let np = findNearestPoint(point)
    if(!np || !np.triangle) return undefined
    let tt = [
        { id:"p1", index:0, point:np.triangle.p1 },
        { id:"p2", index:1, point:np.triangle.p2 },
        { id:"p3", index:2, point:np.triangle.p3 }
    ]
    tt.splice(np.pointIndex,1)
    tt.forEach( (e,j) => {
            if(!e.point) return
            let d = Math.hypot(e.point.x-point.x,e.point.y-point.y)
            if(d < shortDistance) {
                shortDistance = d
                shortPointIndex = e.index
            }
        }
    )
    let pointId = ['p1','p2','p3'][shortPointIndex]
    return { 
        index:np.shortIndex, 
        firstPointIndex:np.pointIndex,
        secondPointIndex:shortPointIndex,
        triangle:np.triangle,
        firstPointId:np.pointId,
        secondPointId:pointId,
        firstPoint:np.triangle[np.pointId],
        secondPoint:np.triangle[pointId]
    }
} 

findSelectedLine = (point) => {
    let shortDistance = Number.MAX_VALUE
    let shortTriangleIndex = -1
    let shortLineIndex = -1
    triangles.forEach((t,i) => {
        if(!t.p1 || !t.p2 || !t.p3) return
        let cop = computeOrthogonalProjection(point,t.p1,t.p2)
        let d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if(d < shortDistance && isInsideSegmentByDot(cop,t.p1,t.p2)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 0
        }
        cop = computeOrthogonalProjection(point,t.p2,t.p3)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if(d < shortDistance && isInsideSegmentByDot(cop,t.p2,t.p3)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 1
        }
        cop = computeOrthogonalProjection(point,t.p3,t.p1)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if(d < shortDistance && isInsideSegmentByDot(cop,t.p3,t.p1)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 2
        }
    })
    if(shortTriangleIndex < 0) return undefined
    let firstPointId = ['p1','p2','p3'][shortLineIndex]
    let secondPointId = ['p2','p3','p1'][shortLineIndex]
    return {
        triangleIndex:shortTriangleIndex, 
        firstPointIndex:[0,1,2][shortLineIndex],
        secondPointIndex:[1,2,0][shortLineIndex],
        triangle:triangles[shortTriangleIndex],
        firstPointId:firstPointId,
        secondPointId:secondPointId,
        firstPoint:triangles[shortTriangleIndex][firstPointId],
        secondPoint:triangles[shortTriangleIndex][secondPointId]
    }
}

computeOrthogonalProjection = (p,p1,p2) => {
    let dx = p2.x - p1.x
    let dy = p2.y - p1.y
    let t = ((p.x - p1.x)*dx + (p.y - p1.y)*dy)/(dx*dx + dy*dy)
    return { 
        x: p1.x + t*dx,
        y: p1.y + t*dy
    } 
}

scalarProduct = (ax, ay, bx, by) => {
  return ax * bx + ay * by
}

isInsideSegmentByDot = (p,p1,p2) => {
  const ahx = p.x - p1.x, ahy = p.y - p1.y
  const bhx = p.x - p2.x, bhy = p.y - p2.y
  return scalarProduct(ahx, ahy, bhx, bhy) <= 0
}

addPoint = (point) => {
    // exclure un point déjà occupé (tolérance : < 1)
    for (let i = 0; i < triangles.length; i++) {
        let triangle = triangles[i]
        if(adjacentPoints(point,triangle.p1,1)) return
        if(triangle.p2!==undefined) if(adjacentPoints(point,triangle.p2,1)) return
        if(triangle.p3!==undefined) if(adjacentPoints(point,triangle.p3,1)) return
    }
    saveState()
    if (triangles.length===0) {
        triangles.push({p1:point})
    } 
    else {
        triangle = triangles.at(-1)
        if(triangle.p2===undefined) {
            triangle.p2 = point
        }
        else if(triangle.p3===undefined) {
            triangle.p3 = point
        }
        else {
            triangles.push({
                p1:nearestLine.firstPoint,
                p2:nearestLine.secondPoint,
                p3:point
            })
        }
    }
    ctx.workIsSaved = 0;
    ctx.workIsBackuped = 0;
}

adjacentPoints = (p1,p2,tolerance) => {
    return Math.hypot(p1.x - p2.x,p1.y - p2.y) < tolerance
} 

rvx = (x) => {
    return ( x - ctx.viewCenter.x + ctx.zoomLevel * ctx.viewCenter.x ) / ctx.zoomLevel
}

rvy = (y) => {
    return ( y  - ctx.viewCenter.y + ctx.zoomLevel * ctx.viewCenter.y ) / ctx.zoomLevel
}

