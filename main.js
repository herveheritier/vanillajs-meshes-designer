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

// Le systeme de coordonnees du modele est en convention maths:
// origine au centre du canvas (ctx.center.x, ctx.center.y), X+ vers
// la droite, Y+ vers le haut. Les coordonnees capturees depuis les
// evenements souris (e.clientX/Y relatives au board) sont en coords
// screen (origine top-left, Y vers le bas). screenToModel fait la
// conversion.
screenToModel = (screen) => {
    if (!screen) return undefined
    return { x: screen.x - ctx.center.x, y: ctx.center.y - screen.y }
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

getPointsAtSamePosition = (p, tolerance = 0.01) => {
    if (!p) return []
    let result = []
    triangles.forEach(t => {
        [t.p1, t.p2, t.p3].forEach(q => {
            if (q && adjacentPoints(p, q, tolerance) && !result.some(r => r === q)) {
                result.push(q)
            }
        })
    })
    return result
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
    persistState()
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
    persistState()
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
    persistState()
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
    persistState()
}, { passive: false })

gridBtn.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
        e.preventDefault()
        if (!activeGrid) return
        GRID_STEP = DEFAULT_GRID_STEP
        updateGridButtonText()
        drawBoard()
        persistState()
    }
})

gridBtn.addEventListener("mousedown", (e) => {
    if (e.button === 1) {
        e.preventDefault()
    }
})

updateGridButtonText()

let exportBtn = document.querySelector('#export')
exportBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    downloadMesh()
})

let resetBtn = document.querySelector('#reset')
resetBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    if (!confirm('Réinitialiser le mesh ?')) return
    resetAll()
})

selectAllPoints = () => {
    let result = []
    getAllVertices().forEach(p => {
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    selectedPoints = result
    nearestPoint = undefined
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
}

let selectAllBtn = document.querySelector('#selectAll')
selectAllBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    selectAllPoints()
})

let importAlphabet2Btn = document.querySelector('#importAlphabet2')
importAlphabet2Btn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    let input = document.querySelector('#importAlphabet2File')
    if (!input) {
        input = document.createElement('input')
        input.type = 'file'
        input.id = 'importAlphabet2File'
        input.hidden = true  // cache l'input (sinon il apparait dans la page)
        // Pas de filtre accept: les fichiers alphabet2 n'ont souvent pas
        // d'extension (ex: assets/alphabet2). Un filtre MIME/extension
        // strict masque ces fichiers dans le picker. On laisse le
        // navigateur montrer TOUS les fichiers, la validation se fait
        // dans importAlphabet2FromFile.
        document.body.appendChild(input)
        input.addEventListener('change', (evt) => {
            let f = evt.target.files && evt.target.files[0]
            if (f) importAlphabet2FromFile(f)
            evt.target.value = ''
        })
    }
    input.click()
})

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
                let mouseScreen = { x: e.x - board.getBoundingClientRect().x, y: e.y - board.getBoundingClientRect().y }
                let np = findNearestPoint(screenToModel(mouseScreen))
                if(np && np.distance < 15) {
                    let pointsAtPos = getPointsAtSamePosition(np.point)
                    if(!e.shiftKey) {
                        selectedPoints = [...pointsAtPos]
                    } else {
                        let anySelected = pointsAtPos.some(p => isPointSelected(p))
                        if(anySelected) {
                            selectedPoints = selectedPoints.filter(sp => !pointsAtPos.some(p => adjacentPoints(sp, p, 0.01)))
                        } else {
                            pointsAtPos.forEach(p => {
                                if(!isPointSelected(p)) selectedPoints.push(p)
                            })
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
        if (e.shiftKey) {
            resetAll()
        } else {
            deleteSelectedPoint()
        }
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
    } else if((e.ctrlKey || e.metaKey) && (e.code==='KeyS' || e.key==='s' || e.key==='S')) {
        e.preventDefault()
        downloadMesh()
    }
})

let isSelectionDimmed = false

board.addEventListener('wheel', (e) => {
    if (selectedPoints.length >= 2 && !isSelectionDimmed) {
        e.preventDefault()
        let boardRect = board.getBoundingClientRect()
        // Le centre de rotation est fourni en coords model (X centre,
        // Y inverse).
        let center = { x: (e.x - boardRect.x) - ctx.center.x, y: ctx.center.y - (e.y - boardRect.y) }
        let angleStep = (5 * Math.PI) / 180
        let angle = e.deltaY < 0 ? -angleStep : angleStep
        rotateSelectedPoints(center, angle)
    }
}, { passive: false })

board.addEventListener("dragover", (e) => {
    e.preventDefault()
})
board.addEventListener("drop", (e) => {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    let file = e.dataTransfer.files[0]
    importMeshFromFile(file)
})

let isWheelRotating = false
let wheelRotateTimer = undefined

rotateSelectedPoints = (center, angle) => {
    if (selectedPoints.length < 2 || isSelectionDimmed) return
    if (!isWheelRotating) {
        saveState()
        isWheelRotating = true
    }
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = setTimeout(() => {
        isWheelRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    selectedPoints.forEach(sp => {
        let dx = sp.x - center.x
        let dy = sp.y - center.y
        let nx = center.x + dx * cos - dy * sin
        let ny = center.y + dx * sin + dy * cos

        let target = { x: nx, y: ny }
        if (activeGrid) {
            target = snapToGrid(target)
        }

        triangles.forEach(t => {
            [t.p1, t.p2, t.p3].forEach(p => {
                if (p && adjacentPoints(p, sp, 0.01)) {
                    p.x = target.x
                    p.y = target.y
                }
            })
        })

        sp.x = target.x
        sp.y = target.y
    })

    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
}

deleteSelectedPoint = () => {
    let targets = []
    if (selectedPoints.length > 0) {
        targets = [...selectedPoints]
    } else if (nearestPoint && nearestPoint.point) {
        targets = getPointsAtSamePosition(nearestPoint.point)
    }
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
    persistState()
}

log = (message) => {
    messageBoard.innerText += '\n'+message
}

grabbed = () => {
    return currentAction === ACTION_GRABBING
}

beginGrabbing = (e) => {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }
    let np = findNearestPoint(screenToModel(mouseScreen))
    if(!np || !np.point) return

    currentAction = ACTION_GRABBING
    grabStartMouse = mouseScreen
    saveState()

    if(!isPointSelected(np.point)) {
        let pointsAtPos = getPointsAtSamePosition(np.point)
        if(!e.shiftKey) {
            selectedPoints = [...pointsAtPos]
        } else {
            pointsAtPos.forEach(p => {
                if(!isPointSelected(p)) selectedPoints.push(p)
            })
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
    persistState()
}

resolveMouseMoveOnBoard = (e) => {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }

    if(isSelectingBox) {
        selectionBoxCurrent = mouseScreen
        let minXS = Math.min(selectionBoxStart.x, selectionBoxCurrent.x)
        let maxXS = Math.max(selectionBoxStart.x, selectionBoxCurrent.x)
        // Selection box: les coords sont en screen. Pour filtrer les
        // vertex en model, on inverse min/max Y et on shifte min/max X.
        let minYS_screen = Math.min(selectionBoxStart.y, selectionBoxCurrent.y)
        let maxYS_screen = Math.max(selectionBoxStart.y, selectionBoxCurrent.y)
        let minYM = Math.min(ctx.center.y - minYS_screen, ctx.center.y - maxYS_screen)
        let maxYM = Math.max(ctx.center.y - minYS_screen, ctx.center.y - maxYS_screen)
        let minXM = minXS - ctx.center.x
        let maxXM = maxXS - ctx.center.x

        let allV = getAllVertices()
        let inBox = allV.filter(p => p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM)
        let expanded = []
        inBox.forEach(p => {
            getPointsAtSamePosition(p).forEach(q => {
                if(!expanded.some(e => e === q)) expanded.push(q)
            })
        })
        selectedPoints = expanded
    } else if(grabbed()) {
        // dx: meme sens screen/model
        let dx = mouseScreen.x - grabStartMouse.x
        // dy_model: inverse du deplacement screen (haut souris = +Y model)
        let dy = grabStartMouse.y - mouseScreen.y
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

    lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
}

// Met a jour le hover (point le plus proche, dim de la selection, etc).
// Le curseur est dessine en screen. Le calcul du nearestPoint/Line
// se fait en coords model (Y inverse).
updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    let actionModel = screenToModel(cursorScreen)
    let target = activeGrid ? snapToGrid(actionModel) : actionModel
    nearestPoint = findNearestPoint(target)

    if (selectedPoints.length > 0 && nearestPoint && nearestPoint.point && !isPointSelected(nearestPoint.point)) {
        isSelectionDimmed = true
    } else {
        isSelectionDimmed = false
    }

    drawBoard()
    drawMouse(cursorScreen)

    if (nearestPoint && nearestPoint.point) {
        drawPoint(nearestPoint.point, 5, '#00FF00')
    }
    nearestLine = findSelectedLine(target)
    if (nearestLine && nearestLine.firstPoint && nearestLine.secondPoint) {
        drawLine(nearestLine.firstPoint, nearestLine.secondPoint, [], '#00FF00')
    }
}

// Affiche la position du curseur et du point le plus proche dans le
// HUD en bas de l'ecran, en coords model (Y inverse, origine au centre).
// Vide le HUD si pas de curseur. Utilise textContent (pas innerText) pour
// eviter un reflow a chaque mousemove.
updateCoordsDisplay = (cursorScreen) => {
    let div = document.querySelector('#coords')
    if (!div) return
    if (!cursorScreen) {
        div.textContent = ''
        return
    }
    let m = screenToModel(cursorScreen)
    let np = (nearestPoint && nearestPoint.point) ? nearestPoint.point : null
    let cursorTxt = `(${Math.round(m.x)}, ${Math.round(m.y)})`
    let nearestTxt = np ? `(${Math.round(np.x)}, ${Math.round(np.y)})` : '\u2014'
    div.textContent = `curseur ${cursorTxt}  plus proche ${nearestTxt}`
}

resolveMouseClickOnBoard = (e) =>  {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }
    let pointToAdd = snapToGrid(screenToModel(mouseScreen))
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
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
    persistState()
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

STORAGE_KEY = 'mesh-designer-state'
let persistTimer = undefined

serializeState = () => {
    let pointList = []
    let pointMap = new Map()
    let tris = triangles.map(t => {
        let nt = {}
        ;['p1','p2','p3'].forEach(key => {
            let p = t[key]
            if (p) {
                if (!pointMap.has(p)) {
                    pointMap.set(p, pointList.length)
                    pointList.push({ x: p.x, y: p.y })
                }
                nt[key] = pointMap.get(p)
            }
        })
        return nt
    })
    return JSON.stringify({ tris: tris, pointList: pointList, activeGrid: activeGrid, GRID_STEP: GRID_STEP })
}

persistState = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, serializeState())
            ctx.workIsSaved = 1
        } catch (e) {
            log('Persist fail: ' + e.message)
        }
    }, 150)
}

loadState = () => {
    let saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
        let data = JSON.parse(saved)
        if (data.activeGrid !== undefined) activeGrid = !!data.activeGrid
        if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        let restoredPoints = []
        if (Array.isArray(data.pointList)) {
            restoredPoints = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        if (Array.isArray(data.tris)) {
            triangles = data.tris.map(t => {
                let nt = {}
                if (t.p1 !== undefined && restoredPoints[t.p1]) nt.p1 = restoredPoints[t.p1]
                if (t.p2 !== undefined && restoredPoints[t.p2]) nt.p2 = restoredPoints[t.p2]
                if (t.p3 !== undefined && restoredPoints[t.p3]) nt.p3 = restoredPoints[t.p3]
                return nt
            })
        }
        ctx.workIsSaved = 1
        updateGridButtonText()
    } catch (e) {
        log('Load fail: ' + e.message)
    }
}

window.addEventListener('beforeunload', () => {
    clearTimeout(persistTimer)
    try {
        localStorage.setItem(STORAGE_KEY, serializeState())
    } catch (e) {}
})

downloadMesh = () => {
    try {
        let blob = new Blob([serializeState()], { type: 'application/json' })
        let url = URL.createObjectURL(blob)
        let a = document.createElement('a')
        a.href = url
        a.download = 'mesh-' + Date.now() + '.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        log('Export OK: ' + a.download)
    } catch (e) {
        log('Export fail: ' + e.message)
    }
}

importMeshFromText = (text) => {
    try {
        let data = JSON.parse(text)
        if (!data || typeof data !== 'object') {
            log('Import fail: not a JSON object')
            return false
        }
        let restoredPoints = []
        if (Array.isArray(data.pointList)) {
            restoredPoints = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        if (Array.isArray(data.tris)) {
            triangles = data.tris.map(t => {
                let nt = {}
                if (t.p1 !== undefined && restoredPoints[t.p1]) nt.p1 = restoredPoints[t.p1]
                if (t.p2 !== undefined && restoredPoints[t.p2]) nt.p2 = restoredPoints[t.p2]
                if (t.p3 !== undefined && restoredPoints[t.p3]) nt.p3 = restoredPoints[t.p3]
                return nt
            })
        } else {
            triangles = []
        }
        if (data.activeGrid !== undefined) activeGrid = !!data.activeGrid
        if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') {
            GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        }
        historyStack = []
        redoStack = []
        selectedPoints = []
        nearestPoint = undefined
        nearestLine = undefined
        grabbedGroup = []
        currentAction = undefined
        isSelectingBox = false
        selectionBoxStart = undefined
        selectionBoxCurrent = undefined
        clearTimeout(wheelRotateTimer)
        wheelRotateTimer = undefined
        isWheelRotating = false
        persistState()
        updateGridButtonText()
        drawBoard()
        log('Import OK: ' + triangles.length + ' triangles')
        return true
    } catch (e) {
        log('Import fail: ' + e.message)
        return false
    }
}

importMeshFromFile = (file) => {
    if (!file) return
    if (file.type !== 'application/json' && !file.name.match(/\.json$/i)) {
        log('Import fail: not a JSON file')
        return
    }
    let reader = new FileReader()
    reader.onload = (e) => {
        importMeshFromText(String(e.target.result))
    }
    reader.onerror = () => log('Import fail: read error')
    reader.readAsText(file)
}

resetAll = () => {
    triangles = []
    selectedPoints = []
    historyStack = []
    redoStack = []
    nearestPoint = undefined
    nearestLine = undefined
    grabbedGroup = []
    currentAction = undefined
    isSelectingBox = false
    selectionBoxStart = undefined
    selectionBoxCurrent = undefined
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = undefined
    isWheelRotating = false
    persistState()
    drawBoard()
    log('Reset OK')
}

doit = () => {
    loadState()
    drawBoard()
}
