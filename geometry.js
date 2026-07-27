// ---------------------------------------------------------------
// geometry.js
//
// Projection model <-> screen, snap-to-grid, helpers geometriques
// purs (produit scalaire, projection orthogonale, appartenance a un
// segment, dedup de points). Pas de mutation de la scene.
//
// Dependances : constants.js (TAU, GRID_STEP), state.js (ctx,
// activeGrid) ; utilise egalement activeTriangles depuis state.js
// pour addPoint.
// ---------------------------------------------------------------

snapToGrid = (point) => {
    if (!activeGrid || !point) return point
    return {
        x: Math.round(point.x / GRID_STEP) * GRID_STEP,
        y: Math.round(point.y / GRID_STEP) * GRID_STEP
    }
}

// Le systeme de coordonnees du modele est en convention maths :
// X+ vers la droite, Y+ vers le haut. Les coordonnees capturees
// depuis les evenements souris sont en coords screen (origine
// top-left, Y vers le bas).
//
// La projection model <-> screen tient compte du zoom et du
// viewCenter (= le point du modele qui apparait au centre du board) :
//   s.x = ctx.center.x + (m.x - ctx.viewCenter.x) * ctx.zoomLevel
//   s.y = ctx.center.y - (m.y - ctx.viewCenter.y) * ctx.zoomLevel
// Inversee :
//   m.x = (s.x - ctx.center.x) / ctx.zoomLevel + ctx.viewCenter.x
//   m.y = ctx.viewCenter.y - (s.y - ctx.center.y) / ctx.zoomLevel
// Par defaut (zoom=1, viewCenter={0,0}), la projection se reduit a
// s = m + ctx.center (mappage direct sur le board).
modelToScreen = (model) => {
    if (!model) return undefined
    // Camera transform simple (zoom + viewCenter), pas de
    // rotation viewport : la rotation de scene est desormais
    // appliquee directement aux vertices de chaque forme (cf.
    // rotateEachShapeAroundPivot). Avant il y avait une
    // rotation de viewport ici, qui rendait modelToScreen /
    // screenToModel coteux en Math.cos / Math.sin sur le hot-path
    // du rendu. Suppression = retour a une projection directe.
    return {
        x: ctx.center.x + (model.x - ctx.viewCenter.x) * ctx.zoomLevel,
        y: ctx.center.y - (model.y - ctx.viewCenter.y) * ctx.zoomLevel
    }
}
screenToModel = (screen) => {
    if (!screen) return undefined
    // Inverse symetrique de modelToScreen : camera transform
    // simple (zoom + viewCenter). Pas de rotation inverse (la
    // rotation de scene mute directement les vertices, voir
    // modelToScreen). Avant, screenToModel etait appele a
    // chaque mousemove (hot-path), avec un fast-path quand la
    // rotation etait nulle. Suppression de la rotation = plus
    // besoin de fast-path, juste une formule directe.
    return {
        x: (screen.x - ctx.center.x) / ctx.zoomLevel + ctx.viewCenter.x,
        y: ctx.viewCenter.y - (screen.y - ctx.center.y) / ctx.zoomLevel
    }
}

// Helpers geometriques purs utilises par les fonctions "find" (cf.
// shapes.js) pour deduper / tester l'appartenance a un segment.

computeOrthogonalProjection = (p,p1,p2) => {
    let dx = p2.x - p1.x
    let dy = p2.y - p1.y
    let ps = scalarProduct(p, p1, p2) / scalarProduct(p2, p1, p2)
    return { x: p1.x + dx * ps, y: p1.y + dy * ps }
}

scalarProduct = (p, p1, p2) => {
    return (p.x-p1.x)*(p2.x-p1.x) + (p.y-p1.y)*(p2.y-p1.y)
}

// Teste si la projection orthogonale `cop` du point `p` sur le
// segment [p1, p2] est effectivement DANS le segment (et pas
// prolongee au-dela).
isInsideSegmentByDot = (p,p1,p2) => {
    let sp = scalarProduct(p,p1,p2)
    let length = scalarProduct(p2,p1,p2)
    return sp>=0 && sp<=length
}

// Tolerance d'adjacence : un point est considere comme "le meme"
// qu'un autre si la distance euclidienne est < tolerance (en
// unites modele). Utilise partout : dedup alleShapes dans
// cloneTriArray, getPointsAtSamePosition, etc.
adjacentPoints = (p1,p2,tolerance) => {
    let dx=p1.x-p2.x
    let dy=p1.y-p2.y
    let d = Math.sqrt(dx*dx + dy*dy)
    return d < tolerance
}

// Ajoute un point au dernier triangle en cours, ou cree un nouveau
// triangle. La logique de "buffer" (on accumule jusqu'a 3 points
// pour fermer le triangle, puis on recommence) est preservee
// depuis le code original.
addPoint = (point) => {
    let tris = activeTriangles()
    if( tris.length === 0 ) {
        tris.push({ p1:point, p2:undefined, p3:undefined })
        return
    }
    let triangle = tris[tris.length-1]
    if(triangle.p2===undefined) {
        if(adjacentPoints(point,triangle.p1,1)) return
        triangle.p2 = point
    } else if(triangle.p3===undefined) {
        if(adjacentPoints(point,triangle.p1,1)) return
        if(adjacentPoints(point,triangle.p2,1)) return
        triangle.p3 = point
    } else {
        // Nouveau triangle : partage le 1er point avec le
        // precedent pour rester connecte.
        if(adjacentPoints(point,triangle.p1,1)) return
        if(adjacentPoints(point,triangle.p2,1)) return
        if(adjacentPoints(point,triangle.p3,1)) return
        tris.push({ p1:point, p2:triangle.p3, p3:undefined })
    }
}
