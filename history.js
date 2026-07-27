// ---------------------------------------------------------------
// history.js
//
// Undo / Redo. Stack d'etats de scene clones ; chaque entree
// snapshot les formes + l'index actif. En sortie d'undo/redo on
// reinitialise le state ephemere lie a la souris (selection,
// grab group, hover, timers de wheel-rotate) et on redessine.
// ---------------------------------------------------------------

// Clone profond d'un tableau de triangless. Preserve le partage des
// references de point entre triangles d'un meme tableau (un meme
// point physique reste un seul objet apres clonage).
cloneTriArray = (triArray) => {
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

// Clone toute la scene (toutes les formes + index actif). Chaque forme
// est clonee avec ses propres points ; AUCUN partage entre formes
// apres clonage, ce qui empeche une future modification de fuiter
// entre formes via une reference commune.
cloneScene = (shapesArray) => {
    return shapesArray.map(s => ({ triangles: cloneTriArray(s.triangles) }))
}

saveState = () => {
    historyStack.push({
        shapes: cloneScene(shapes),
        activeShapeIndex: activeShapeIndex
    })
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift()
    }
    redoStack = []
}

undo = () => {
    if (historyStack.length === 0) return
    currentAction = ACTION_NONE
    redoStack.push({
        shapes: cloneScene(shapes),
        activeShapeIndex: activeShapeIndex
    })
    let entry = historyStack.pop()
    shapes = entry.shapes
    activeShapeIndex = entry.activeShapeIndex
    if (activeShapeIndex < 0 || activeShapeIndex >= shapes.length) {
        activeShapeIndex = 0
    }
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    isSelectingBox = false
    selectionBoxStart = undefined
    selectionBoxCurrent = undefined
    grabbedGroup = []
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = undefined
    isWheelRotating = false
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
    updateShapeHud()
    persistState()
}

redo = () => {
    if (redoStack.length === 0) return
    currentAction = ACTION_NONE
    historyStack.push({
        shapes: cloneScene(shapes),
        activeShapeIndex: activeShapeIndex
    })
    let entry = redoStack.pop()
    shapes = entry.shapes
    activeShapeIndex = entry.activeShapeIndex
    if (activeShapeIndex < 0 || activeShapeIndex >= shapes.length) {
        activeShapeIndex = 0
    }
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    isSelectingBox = false
    selectionBoxStart = undefined
    selectionBoxCurrent = undefined
    grabbedGroup = []
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = undefined
    isWheelRotating = false
    drawBoard()
    if (lastMousePos) {
        updateMouseHover(lastMousePos)
    }
    updateShapeHud()
    persistState()
}
