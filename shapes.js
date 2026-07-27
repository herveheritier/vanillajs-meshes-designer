// ---------------------------------------------------------------
// shapes.js
//
// Toutes les fonctions ci-dessous considerent uniquement les triangles
// de la FORME ACTIVE pour les operations d'edition/selection.
// Dependances : state.js (activeTriangles, shapes, activeShapeIndex,
// selectedPoints), geometry.js (adjacentPoints), hud.js (draw*).
// ---------------------------------------------------------------

// Liste dedup (via adjacentPoints) des positions UNIQUES dans la
// forme active.
getAllVertices = () => {
    let vertices = []
    let tris = activeTriangles()
    tris.forEach(t => {
        [t.p1, t.p2, t.p3].forEach(p => {
            if (p && !vertices.some(v => adjacentPoints(v, p, 0.01))) {
                vertices.push(p)
            }
        })
    })
    return vertices
}

// Toutes les references de points qui partagent la meme position
// (dans la tolerance) que `p`. Renvoie la liste (unique) des
// references ; preserve le partage de reference entre triangles
// d'une meme forme.
getPointsAtSamePosition = (p, tolerance = 0.01) => {
    if (!p) return []
    let result = []
    let tris = activeTriangles()
    tris.forEach(t => {
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

// Mise a jour du HUD toolbar "1/N" : index actif sur nombre total.
updateShapeHud = () => {
    let label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = (activeShapeIndex + 1) + '/' + shapes.length
}

// Selectionne tous les points de la forme active (via dedup +
// expansion "tous les points a la meme position").
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

// ---- Recherche du point / segment le plus proche dans la FORME ACTIVE ----
// Toute la famille est optimisee sur la scene (sans recalcul pour
// les triangleIndexes <= nearestPoint.triangleIndex : permet un
// "cursor iteratif" si on veut enumerer tous les points proches).

findNearestPoint = (point) => {
    return findNextNearestPoint({ point:point, triangleIndex:-1 })
}

findNextNearestPoint = (nearestPoint) => {
    let shortDistance = Number.MAX_VALUE
    let shortIndex = -1
    let shortPointIndex = -1
    let tris = activeTriangles()
    tris.forEach( (e,i) => {
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
    let trisRef = activeTriangles()
    let result =  {
        triangleIndex:shortIndex,
        distance:shortDistance,
        pointIndex:shortPointIndex,
        triangle:trisRef[shortIndex],
        pointId:pointId,
        point:trisRef[shortIndex][pointId]
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
    let tris = activeTriangles()
    tris.forEach((t,i) => {
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
    if(shortTriangleIndex<0) return undefined
    let trisRef = activeTriangles()
    let triangle = trisRef[shortTriangleIndex]
    let firstPointId = ['p1','p2','p3'][shortLineIndex]
    let secondPointId = ['p2','p3','p1'][shortLineIndex]
    return {
        triangleIndex: shortTriangleIndex,
        lineIndex: shortLineIndex,
        triangle: triangle,
        firstPointId: firstPointId,
        secondPointId: secondPointId,
        firstPoint: triangle[firstPointId],
        secondPoint: triangle[secondPointId]
    }
}
