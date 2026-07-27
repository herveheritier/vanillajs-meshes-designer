// ---------------------------------------------------------------
// events.js
//
// Regroupe :
//   (a) les queries/initialisation DOM runtime
//       (canvas, board, body, messageBoard, _ctx, helpModal,
//       resetModal). Doit etre fait AVANT que les autres modules
//       ne soient appeles (principalement avant drawBoard()).
//       En Vanilla JS sans ESM, les fonctions sont definies mais
//       pas appelees au load ; c'est l'inline `doit()` de
//       main.html qui les appelle en dernier, donc on peut
//       s'en sortir avec ces declarations-let dans une module
//       charge juste avant doit. On les met ici pour la
//       coherence avec le wiring.
//   (b) TOUS les addEventListener (bouton, board, document,
//       modale, window). Les handlers referencent les modules
//       precedents ; au moment ou ils s'executent (user gesture
//       ou window unload), tout est deja initialise.
//
// Charge apres import_export.js et avant main.js (qui definit
// doit et termine le boot).
// ---------------------------------------------------------------

// ---- DOM refs (instancie a l'init du script) ----
let board = document.querySelector('#board')
let body = document.querySelector('body')
let messageBoard = document.querySelector('#messageBoard')
let _ctx = board.getContext("2d")
let helpModal = document.querySelector('#helpModal')
let resetModal = document.querySelector('#resetModal')

// Style de base du canvas + centrage initial de la camera.
body.style.overflow = 'hidden'
board.style.border = 'solid 1px black'
board.style.width = '99vw'
board.style.height = '99vh'
board.width = board.getBoundingClientRect().width
board.height = board.getBoundingClientRect().height
board.style.cursor = 'none'
ctx.center.x = board.width / 2
ctx.center.y = board.height / 2
// viewCenter reste a (0,0) en coords modele ; la wheel handler met a
// jour viewCenter quand l'utilisateur zoome.
_ctx.fillStyle = '#000000'
_ctx.fillRect(0, 0, board.width, board.height)
messageBoard.innerText = '*** CONSOLE ***'

// ---- Boutons toolbar ----

let gridBtn = document.querySelector('#grid')
gridBtn.addEventListener("click", (e) => {
    if (e.button !== 0) return
    toggleGrid()
})

// Bouton console : toggle l'overlay #messageBoard (cf. hud.js).
let consoleBtn = document.querySelector('#console')
if (consoleBtn) consoleBtn.addEventListener("click", (e) => {
    if (e.button !== 0) return
    toggleConsole()
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

let exportBtn = document.querySelector('#export')
exportBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    saveMesh()
})

let resetBtn = document.querySelector('#reset')
resetBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    showResetModal()
})

let selectAllBtn = document.querySelector('#selectAll')
selectAllBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    selectAllPoints()
})

let importMeshesBtn = document.querySelector('#importMeshes')
importMeshesBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    let input = document.querySelector('#importMeshesFile')
    if (!input) {
        input = document.createElement('input')
        input.type = 'file'
        input.id = 'importMeshesFile'
        input.hidden = true  // cache l'input (sinon il apparait dans la page)
        // Pas de filtre accept: les fichiers meshes n'ont souvent pas
        // d'extension (ex: assets/meshes). La validation se fait dans
        // importMeshFromFile (cote convert.js).
        document.body.appendChild(input)
        input.addEventListener('change', (evt) => {
            let f = evt.target.files && evt.target.files[0]
            if (f) importMeshesFromFile(f)
            evt.target.value = ''
        })
    }
    input.click()
})

let importJsonBtn = document.querySelector('#importJson')
if (importJsonBtn) importJsonBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    let input = document.querySelector('#importJsonFile')
    if (!input) {
        input = document.createElement('input')
        input.type = 'file'
        input.id = 'importJsonFile'
        input.accept = 'application/json,.json'
        input.hidden = true
        document.body.appendChild(input)
        input.addEventListener('change', (evt) => {
            let f = evt.target.files && evt.target.files[0]
            if (f) importMeshFromFile(f)
            evt.target.value = ''
        })
    }
    input.click()
})

// Wiring de la toolbar de formes (prev / label / next / new / delete).
// On tolere leur absence (pour tests headless sur ancien HTML).
let prevShapeBtn = document.querySelector('#prevShape')
if (prevShapeBtn) prevShapeBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    prevShape()
})
let nextShapeBtn = document.querySelector('#nextShape')
if (nextShapeBtn) nextShapeBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    nextShape()
})
let newShapeBtn = document.querySelector('#newShape')
if (newShapeBtn) newShapeBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    addShape()
})
let deleteShapeBtn = document.querySelector('#deleteShape')
if (deleteShapeBtn) deleteShapeBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    deleteShape()
})

let helpBtn = document.querySelector('#helpBtn')
if (helpBtn) helpBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    showHelp()
})

// ---- Modal close buttons + backdrop clicks ----

let helpCloseBtn = document.querySelector('#helpClose')
if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => hideHelp())
if (helpModal) helpModal.addEventListener('click', (e) => {
    let target = e.target
    if (target && target.dataset && target.dataset.helpClose !== undefined) hideHelp()
})

let resetModalCancelBtn = document.querySelector('#resetModalCancel')
if (resetModalCancelBtn) resetModalCancelBtn.addEventListener('click', () => hideResetModal())
let resetModalValidateBtn = document.querySelector('#resetModalValidate')
if (resetModalValidateBtn) resetModalValidateBtn.addEventListener('click', () => {
    hideResetModal()
    resetAll()
})
if (resetModal) resetModal.addEventListener('click', (e) => {
    let target = e.target
    if (target && target.dataset && target.dataset.resetClose !== undefined) hideResetModal()
})

// ---- Board events (wheel, dragover, drop) ----

// Molette : trois branches dans l'ordre suivant :
//   (1) AltGr + molette = rotation de la scene ENTIERE autour du
//       curseur (chacun des N wheel ticks pivote d'un meme angle) ;
//   (2) 2+ points selectionnes = rotation des points selectionnes
//       autour du point sous le curseur (comportement historique) ;
//   (3) sinon : zoom centre sur le curseur.
// Le pan du viewCenter se fait separement, via clic-milieu
// (button===1) sur le board + drag souris, voir
// resolveMouseMoveOnBoard.
board.addEventListener('wheel', (e) => {
    e.preventDefault()
    let boardRect = board.getBoundingClientRect()
    let cursorScreen = { x: e.x - boardRect.x, y: e.y - boardRect.y }
    // Detection AltGr : Ctrl+Alt OU getModifierState('AltGraph')
    // pour eviter les conflits avec le WM qui peuvent intercepter
    // Alt seul.
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    if (isAltGrDown) {
        // A CHAQUE tick de la gesture AltGlr + wheel : on capture
        // la position du curseur dans la scene (= coords modele du
        // point sous la souris avec la rotation cumulee COURANTE)
        // comme pivot de rotation. Curseur fixe -> pivot invariant.
        altGrRotationPivot = screenToModel(cursorScreen)
        let angle = e.deltaY < 0 ? -ROTATE_STEP : ROTATE_STEP
        rotateEachShapeAroundPivot(altGrRotationPivot, angle)
        return
    }
    // Sans AltGlr : on libere le pivot capture.
    if (altGrRotationPivot) altGrRotationPivot = undefined
    let canRotate = selectedPoints.length >= 2 && !isSelectionDimmed
    if (canRotate) {
        let center = screenToModel(cursorScreen)
        let angleStep = ROTATE_STEP
        let angle = e.deltaY < 0 ? -angleStep : angleStep
        rotateSelectedPoints(center, angle)
    } else {
        // Zoom centre sur le curseur. Math :
        //   m_under = (cursorScreen - ctx.center) / oldZoom + viewCenter
        //   Apres zoom on veut garder m_under sous cursorScreen.
        let oldZoom = ctx.zoomLevel
        let factor = e.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR
        let newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor))
        if (newZoom === oldZoom) return
        ctx.viewCenter.x += (cursorScreen.x - ctx.center.x) * (1 / oldZoom - 1 / newZoom)
        ctx.viewCenter.y -= (cursorScreen.y - ctx.center.y) * (1 / oldZoom - 1 / newZoom)
        ctx.zoomLevel = newZoom
        drawBoard()
        if (lastMousePos) updateMouseHover(lastMousePos)
        updateZoomDisplay()
        persistState()
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

// ---- Document events (mousemove, mouseup, mousedown, keydown, contextmenu) ----

document.addEventListener("contextmenu", (e) => {
    if(e.target.id==='board') e.preventDefault();
}, false);

document.addEventListener('mousemove', (e) => {
    if(e.target.id==='board') resolveMouseMoveOnBoard(e)
})

document.addEventListener('mouseup', (e) => {
    if(grabbed()) endGrabbing(e)
    // Fin d'un pan clic-milieu. On persist le viewCenter final mem'
    // si l'utilisateur n'a pas bouge entre mousedown et mouseup.
    if(isPanning && e.button===1) {
        isPanning = false
        panStartMouse = undefined
        panStartViewCenter = undefined
        persistState()
    }
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

document.addEventListener('mousedown', (e) => {
    if(e.target.id==='board') {
        let mousePos = { x: e.x - board.getBoundingClientRect().x, y: e.y - board.getBoundingClientRect().y }
        if(e.button===2) {
            beginGrabbing(e)
        } else if(e.button===0) {
            // Debut d'un selection box (rectangle de selection).
            selectionBoxStart = mousePos
            selectionBoxCurrent = mousePos
            isSelectingBox = true
        } else if(e.button===1) {
            // Debut d'un pan du viewCenter. On sauve la position
            // screen + le viewCenter courant pour les utiliser comme
            // references dans resolveMouseMoveOnBoard.
            isPanning = true
            panStartMouse = mousePos
            panStartViewCenter = { x: ctx.viewCenter.x, y: ctx.viewCenter.y }
        }
    }
})

// ---- Interaction handlers : grab / drag / click resolution ----

grabbed = () => {
    return currentAction === ACTION_GRABBING
}

beginGrabbing = (e) => {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }
    // Detection AltGr robuste : on accepte (a) le couple DOM
    // ctrlKey+altKey (cas Linux X11/Wayland classiques) OU (b)
    // getModifierState('AltGraph').
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    moveAllActive = isAltGrDown
    grabbedGroup = []

    // AltGr tenu pendant le drag = deplacer TOUTES les formes d'un
    // meme delta (quasi-mode capture au mousedown). Mode SCENE-WIDE
    // : pas d'ancre sur un point, on accepte le grab meme en espace
    // vide.
    if (isAltGrDown) {
        currentAction = ACTION_GRABBING
        grabStartMouse = mouseScreen
        selectedPoints = []
        shapes.forEach((shape, sIndex) => {
            shape.triangles.forEach((t, tIndex) => {
                ['p1','p2','p3'].forEach((pid, j) => {
                    let p = t[pid]
                    if (!p) return
                    grabbedGroup.push({
                        shapeIndex: sIndex,
                        triangleIndex: tIndex,
                        pointId: pid,
                        startX: p.x,
                        startY: p.y,
                        selectedPointRef: undefined
                    })
                })
            })
        })
        if (grabbedGroup.length === 0) {
            currentAction = undefined
            grabStartMouse = undefined
            return
        }
        saveState()
        log('AltGr detecte - deplacement de ' + shapes.length + ' forme(s) : ' + grabbedGroup.length + ' points')
        board.style.cursor = 'move'
        return
    }

    // Mode historique (sans Alt) : grab ancre sur le point le plus
    // proche, ne bouge que la forme active.
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

    let tris = activeTriangles()
    selectedPoints.forEach(sp => {
        tris.forEach( (t,i) => {
            [t.p1,t.p2,t.p3].forEach( (p,j) => {
                if(p && adjacentPoints(p, sp, 0.01)) {
                    grabbedGroup.push({
                        shapeIndex: activeShapeIndex,
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
    board.style.cursor = 'none'
    moveAllActive = false
    persistState()
}

resolveMouseMoveOnBoard = (e) => {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }

    if(isSelectingBox) {
        selectionBoxCurrent = mouseScreen
        // Les deux coins sont en coords screen ; on les convertit en
        // coords model (avec zoom et viewCenter) puis on prend min/max
        // pour avoir le bounding box.
        let m1 = screenToModel(selectionBoxStart)
        let m2 = screenToModel(selectionBoxCurrent)
        let minXM = Math.min(m1.x, m2.x)
        let maxXM = Math.max(m1.x, m2.x)
        let minYM = Math.min(m1.y, m2.y)
        let maxYM = Math.max(m1.y, m2.y)

        // Ne selectionne QUE dans la forme active.
        let activeShapeRef = shapes[activeShapeIndex]
        let allV = []
        activeShapeRef.triangles.forEach(t => {
            [t.p1, t.p2, t.p3].forEach(p => {
                if (p && !allV.some(v => adjacentPoints(v, p, 0.01))) allV.push(p)
            })
        })
        let inBox = allV.filter(p => p.x >= minXM && p.x <= maxXM && p.y >= minYM && p.y <= maxYM)
        let expanded = []
        inBox.forEach(p => {
            getPointsAtSamePosition(p).forEach(q => {
                if(!expanded.some(e => e === q)) expanded.push(q)
            })
        })
        selectedPoints = expanded
    } else if(isPanning) {
        // Pan du viewCenter (clic-milieu + drag souris). Convention
        // "drag content" : le contenu suit le curseur.
        let dx = mouseScreen.x - panStartMouse.x
        let dy = mouseScreen.y - panStartMouse.y
        ctx.viewCenter.x = panStartViewCenter.x - dx / ctx.zoomLevel
        ctx.viewCenter.y = panStartViewCenter.y + dy / ctx.zoomLevel
        drawBoard()
        if (lastMousePos) updateMouseHover(lastMousePos)
        updateZoomDisplay()
    } else if(grabbed()) {
        let curModel = screenToModel(mouseScreen)
        let startModel = screenToModel(grabStartMouse)
        let dx = curModel.x - startModel.x
        let dy = curModel.y - startModel.y
        // Mode move-all + grille : on snap le DELTA (pas chaque
        // point), sinon le snap independant casserait l'uniformite
        // entre formes.
        if (activeGrid && moveAllActive) {
            let snapped = snapToGrid({ x: dx, y: dy })
            dx = snapped.x
            dy = snapped.y
        }
        grabbedGroup.forEach(item => {
            let targetPos = { x: item.startX + dx, y: item.startY + dy }
            if(activeGrid && !moveAllActive) {
                targetPos = snapToGrid(targetPos)
            }
            // item.shapeIndex peut designer une forme AUTRE que la
            // forme active (mode Alt + drag). On utilise shapes[item.shapeIndex].
            let tri = shapes[item.shapeIndex].triangles[item.triangleIndex]
            if (!tri) return  // safety: la forme a pu changer
            tri[item.pointId] = targetPos
            if (item.selectedPointRef) {
                item.selectedPointRef.x = targetPos.x
                item.selectedPointRef.y = targetPos.y
            }
        })
    }

    lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
}

resolveMouseClickOnBoard = (e) => {
    let mouseScreen = {
        x : e.x - board.getBoundingClientRect().x,
        y : e.y - board.getBoundingClientRect().y
    }
    let pointToAdd = snapToGrid(screenToModel(mouseScreen))
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
}

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
    if(e.code==='Backspace') {
        if (e.shiftKey) {
            showResetModal()
        } else {
            deleteSelectedPoint()
        }
    }
    // Toggle la grille avec 'g' / 'G' (sans modifiers autres que Shift,
    // ignore quand l'utilisateur tape dans un champ, et ignore aussi
    // si la cible est le bouton #grid lui-meme : apres un clic, le
    // bouton garde le focus et un 'g' declenche sinon un second
    // toggle qui annule le premier).
    let t = e.target
    let typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    let inGridBtn = t && typeof t.closest === 'function' && t.closest('#grid')
    if (!typing && !inGridBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        toggleGrid()
    }
    // Toggle la console avec 'c' / 'C' (meme pattern que 'g').
    // On ignore aussi si la cible est le bouton #console lui-meme
    // (meme raison que #grid : le bouton garde le focus apres
    // clic et un 'c' declencherait un second toggle).
    let inConsoleBtn = t && typeof t.closest === 'function' && t.closest('#console')
    if (!typing && !inConsoleBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC') {
        e.preventDefault()
        toggleConsole()
    }
    // '?' ouvre/ferme le panneau d'aide.
    let isHelpOpen = helpModal && !helpModal.hidden
    let wantsHelp = !typing && (e.key === '?' || e.code === 'Help')
    if (wantsHelp && !e.repeat) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        else showHelp()
    }
    // Escape ferme la modale d'aide OU la modale de reinit.
    let isResetOpen = resetModal && !resetModal.hidden
    if (e.code === 'Escape' && !e.repeat && (isHelpOpen || isResetOpen)) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        if (isResetOpen) hideResetModal()
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
        saveMesh()
    } else if((e.ctrlKey || e.metaKey) && (e.code === 'Digit0' || e.key === '0')) {
        // Reinitialise le zoom, le viewCenter et la rotation de la
        // scene (100% + origine modele au centre).
        if (e.repeat) return
        e.preventDefault()
        ctx.zoomLevel = 1
        ctx.viewCenter.x = 0
        ctx.viewCenter.y = 0
        ctx.rotationTracking = 0
        drawBoard()
        if (lastMousePos) updateMouseHover(lastMousePos)
        updateZoomDisplay()
        persistState()
    }
})

// ---- beforeunload : force flush du state avant fermeture ----
window.addEventListener('beforeunload', () => {
    clearTimeout(persistTimer)
    try {
        localStorage.setItem(STORAGE_KEY, serializeState())
    } catch (e) {}
})
