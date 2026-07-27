// ---------------------------------------------------------------
// scene_ops.js
//
// Operations de MUTATION sur les vertices de la scene :
//   - migration legacy viewport-rotation (applyPendingRotationToShapes),
//   - rotation de scene via AltGr+wheel (rotateEachShapeAroundPivot),
//   - rotation des points selectionnes via wheel (rotateSelectedPoints),
//   - suppression d'un point (deleteSelectedPoint).
//
// Ces fonctions sont les SEULES a muter les coords des points
// partagees entre triangles (cf. cloneTriArray dans history.js
// pour les ramasser dans le snapshot undo).
// ---------------------------------------------------------------

// Helper : applique la rotation "legacy viewport" stockee dans
// pendingRotation aux vertices de chaque forme passee en argument.
// Meme formule CCW standard que rotateEachShapeAroundPivot (et
// rotateSelectedPoints), juste appelee une fois en bloc sur un
// tableau de formes au lieu d'un point a la fois. Utilisee par
// loadState ET applyImport pour migrer les scenes sauvegardees
// avec l'ancien format viewport-rotation.
applyPendingRotationToShapes = (shapeArray) => {
    if (!pendingRotation || !shapeArray || shapeArray.length === 0) return
    let angle = pendingRotation.angle
    let pivot = pendingRotation.pivot
    let cos = Math.cos(angle)
    let sin = Math.sin(angle)
    shapeArray.forEach((shape) => {
        shape.triangles.forEach((t) => {
            ['p1', 'p2', 'p3'].forEach((pid) => {
                let p = t[pid]
                if (!p) return
                let dx = p.x - pivot.x
                let dy = p.y - pivot.y
                p.x = pivot.x + dx * cos - dy * sin
                p.y = pivot.y + dx * sin + dy * cos
            })
        })
    })
    pendingRotation = undefined
}

// Scene rotation par AltGr + wheel. Rotation PER-SHAPE (mutation
// reelle des vertices) : on itere sur TOUTES les formes et TOUS
// leurs points (chaque triangle p1/p2/p3) et on tourne chacun
// autour du pivot en coords modele. Vider la selection : la
// rotation mute TOUS les points, pas seulement les selectionnes.
rotateEachShapeAroundPivot = (pivotModel, angle) => {
    // Choix "Suivre à chaque tick" : le wheel handler passe un
    // pivot re-evalue a chaque wheel event (altGrRotationPivot =
    // screenToModel(cursorScreen)). Si la souris reste fixe, le
    // pivot est invariant ; si elle bouge, le pivot suit
    // (= rotation orbitale).
    if (!shapes || shapes.length === 0) return
    if (!isEachShapeRotating) {
        saveState()
        isEachShapeRotating = true
        selectedPoints = []
        log('AltGr + molette detecte - rotation de chaque forme autour du curseur (5 deg/tick)')
    }
    clearTimeout(eachShapeRotateTimer)
    eachShapeRotateTimer = setTimeout(() => {
        isEachShapeRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    shapes.forEach((shape) => {
        shape.triangles.forEach((t) => {
            ['p1', 'p2', 'p3'].forEach((pid) => {
                let p = t[pid]
                if (!p) return
                let dx = p.x - pivotModel.x
                let dy = p.y - pivotModel.y
                p.x = pivotModel.x + dx * cos - dy * sin
                p.y = pivotModel.y + dx * sin + dy * cos
            })
        })
    })

    // Compteur HUD : somme cumulee des angles modulo 2*PI.
    // Le `(r % TAU + TAU) % TAU` gere les angles negatifs
    // (le simple `% TAU` peut renvoyer un resultat negatif).
    ctx.rotationTracking = ((ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (lastMousePos) updateMouseHover(lastMousePos)
    updateZoomDisplay()
}

// Rotation des points selectionnes autour d'un centre (modele).
// Cible : la forme active UNIQUEMENT (pas Alt).
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

    let activeShapeRef = shapes[activeShapeIndex]

    selectedPoints.forEach(sp => {
        let dx = sp.x - center.x
        let dy = sp.y - center.y
        let nx = center.x + dx * cos - dy * sin
        let ny = center.y + dx * sin + dy * cos

        let target = { x: nx, y: ny }
        if (activeGrid) {
            target = snapToGrid(target)
        }

        activeShapeRef.triangles.forEach(t => {
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

// Supprime les triangles contenant un point egal (par tolerance)
// a un point de `selectedPoints` OU a `nearestPoint.point`.
// Sauvegarde avant mutation pour undo.
deleteSelectedPoint = () => {
    let targets = []
    if (selectedPoints.length > 0) {
        targets = [...selectedPoints]
    } else if (nearestPoint && nearestPoint.point) {
        targets = getPointsAtSamePosition(nearestPoint.point)
    }
    if(targets.length === 0) return
    saveState()
    let activeShapeRef = shapes[activeShapeIndex]
    activeShapeRef.triangles = activeShapeRef.triangles.filter(t => {
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
