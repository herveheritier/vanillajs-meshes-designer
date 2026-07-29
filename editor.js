// Module editor.js : logique d'edition directement sur la scene
// geometrique.
//
// Domaine : tout ce qui touche a la manipulation du CANVAS et
// des POINTS — selection, hover, find, drag, click, drop,
// grab/drag de points, ajout/suppression de points, rotations
// runtime de la scene ou des points selectionnes.
//
// Separations stricte des responsabilites :
//   - Pas de CRUD de formes (c'est shapes.js)
//   - Pas d'historique (c'est history.js) — sauf appel a saveState
//   - Pas de zoom/pan/wheel de viewport (c'est viewport.js)
//   - Pas d'import/export ni de persistance (c'est io.js)
//
// Les fonctions runtime-rotation (rotateEachShapeAroundPivot,
// rotateSelectedPoints) sont exposees pour que viewport.js
// puisse les appeler depuis le wheel handler. Les coordonnees
// sont en MODELE (zoom/viewCenter gere par viewport.js).
//
// Dependances : state, constants, draw, hud, geometry, history,
// io, log.

import { state } from './state.js'
import { ACTION_NONE, ACTION_GRABBING, COLOR_LINES_INACTIVE, TAU } from './constants.js'
import { drawBoard, drawPoint, drawLine, drawMouse } from './draw.js'
import { updateSelectionHud } from './hud.js'
import { updateZoomDisplay } from './viewport.js'
import {
    screenToModel, snapToGrid,
    activeTriangles, getAllVertices, getPointsAtSamePosition, isPointSelected,
    adjacentPoints, computeOrthogonalProjection, isInsideSegmentByDot,
} from './geometry.js'
import { saveState } from './history.js'
import { persistState, importMeshFromFile } from './io.js'
import { log } from './log.js'

// findNearestPoint est declare plus bas dans ce meme
// module ; rien a importer de l'exterieur.

// ===== find : point/line/triangle les plus proches =====

// `findNearestPoint` itere sur les triangles de la FORME
// active, mesure la distance euclidienne au point donne, et
// renvoie le vertex le plus proche avec son {triangle,
// triangleIndex, pointIndex, pointId, distance}. Delegue a
// `findNextNearestPoint` pour permettre la continuation
// apres un index donne (utilise par `addPoint` pour trouver
// le second point du triangle en cours si besoin).
export const findNearestPoint = (point) => {
    return findNextNearestPoint({ point: point, triangleIndex: -1 })
}

export const findNextNearestPoint = (nearestPoint) => {
    let shortDistance = Number.MAX_VALUE
    let shortIndex = -1
    let shortPointIndex = -1
    const tris = activeTriangles()
    tris.forEach((e, i) => {
        if (i <= nearestPoint.triangleIndex) return
        ;[e.p1, e.p2, e.p3].forEach((p, j) => {
            if (!p) return
            const d = Math.hypot(p.x - nearestPoint.point.x, p.y - nearestPoint.point.y)
            if (d < shortDistance) {
                shortIndex = i
                shortDistance = d
                shortPointIndex = j
            }
        })
    })
    if (shortIndex < 0) return undefined
    const pointId = ['p1', 'p2', 'p3'][shortPointIndex]
    const trisRef = activeTriangles()
    return {
        triangleIndex: shortIndex,
        distance: shortDistance,
        pointIndex: shortPointIndex,
        triangle: trisRef[shortIndex],
        pointId,
        point: trisRef[shortIndex][pointId],
    }
}

// Plus proche LIGNE parmi les edges de la forme active.
// Strategie : pour chaque triangle, on regarde les deux
// segments qui NE contiennent PAS le point le plus proche
// (celui qui le contient est implicitement couvert par la
// distance point-a-point) — on garde le plus court.
export const findNearestLine = (point) => {
    let shortDistance = Number.MAX_VALUE
    let shortPointIndex = -1
    const np = findNearestPoint(point)
    if (!np || !np.triangle) return undefined
    const tt = [
        { id: 'p1', index: 0, point: np.triangle.p1 },
        { id: 'p2', index: 1, point: np.triangle.p2 },
        { id: 'p3', index: 2, point: np.triangle.p3 },
    ]
    tt.splice(np.pointIndex, 1)
    tt.forEach((e, j) => {
        if (!e.point) return
        const d = Math.hypot(e.point.x - point.x, e.point.y - point.y)
        if (d < shortDistance) {
            shortDistance = d
            shortPointIndex = e.index
        }
    })
    const pointId = ['p1', 'p2', 'p3'][shortPointIndex]
    return {
        index: np.shortIndex,
        firstPointIndex: np.pointIndex,
        secondPointIndex: shortPointIndex,
        triangle: np.triangle,
        firstPointId: np.pointId,
        secondPointId: pointId,
        firstPoint: np.triangle[np.pointId],
        secondPoint: np.triangle[pointId],
    }
}

// Plus proche segment (line) en projetant orthogonalement la
// souris sur chaque edge du triangle, et en filtrant ceux dont
// la projection tombe entre les deux sommets (cf.
// isInsideSegmentByDot). Utilise par updateMouseHover pour
// afficher en gris attenué un hint visuel.
export const findSelectedLine = (point) => {
    let shortDistance = Number.MAX_VALUE
    let shortTriangleIndex = -1
    let shortLineIndex = -1
    const tris = activeTriangles()
    tris.forEach((t, i) => {
        if (!t.p1 || !t.p2 || !t.p3) return
        let cop = computeOrthogonalProjection(point, t.p1, t.p2)
        let d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p1, t.p2)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 0
        }
        cop = computeOrthogonalProjection(point, t.p2, t.p3)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p2, t.p3)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 1
        }
        cop = computeOrthogonalProjection(point, t.p3, t.p1)
        d = Math.hypot(point.x - cop.x, point.y - cop.y)
        if (d < shortDistance && isInsideSegmentByDot(cop, t.p3, t.p1)) {
            shortDistance = d
            shortTriangleIndex = i
            shortLineIndex = 2
        }
    })
    if (shortTriangleIndex < 0) return undefined
    const firstPointId = ['p1', 'p2', 'p3'][shortLineIndex]
    const secondPointId = ['p2', 'p3', 'p1'][shortLineIndex]
    const trisRef = activeTriangles()
    return {
        triangleIndex: shortTriangleIndex,
        firstPointIndex: [0, 1, 2][shortLineIndex],
        secondPointIndex: [1, 2, 0][shortLineIndex],
        triangle: trisRef[shortTriangleIndex],
        firstPointId,
        secondPointId,
        firstPoint: trisRef[shortTriangleIndex][firstPointId],
        secondPoint: trisRef[shortTriangleIndex][secondPointId],
    }
}

// ===== Hover et HUD bas-gauche =====

// Met a jour le hover (nearestPoint + nearestLine + dim selection)
// ET appelle drawBoard (qui inclut les drawSelectedPoints + drawReticle
// + drawShape) + drawMouse (le curseur custom) + drawPoint pour
// le hint vert du point le plus proche + drawLine du segment
// hovered.
// textContent sur #coords (cf. updateCoordsDisplay).
export const updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    const actionModel = screenToModel(cursorScreen)
    const target = state.activeGrid ? snapToGrid(actionModel) : actionModel
    state.nearestPoint = findNearestPoint(target)

    if (state.selectedPoints.length > 0 && state.nearestPoint && state.nearestPoint.point && !isPointSelected(state.nearestPoint.point)) {
        state.isSelectionDimmed = true
    } else {
        state.isSelectionDimmed = false
    }

    drawBoard()
    drawMouse(cursorScreen)

    if (state.nearestPoint && state.nearestPoint.point) {
        drawPoint(state.nearestPoint.point, 5, '#00FF00')
    }
    state.nearestLine = findSelectedLine(target)
    if (state.nearestLine && state.nearestLine.firstPoint && state.nearestLine.secondPoint) {
        drawLine(state.nearestLine.firstPoint, state.nearestLine.secondPoint, [], COLOR_LINES_INACTIVE)
    }
}

// Pilule bas-gauche : position curseur + plus proche point en
// coords model. Vide le contenu si le curseur quitte le canvas.
// textContent (pas innerText) pour eviter un reflow a chaque
// mousemove.
export const updateCoordsDisplay = (cursorScreen) => {
    const div = document.querySelector('#coords')
    if (!div) return
    if (!cursorScreen) {
        div.textContent = ''
        return
    }
    const m = screenToModel(cursorScreen)
    const np = (state.nearestPoint && state.nearestPoint.point) ? state.nearestPoint.point : null
    const cursorTxt = `(${Math.round(m.x)}, ${Math.round(m.y)})`
    const nearestTxt = np ? `(${Math.round(np.x)}, ${Math.round(np.y)})` : '\u2014'
    div.textContent = `curseur ${cursorTxt}  plus proche ${nearestTxt}`
}

// ===== Selection / click sur board =====

// Wrap resolveMouseClickOnBoard : ajout d'un point unique a
// la forme active (et creation d'un triangle si besoin).
// Trois branches :
//   - 0 triangles : cree un triangle partiel avec p1 uniquement.
//   - 1 triangle avec un/des slot(s) vide : remplit le premier slot vide.
//   - sinon : cree un nouveau triangle lie au nearestLine (edge
//     en hover) en utilisant ses deux sommets + le nouveau point.
export const resolveMouseClickOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const pointToAdd = snapToGrid(screenToModel(mouseScreen))
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
}

export const addPoint = (point) => {
    const tris = activeTriangles()
    // exclure un point deja occupe (tolerance : < 1)
    for (let i = 0; i < tris.length; i++) {
        const triangle = tris[i]
        if (adjacentPoints(point, triangle.p1, 1)) return
        if (triangle.p2 !== undefined) if (adjacentPoints(point, triangle.p2, 1)) return
        if (triangle.p3 !== undefined) if (adjacentPoints(point, triangle.p3, 1)) return
    }
    saveState()
    if (tris.length === 0) {
        tris.push({ p1: point })
    } else {
        const triangle = tris.at(-1)
        if (triangle.p2 === undefined) {
            triangle.p2 = point
        } else if (triangle.p3 === undefined) {
            triangle.p3 = point
        } else {
            tris.push({
                p1: state.nearestLine.firstPoint,
                p2: state.nearestLine.secondPoint,
                p3: point,
            })
        }
    }
    state.ctx.workIsSaved = 0
    state.ctx.workIsBackuped = 0
    persistState()
}

// Selection de tous les points de la forme active. Meme
// regle de "cluster coalesce" que resolveMouseClickOnBoard
// au mouseup : getAllVertices dedup, puis getPointsAtSamePosition
// rexpanse les clusters (un point physique == un cluster de
// triangles partageant ce sommet).
export const selectAllPoints = () => {
    const result = []
    const vertices = getAllVertices()  // from geometry.js
    vertices.forEach(p => {
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    state.selectedPoints = result
    state.nearestPoint = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
}

// ===== Mouseup (selection par click sur point) =====

// `processMouseUpSelection(e)` : traite la fin d'un click
// court (dist < 5 px dans screen) sur le board. Ciblee sur
// le BOUT du drag de selection-box : si l'utilisateur n'a
// pas drag (mousedown puis mouseup avec dist < 5), on
// evalue s'il y a un point sous le curseur (< 15 unites
// modele) ou s'il a clique en espace vide.
//
// Trois modifiers, deux cibles (point proche / espace vide) :
//
// Cible = point proche (< 15 unites modele)
//   - shift                  : toggle la selection (ajoute
//                              si absent, retire si present
//                              dans le cluster pointsAtPos).
//   - ctrl / meta (Cmd)      : ajoute le cluster a la
//                              selection SANS toggle
//                              (idempotent : utile pour
//                              accumuler en chainant plusieurs
//                              Ctrl+clic).
//   - rien                   : remplace la selection par le
//                              cluster du point le plus proche.
//
// Cible = espace vide
//   - shift                  : preserve la selection, cree un
//                              nouveau point.
//   - ctrl / meta            : preserve la selection, NE CREE
//                              PAS de point (les modifiers
//                              operent sur la selection, pas
//                              sur la scene).
//   - rien                   : vide la selection, cree un
//                              nouveau point.
//
// Selection videe / mutee -> mise a jour de la pilule
// selection via updateSelectionHud(). resolveMouseClickOnBoard
// appelle addPoint (qui appelle saveState + persistState).
// findNearestPoint est declare plus bas dans ce meme
// module, on s'y refere directement.

export const processMouseUpSelection = (e) => {
    if (!state.board) return
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const np = findNearestPoint(screenToModel(mouseScreen))
    if (np && np.distance < 15) {
        const pointsAtPos = getPointsAtSamePosition(np.point)
        if (e.shiftKey) {
            // shift teste en premier pour preserver sa
            // priorite si l'utilisateur combine shift+ctrl.
            const anySelected = pointsAtPos.some(p => isPointSelected(p))
            if (anySelected) {
                state.selectedPoints = state.selectedPoints.filter(sp => !pointsAtPos.some(p => adjacentPoints(sp, p, 0.01)))
            } else {
                pointsAtPos.forEach(p => {
                    if (!isPointSelected(p)) state.selectedPoints.push(p)
                })
            }
        } else if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd + click : ajoute SANS toggle.
            // Idempotent : si deja dans la selection, rien
            // n'est ajoute (filtre isPointSelected).
            pointsAtPos.forEach(p => {
                if (!isPointSelected(p)) state.selectedPoints.push(p)
            })
        } else {
            // Click sans modifier : remplace la selection.
            state.selectedPoints = [...pointsAtPos]
        }
    } else {
        // Clic en espace vide.
        if (e.shiftKey) {
            resolveMouseClickOnBoard(e)
        } else if (e.ctrlKey || e.metaKey) {
            // Preserve la selection, ne cree pas de point.
        } else {
            state.selectedPoints = []
            resolveMouseClickOnBoard(e)
        }
    }
}

// ===== Suppression d'un point =====

// Regle : la suppression d'un segment est effective SSI l'un
// de ses points n'existe pas. Quand on supprime un point P :
//   - chaque triangle contenant P voit P retire de ses slots ;
//   - les segments incidents a P (deux par triangle) sont
//     supprimes implicitement (l'un de leurs points n'existe
//     plus) ;
//   - le segment OPPOSE (entre les deux autres points du
//     triangle) survit car ses deux endpoints existent.
// Pour representer ca dans le modele triangle-only, on
// reordonne les slots du triangle pour ramener les points
// survivants en tete (t.p1, t.p2, t.p3) et laisse undefined
// pour les slots non utilises. drawTriangle trace alors
// naturellement le segment p1->p2 quand p3===undefined.
// Un triangle dont il reste <2 points survivants est filtre.
export const deleteSelectedPoint = () => {
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getPointsAtSamePosition(state.nearestPoint.point)
    }
    if (targets.length === 0) return
    saveState()
    const activeShapeRef = state.shapes[state.activeShapeIndex]
    activeShapeRef.triangles = activeShapeRef.triangles
        .map(t => {
            const surviving = []
            if (t.p1 && !targets.some(target => adjacentPoints(t.p1, target, 0.01))) surviving.push(t.p1)
            if (t.p2 && !targets.some(target => adjacentPoints(t.p2, target, 0.01))) surviving.push(t.p2)
            if (t.p3 && !targets.some(target => adjacentPoints(t.p3, target, 0.01))) surviving.push(t.p3)
            if (surviving.length < 2) return null
            t.p1 = surviving[0]
            t.p2 = surviving[1]
            t.p3 = surviving[2]
            return t
        })
        .filter(t => t !== null)
    state.selectedPoints = []
    state.nearestPoint = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    persistState()
}

// ===== Grab (drag) d'un point =====

// `grabbed()` : true si une session de drag est en cours.
// Utilise par le mousedown/mouseup chain pour savoir quand
// initier et terminer le drag.
export const grabbed = () => state.currentAction === ACTION_GRABBING

// Debut d'une session de drag (clic droit).
// Detection AltGr robuste : on accepte (a) le couple DOM
// ctrlKey+altKey OU (b) getModifierState('AltGraph').
// Mode Alt : drag toutes les formes (repeuple grabbedGroup
// avec tous les points de toutes les formes).
// Mode classique : drag du point le plus proche uniquement,
// reordonne la selection selon le modifier.
export const beginGrabbing = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    state.moveAllActive = isAltGrDown
    state.grabbedGroup = []

    // AltGr : mode "deplace toute la scene". Accepte meme en
    // espace vide (pas d'ancre sur un point).
    if (isAltGrDown) {
        state.currentAction = ACTION_GRABBING
        state.grabStartMouse = mouseScreen
        state.selectedPoints = []
        updateSelectionHud()
        state.shapes.forEach((shape, sIndex) => {
            shape.triangles.forEach((t, tIndex) => {
                ['p1', 'p2', 'p3'].forEach((pid) => {
                    const p = t[pid]
                    if (!p) return
                    state.grabbedGroup.push({
                        shapeIndex: sIndex,
                        triangleIndex: tIndex,
                        pointId: pid,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: undefined,
                    })
                })
            })
        })
        // Scene vide -> rien a deplacer. Annule avant saveState
        // pour ne pas polluer l'historique undo.
        if (state.grabbedGroup.length === 0) {
            state.currentAction = undefined
            state.grabStartMouse = undefined
            return
        }
        saveState()
        log(`AltGr detecte - deplacement de ${state.shapes.length} forme(s) : ${state.grabbedGroup.length} points`)
        state.board.style.cursor = 'move'
        return
    }

    // Mode classique : ancrage sur le point le plus proche.
    const np = findNearestPoint(screenToModel(mouseScreen))
    if (!np || !np.point) return

    state.currentAction = ACTION_GRABBING
    state.grabStartMouse = mouseScreen
    saveState()

    if (!isPointSelected(np.point)) {
        const pointsAtPos = getPointsAtSamePosition(np.point)
        if (!e.shiftKey) {
            state.selectedPoints = [...pointsAtPos]
        } else {
            pointsAtPos.forEach(p => {
                if (!isPointSelected(p)) state.selectedPoints.push(p)
            })
        }
        updateSelectionHud()
    }

    const tris = activeTriangles()
    state.selectedPoints.forEach(sp => {
        tris.forEach((t, i) => {
            [t.p1, t.p2, t.p3].forEach((p, j) => {
                if (p && adjacentPoints(p, sp, 0.01)) {
                    state.grabbedGroup.push({
                        shapeIndex: state.activeShapeIndex,
                        triangleIndex: i,
                        pointId: `p${j + 1}`,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: sp,
                    })
                }
            })
        })
    })
}

// Fin du grab : rend la main + persiste le dernier etat.
// Restore le curseur OS en 'none' (le canvas dessine son
// propre curseur via drawMouse). Reset du flag move-all pour
// qu'un futur grabbing classique ne herite pas d'un AltGr
// residue.
export const endGrabbing = (e) => {
    state.currentAction = ACTION_NONE
    resolveMouseMoveOnBoard(e)
    state.board.style.cursor = 'none'
    state.moveAllActive = false
    persistState()
}

// Resolution d'un mousemove sur le board.
// Trois branches mutuellement exclusives (early-return a
// l'interieur de la branche via state.* pre-mutes) :
//   1) Drag d'une selection box -> mise a jour de selectedPoints.
//   2) Pan clic-milieu (viewport).
//   3) Grab en cours (curModel delta + snap si grille).
// Dans tous les cas, on finit par redessiner + recalculer
// le hover + update le HUD selection.
export const resolveMouseMoveOnBoard = (e) => {
    const mouseScreen = {
        x: e.x - state.board.getBoundingClientRect().x,
        y: e.y - state.board.getBoundingClientRect().y,
    }

    if (state.isSelectingBox) {
        state.selectionBoxCurrent = mouseScreen
        const m1 = screenToModel(state.selectionBoxStart)
        const m2 = screenToModel(state.selectionBoxCurrent)
        const minXM = Math.min(m1.x, m2.x)
        const maxXM = Math.max(m1.x, m2.x)
        const minYM = Math.min(m1.y, m2.y)
        const maxYM = Math.max(m1.y, m2.y)
        const activeShapeRef = state.shapes[state.activeShapeIndex]
        const allV = []
        activeShapeRef.triangles.forEach(t => {
            [t.p1, t.p2, t.p3].forEach(p => {
                if (p && !allV.some(v => adjacentPoints(v, p, 0.01))) allV.push(p)
            })
        })
        const inBox = allV.filter(p => p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM)
        const expanded = []
        inBox.forEach(p => {
            getPointsAtSamePosition(p).forEach(q => {
                if (!expanded.some(ev => ev === q)) expanded.push(q)
            })
        })
        state.selectedPoints = expanded
    } else if (grabbed()) {
        const curModel = screenToModel(mouseScreen)
        const startModel = screenToModel(state.grabStartMouse)
        const dx = curModel.x - startModel.x
        const dy = curModel.y - startModel.y
        // Mode move-all + grille : on snap le DELTA, pas chaque point
        // (sinon le snap independant casserait l'uniformite entre
        // formes).
        if (state.activeGrid && state.moveAllActive) {
            const snappedDelta = snapToGrid({ x: dx, y: dy })
            state.grabbedGroup.forEach(item => {
                const targetPos = {
                    x: item.startX + snappedDelta.x,
                    y: item.startY + snappedDelta.y,
                }
                applyGrabToPoint(item, targetPos)
            })
        } else {
            state.grabbedGroup.forEach(item => {
                const rawPos = { x: item.startX + dx, y: item.startY + dy }
                const targetPos = (state.activeGrid && !state.moveAllActive) ? snapToGrid(rawPos) : rawPos
                applyGrabToPoint(item, targetPos)
            })
        }
    }

    state.lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
    updateSelectionHud()
}

// Helper prive : applique une position a un point du grabbedGroup
// (mute le triangle + le selectedPointRef associe). Meme
// implementation que dans main.js, juste extraite.
const applyGrabToPoint = (item, targetPos) => {
    const tri = state.shapes[item.shapeIndex].triangles[item.triangleIndex]
    if (!tri) return
    tri[item.pointId] = targetPos
    if (item.selectedPointRef) {
        item.selectedPointRef.x = targetPos.x
        item.selectedPointRef.y = targetPos.y
    }
}

// ===== Rotation runtime =====

// Rotation PER-SHAPE (AltGr + wheel). Mute TOUS les points de
// TOUTES les formes par rapport au pivot en coords MODELE.
// Suivi a chaque tick (le wheel handler passe un pivot
// re-evalue depuis screenToModel(cursorScreen)). Si la souris
// reste fixe, le pivot est invariant ; si elle bouge, le
// pivot suit (= rotation orbitale).
// Vider la selection au premier tick d'une gesture car la
// rotation mute TOUS les points, pas seulement les
// selectionnes ; ne pas laisser le surlignage cyan suggerer
// le contraire.
export const rotateEachShapeAroundPivot = (pivotModel, angle) => {
    if (!state.shapes || state.shapes.length === 0) return
    if (!state.isEachShapeRotating) {
        saveState()
        state.isEachShapeRotating = true
        state.selectedPoints = []
        updateSelectionHud()
        log('AltGr + molette detecte - rotation de chaque forme autour du curseur (5 deg/tick)')
    }
    clearTimeout(state.eachShapeRotateTimer)
    state.eachShapeRotateTimer = setTimeout(() => {
        state.isEachShapeRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    state.shapes.forEach((shape) => {
        shape.triangles.forEach((t) => {
            ['p1', 'p2', 'p3'].forEach((pid) => {
                const p = t[pid]
                if (!p) return
                const dx = p.x - pivotModel.x
                const dy = p.y - pivotModel.y
                p.x = pivotModel.x + dx * cos - dy * sin
                p.y = pivotModel.y + dx * sin + dy * cos
            })
        })
    })

    // Compteur HUD : somme cumulee des angles modulo 2*PI.
    // Le `(r % TAU + TAU) % TAU` gere les angles negatifs
    // (le simple `% TAU` peut renvoyer un resultat negatif).
    state.ctx.rotationTracking = ((state.ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

// Rotation des POINTS SELECTIONNES autour du curseur (sans
// AltGr). snapToGrid sur la position finale si la grille est
// activee. Mute la liste state.selectedPoints en place ; pour
// chaque sp, cherche tous les triangles de la forme active
// qui contiennent un point adjacent a sp et remplace sa
// position (maintien de la coherence des shared refs).
export const rotateSelectedPoints = (center, angle) => {
    if (state.selectedPoints.length < 2 || state.isSelectionDimmed) return
    if (!state.isWheelRotating) {
        saveState()
        state.isWheelRotating = true
    }
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = setTimeout(() => {
        state.isWheelRotating = false
        persistState()
    }, 400)

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    const activeShapeRef = state.shapes[state.activeShapeIndex]

    state.selectedPoints.forEach(sp => {
        const dx = sp.x - center.x
        const dy = sp.y - center.y
        const nx = center.x + dx * cos - dy * sin
        const ny = center.y + dx * sin + dy * cos

        let target = { x: nx, y: ny }
        if (state.activeGrid) target = snapToGrid(target)

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
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
}

// ===== Drop (drag/drop d'un fichier JSON) =====

// Branchement sur le canvas des handlers de drag/drop. La
// delegation est en boot depuis main.js (cf. wireBoardDrop()).
// Le drop appelle importMeshFromFile de io.js.
export const wireBoardDrop = () => {
    if (!state.board) return
    state.board.addEventListener('dragover', (e) => {
        e.preventDefault()
    })
    state.board.addEventListener('drop', (e) => {
        e.preventDefault()
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
        const file = e.dataTransfer.files[0]
        importMeshFromFile(file)
    })
}
