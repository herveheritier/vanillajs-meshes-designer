// Le systeme de coordonnees du modele est centre a (ctx.center.x,
// ctx.center.y) avec X vers la droite et Y vers le haut. Pour le
// rendu, on translate de ctx.center.x (decalage X) et on inverse
// ctx.center.y (Y inverse). Aucun appelant ne doit appeler drawPoint
// avec des coordonnees screen (utiliser drawMouse ou le draw direct).
// Rendu via modelToScreen (tient compte du zoom et du viewCenter).
// Aucun appelant ne doit appeler drawPoint avec des coordonnees screen
// (utiliser drawMouse ou draw direct).
drawPoint = (p, radius=3, color='#FFFFFF') => {
    if (!p) return
    let sp = modelToScreen(p)
    _ctx.setLineDash([])
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.arc(sp.x, sp.y, radius, 0, TAU)
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
    // Reticule : guide visuel au curseur. Mode 0 = off (early
    // return), mode 1 = crosshair simple au curseur, mode 2 =
    // crosshair au curseur + 3 miroirs aux positions (-x,y),
    // (x,-y), (-x,-y). Place apres drawSelectedPoints pour etre
    // visible au-dessus des formes et des points, mais avant
    // drawSelectionBox (overlay de selection qui reste au-dessus
    // de tout).
    if (typeof reticleMode !== 'undefined' && reticleMode > 0) drawReticle()
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

// L'axe suit l'origine (0,0) du modele en coords SCREEN. On utilise
// ici une projection directe (camera transform : zoom + viewCenter
// + center) plutot que modelToScreen. Numeriquement, depuis la
// suppression de la rotation de viewport, les deux donnent le meme
// resultat pour le point (0,0) ; mais la formule directe reste plus
// explicite ("l'axe depend uniquement du viewport") et protege
// contre tout couplage futur si modelToScreen evolue (filtres,
// snapping, etc).
//
// Avec le geste AltGr + molette, la "rotation de scene" mute les
// vertices de chaque forme (cf. rotateEachShapeAroundPivot dans
// main.js) ; les axes representent le REPERE modele (frame de
// reference fixe), donc ils restent ancres sur l'ecran pendant que
// le contenu tourne autour. Si l'origine est hors canvas apres un
// zoom, l'axe n'est pas trace (un seul stroke pour eviter de casser
// le motif dash).
drawAxis = () => {
    let originScreenX = ctx.center.x + (0 - ctx.viewCenter.x) * ctx.zoomLevel
    let originScreenY = ctx.center.y - (0 - ctx.viewCenter.y) * ctx.zoomLevel
    let w = board.width
    let h = board.height
    _ctx.setLineDash(PATTERN_AXIS)
    _ctx.strokeStyle = COLOR_AXIS
    if (originScreenY >= 0 && originScreenY <= h) {
        _ctx.beginPath()
        _ctx.moveTo(0, originScreenY)
        _ctx.lineTo(w, originScreenY)
        _ctx.stroke()
    }
    if (originScreenX >= 0 && originScreenX <= w) {
        _ctx.beginPath()
        _ctx.moveTo(originScreenX, 0)
        _ctx.lineTo(originScreenX, h)
        _ctx.stroke()
    }
}

// Reticule : crosshair(s) au curseur en coords modele. Mode 1 =
// simple (1 crosshair au curseur), mode 2 = projection
// symetrique (curseur + miroirs aux 3 positions
// signe-changees sur les 2 axes : (-x,y), (x,-y), (-x,-y)).
// Meme look que drawAxis (PATTERN_AXIS, lignes pleine largeur
// dans la zone visible) mais en n&b (blanc au lieu de
// COLOR_AXIS vert) pour distinguer le guide curseur des axes
// d'origine. Skip si curseur hors canvas (lastMousePos
// indefini). Les lignes sont clippees par les bornes du board
// pour eviter de tracer en dehors.
drawReticle = () => {
    if (typeof reticleMode === 'undefined' || reticleMode === 0) return
    if (typeof lastMousePos === 'undefined' || !lastMousePos) return
    let m = screenToModel(lastMousePos)
    if (!m) return
    // Mode 1 : juste le curseur. Mode 2 : + 3 miroirs. Quand le
    // curseur est sur un axe (m.x=0 ou m.y=0) ou a l'origine, les
    // 4 positions reduisent a 1 ou 2 positions uniques — on
    // retrace alors la meme ligne 2-4 fois (idempotent visuellement,
    // cout negligeable).
    let positions = [{x: m.x, y: m.y}]
    if (reticleMode === 2) {
        positions.push({x: -m.x, y: m.y})
        positions.push({x: m.x, y: -m.y})
        positions.push({x: -m.x, y: -m.y})
    }
    _ctx.setLineDash(PATTERN_AXIS)
    _ctx.strokeStyle = '#FFFFFF'
    positions.forEach(pos => {
        let sp = modelToScreen(pos)
        if (sp.y >= 0 && sp.y <= board.height) {
            _ctx.beginPath()
            _ctx.moveTo(0, sp.y)
            _ctx.lineTo(board.width, sp.y)
            _ctx.stroke()
        }
        if (sp.x >= 0 && sp.x <= board.width) {
            _ctx.beginPath()
            _ctx.moveTo(sp.x, 0)
            _ctx.lineTo(sp.x, board.height)
            _ctx.stroke()
        }
    })
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
    let s1 = modelToScreen(p1)
    _ctx.setLineDash(pattern !== undefined ? pattern : PATTERN_LINES)
    _ctx.strokeStyle = color !== undefined ? color : COLOR_LINES
    _ctx.beginPath()
    _ctx.moveTo(s1.x, s1.y)
    if (p2 !== undefined) {
        let s2 = modelToScreen(p2)
        _ctx.lineTo(s2.x, s2.y)
        if (p3 !== undefined) {
            let s3 = modelToScreen(p3)
            _ctx.lineTo(s3.x, s3.y)
            _ctx.lineTo(s1.x, s1.y)
        }
    }
    _ctx.stroke()
}

drawLine = (p1, p2, pattern, color) => {
    if (!p1 || !p2) return
    let s1 = modelToScreen(p1)
    let s2 = modelToScreen(p2)
    _ctx.setLineDash(pattern)
    _ctx.strokeStyle = color
    _ctx.beginPath()
    _ctx.moveTo(s1.x, s1.y)
    _ctx.lineTo(s2.x, s2.y)
    _ctx.stroke()
}

drawGrid = () => {
    const baseStep = typeof GRID_STEP !== 'undefined' ? GRID_STEP : 32
    if (!baseStep || baseStep <= 0) return
    // L'ecart visible entre deux lignes depend du zoom : ecart =
    // baseStep * ctx.zoomLevel. Sinon le zoom rendrait les lignes
    // visuellement figees (zoom in) ou qui se chevauchent (zoom out).
    //
    // ANCRAGE : la grille est alignee sur les axes du modele (donc
    // sur l'origine (0,0) du repere) et non pas sur le centre du
    // board. C'est ce que fait snapToGrid (arrondi au multiple de
    // GRID_STEP le plus proche depuis 0) ; on aligne ici l'affichage
    // sur la meme ancre pour que les intersections dessinees
    // correspondent exactement aux positions vers lesquelles un
    // point va se snapper. L'alignement reste vrai apres zoom et
    // pan : originScreenX/Y evoluent en fonction de viewCenter, et
    // step en fonction de zoomLevel — la grille continue de
    // representer les memes multiples de GRID_STEP en model coords.
    const step = baseStep * ctx.zoomLevel
    if (step <= 0) return  // zoom <= 0 : pas de lignes (defensif)
    _ctx.setLineDash([])
    _ctx.strokeStyle = '#333333'
    _ctx.beginPath()
    // Position screen du model origin (0,0). MEME formule que
    // drawAxis : ctx.center - ctx.viewCenter * ctx.zoomLevel
    // (le signe de Y est inverse par rapport a modelToScreen
    // parce que drawAxis l'ecrit explicitement ainsi ; on suit
    // la meme convention par coherence visuelle).
    let originScreenX = ctx.center.x - ctx.viewCenter.x * ctx.zoomLevel
    let originScreenY = ctx.center.y + ctx.viewCenter.y * ctx.zoomLevel
    // Lignes verticales : n tel que screen x = originScreenX + n*step
    // tombe dans [0, board.width].
    //   0 <= originScreenX + n*step <= board.width
    //   n_min = ceil(-originScreenX / step)
    //   n_max = floor((board.width - originScreenX) / step)
    let n_min_x = Math.ceil(-originScreenX / step)
    let n_max_x = Math.floor((board.width - originScreenX) / step)
    for (let n = n_min_x; n <= n_max_x; n++) {
        let x_screen = originScreenX + n * step
        _ctx.moveTo(x_screen, 0)
        _ctx.lineTo(x_screen, board.height)
    }
    // Lignes horizontales : screen y = originScreenY - n*step (Y
    // inverse : n>0 monte sur l'ecran). Plage visible [0, h].
    //   0 <= originScreenY - n*step <= board.height
    //   n_min = ceil((originScreenY - board.height) / step)
    //   n_max = floor(originScreenY / step)
    let n_min_y = Math.ceil((originScreenY - board.height) / step)
    let n_max_y = Math.floor(originScreenY / step)
    for (let n = n_min_y; n <= n_max_y; n++) {
        let y_screen = originScreenY - n * step
        _ctx.moveTo(0, y_screen)
        _ctx.lineTo(board.width, y_screen)
    }
    _ctx.stroke()
}
