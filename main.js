const TAU = 2 * Math.PI
const COLOR_AXIS = '#00A000'
const COLOR_LINES = '#FFFFFF'
const PATTERN_AXIS = [2,1,3,1]
const PATTERN_LINES = [2,2]
const DEFAULT_GRID_STEP = 32
let GRID_STEP = DEFAULT_GRID_STEP
const MIN_GRID_STEP = 8
const MAX_GRID_STEP = 128
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

snapToGrid = (point) => {
    if (!activeGrid || !point) return point
    return {
        x: Math.round(point.x / GRID_STEP) * GRID_STEP,
        y: Math.round(point.y / GRID_STEP) * GRID_STEP
    }
}
let selectedPoints = []
let isSelectingBox = false
let selectionBoxStart = undefined
let selectionBoxCurrent = undefined
let grabbedGroup = []
let grabStartMouse = undefined

getAllVertices = () => {
    let vertices = []
    triangles.forEach(t => {
        [t.p1, t.p2, t.p3].forEach(p => {
            if (p && !vertices.some(v => adjacentPoints(v, p, 0.01))) {
                vertices.push(p)
            }
        })
    })
    return vertices
}

isPointSelected = (p) => {
    if (!p) return false
    return selectedPoints.some(sp => adjacentPoints(sp, p, 0.01))
}

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
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
}

redo = () => {
    if (redoStack.length === 0) return
    currentAction = ACTION_NONE
    historyStack.push(cloneTriangles(triangles))
    triangles = redoStack.pop()
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
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

updateGridButtonText = () => {
    let gridBtn = document.querySelector('#grid')
    if (!gridBtn) return
    if (activeGrid) {
        gridBtn.innerText = `# (${GRID_STEP}px)`
    } else {
        gridBtn.innerText = `#`
    }
}

let gridBtn = document.querySelector('#grid')

gridBtn.addEventListener("click",(e) => {
    if (e.button !== 0) return
    activeGrid = !activeGrid
    updateGridButtonText()
    drawBoard()
})

gridBtn.addEventListener("wheel", (e) => {
    if (!activeGrid) return
    e.preventDefault()
    if (e.deltaY < 0) {
        GRID_STEP = Math.min(MAX_GRID_STEP, GRID_STEP + 4)
    } else if (e.deltaY > 0) {
        GRID_STEP = Math.max(MIN_GRID_STEP, GRID_STEP - 4)
    }
    updateGridButtonText()
    drawBoard()
}, { passive: false })

gridBtn.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
        e.preventDefault()
        if (!activeGrid) return
        GRID_STEP = DEFAULT_GRID_STEP
        updateGridButtonText()
        drawBoard()
    }
})

gridBtn.addEventListener("mousedown", (e) => {
    if (e.button === 1) {
        e.preventDefault()
    }
})

updateGridButtonText()

document.addEventListener("contextmenu", (e) => {
    if(e.target.id==='board') e.preventDefault();
}, false);

document.addEventListener('mousemove',(e) => {
    if(e.target.id==='board') resolveMouseMoveOnBoard(e)
})

document.addEventListener('mouseup',(e) => {
    if(grabbed()) endGrabbing(e)
    if(e.target.id==='board' && e.button===0) {
        if(isSelectingBox) {
            let dist = Math.hypot(selectionBoxCurrent.x - selectionBoxStart.x, selectionBoxCurrent.y - selectionBoxStart.y)
            isSelectingBox = false
            if(dist < 5) {
                let mousePos = { x: e.x - board.getBoundingClientRect().x, y: e.y - board.getBoundingClientRect().y }
                let np = findNearestPoint(mousePos)
                if(np && np.distance < 15) {
                    if(!e.shiftKey) {
                        selectedPoints = [np.point]
                    } else {
                        if(isPointSelected(np.point)) {
                            selectedPoints = selectedPoints.filter(p => !adjacentPoints(p, np.point, 0.01))
                        } else {
                            selectedPoints.push(np.point)
                        }
                    }
                } else {
                    if(!e.shiftKey) {
                        selectedPoints = []
                    }
                    resolveMouseClickOnBoard(e)
                }
            }
            drawBoard()
        }
    }
})

document.addEventListener('mousedown',(e) => {
    if(e.target.id==='board') {
        let mousePos = { x: e.x - board.getBoundingClientRect().x, y: e.y - board.getBoundingClientRect().y }
        if(e.button===2) {
            beginGrabbing(e)
        } else if(e.button===0) {
            selectionBoxStart = mousePos
            selectionBoxCurrent = mousePos
            isSelectingBox = true
        }
    }
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
    let targets = selectedPoints.length > 0 ? [...selectedPoints] : (nearestPoint && nearestPoint.point ? [nearestPoint.point] : [])
    if(targets.length === 0) return
    saveState()
    triangles = triangles.filter(t => {
        let hasP1 = t.p1 && targets.some(target => adjacentPoints(t.p1, target, 0.01))
        let hasP2 = t.p2 && targets.some(target => adjacentPoints(t.p2, target, 0.01))
        let hasP3 = t.p3 && targets.some(target => adjacentPoints(t.p3, target, 0.01))
        return !(hasP1 || hasP2 || hasP3)
    })
    selectedPoints = []
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
    let mousePos = { 
        x : e.x-board.getBoundingClientRect().x,
        y : e.y-board.getBoundingClientRect().y
    }
    let np = findNearestPoint(mousePos)
    if(!np || !np.point) return

    currentAction = ACTION_GRABBING
    grabStartMouse = mousePos
    saveState()

    if(!isPointSelected(np.point)) {
        if(!e.shiftKey) {
            selectedPoints = [np.point]
        } else {
            selectedPoints.push(np.point)
        }
    }

    grabbedGroup = []
    selectedPoints.forEach(sp => {
        triangles.forEach( (t,i) => {
            [t.p1,t.p2,t.p3].forEach( (p,j) => {
                if(p && adjacentPoints(p, sp, 0.01)) {
                    grabbedGroup.push({
                        triangleIndex: i,
                        pointId: `p${j+1}`,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: sp
                    })
                }
            })
        })
    })
}

endGrabbing = (e) => {
    currentAction = ACTION_NONE
    resolveMouseMoveOnBoard(e) 
}

resolveMouseMoveOnBoard = (e) => {
    let mousePos = { 
        x : e.x-board.getBoundingClientRect().x,
        y : e.y-board.getBoundingClientRect().y
    }

    if(isSelectingBox) {
        selectionBoxCurrent = mousePos
        let minX = Math.min(selectionBoxStart.x, selectionBoxCurrent.x)
        let maxX = Math.max(selectionBoxStart.x, selectionBoxCurrent.x)
        let minY = Math.min(selectionBoxStart.y, selectionBoxCurrent.y)
        let maxY = Math.max(selectionBoxStart.y, selectionBoxCurrent.y)

        let allV = getAllVertices()
        selectedPoints = allV.filter(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)
    } else if(grabbed()) {
        let dx = mousePos.x - grabStartMouse.x
        let dy = mousePos.y - grabStartMouse.y
        grabbedGroup.forEach(item => {
            let targetPos = { x: item.startX + dx, y: item.startY + dy }
            if(activeGrid) {
                targetPos = snapToGrid(targetPos)
            }
            triangles[item.triangleIndex][item.pointId] = targetPos
            if (item.selectedPointRef) {
                item.selectedPointRef.x = targetPos.x
                item.selectedPointRef.y = targetPos.y
            }
        })
    }

    lastMousePos = mousePos
    updateMouseHover(mousePos, snapToGrid(mousePos))
}

updateMouseHover = (cursorPoint, actionPoint = cursorPoint) => {
    drawBoard()
    drawMouse(cursorPoint)
    let target = activeGrid ? snapToGrid(actionPoint) : actionPoint
    nearestPoint = findNearestPoint(target)
    if(nearestPoint && nearestPoint.point) {
        drawPoint(nearestPoint.point, 5, '#00FF00')
    }
    nearestLine = findSelectedLine(target)
    if(nearestLine && nearestLine.firstPoint && nearestLine.secondPoint) {
        drawLine(nearestLine.firstPoint, nearestLine.secondPoint, [], '#00FF00')
    }
}

resolveMouseClickOnBoard = (e) =>  {
    let mousePos = {
        x : rvx(e.x-board.getBoundingClientRect().x), 
        y : rvy(e.y-board.getBoundingClientRect().y)
    }
    let pointToAdd = snapToGrid(mousePos)
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mousePos)
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
