const TAU = 2 * Math.PI
const COLOR_AXIS = '#00A000'
const COLOR_LINES = '#FFFFFF'
// Couleur/dash pour les formes INACTIVES : gris atténue pour signaler
// "non editable" tout en restant visibles.
const COLOR_LINES_INACTIVE = '#5A5A5A'
const POINT_COLOR_INACTIVE = '#7A7800'
const PATTERN_AXIS = [2,1,3,1]
const PATTERN_LINES = [2,2]
const PATTERN_LINES_INACTIVE = [4,4]
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

// Scene = liste de formes ; SEULE la forme indexee par activeShapeIndex
// est editable. shapes[].triangles contient des triangless avec points
// partages entre triangles d'une meme forme (mais JAMAIS entre formes).
let shapes = [{ triangles: [] }]
let activeShapeIndex = 0

// Helper : triangles de la forme active (lecture/ecriture). Toute la
// logique d'edition doit passer par cet accessor.
activeTriangles = () => shapes[activeShapeIndex].triangles

// Helper : la scene est-elle vide (aucun triangle dans aucune forme) ?
// Sert a eviter un confirm() inutile quand il n'y a rien a ecraser.
isSceneEmpty = () => {
    if (!Array.isArray(shapes) || shapes.length === 0) return true
    for (let i = 0; i < shapes.length; i++) {
        if (shapes[i] && Array.isArray(shapes[i].triangles) && shapes[i].triangles.length > 0) return false
    }
    return true
}

// Helper : change la forme active proprement. Annule toute action
// en cours, vide la selection, recalcule le hover et le HUD.
goToShape = (newIndex) => {
    if (!Array.isArray(shapes) || shapes.length === 0) return
    if (newIndex < 0 || newIndex >= shapes.length) return
    if (newIndex === activeShapeIndex) return
    currentAction = ACTION_NONE
    grabbedGroup = []
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = undefined
    isWheelRotating = false
    activeShapeIndex = newIndex
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    isSelectingBox = false
    selectionBoxStart = undefined
    selectionBoxCurrent = undefined
    drawBoard()
    if (lastMousePos) updateMouseHover(lastMousePos)
    updateShapeHud()
}

prevShape = () => {
    if (shapes.length <= 1) return
    goToShape((activeShapeIndex - 1 + shapes.length) % shapes.length)
}

nextShape = () => {
    if (shapes.length <= 1) return
    goToShape((activeShapeIndex + 1) % shapes.length)
}

addShape = () => {
    saveState()
    shapes.push({ triangles: [] })
    goToShape(shapes.length - 1)
    persistState()
}

deleteShape = () => {
    if (shapes.length === 1) {
        if (!confirm('Supprimer la derniere forme et creer une scene vide ?')) return
        saveState()
        shapes = [{ triangles: [] }]
        activeShapeIndex = 0
        selectedPoints = []
        nearestPoint = undefined
        nearestLine = undefined
        grabbedGroup = []
        currentAction = ACTION_NONE
        isSelectingBox = false
        selectionBoxStart = undefined
        selectionBoxCurrent = undefined
        clearTimeout(wheelRotateTimer)
        wheelRotateTimer = undefined
        isWheelRotating = false
        drawBoard()
        if (lastMousePos) updateMouseHover(lastMousePos)
        updateShapeHud()
        persistState()
        return
    }
    if (!confirm('Supprimer la forme active ?')) return
    saveState()
    shapes.splice(activeShapeIndex, 1)
    if (activeShapeIndex >= shapes.length) activeShapeIndex = shapes.length - 1
    selectedPoints = []
    nearestPoint = undefined
    nearestLine = undefined
    grabbedGroup = []
    currentAction = ACTION_NONE
    isSelectingBox = false
    selectionBoxStart = undefined
    selectionBoxCurrent = undefined
    clearTimeout(wheelRotateTimer)
    wheelRotateTimer = undefined
    isWheelRotating = false
    drawBoard()
    if (lastMousePos) updateMouseHover(lastMousePos)
    updateShapeHud()
    persistState()
}

updateShapeHud = () => {
    let label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = (activeShapeIndex + 1) + '/' + shapes.length
}

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

// Toutes les fonctions ci-dessous considerent uniquement les triangles
// de la FORME ACTIVE pour les operations d'edition/selection.
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

let historyStack = []
let redoStack = []
const MAX_HISTORY = 50

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
    let gridText = document.querySelector('#gridText')
    let gridBtn = document.querySelector('#grid')
    if (!gridText || !gridBtn) return
    // Cible uniquement le <span> dedie : ne PAS toucher au bouton
    // entier avec innerText, sinon l'icone SVG est detruite. Le
    // caractere '#' precedent avait des barres obliques qui faisaient
    // paraitre le texte "en italique" en police monospace.
    // Le pas est affiche en permanence (subdued si inactif, vert si
    // actif via la classe .grid-active sur le bouton).
    gridText.textContent = `${GRID_STEP}px`
    gridBtn.classList.toggle('grid-active', !!activeGrid)
}

let gridBtn = document.querySelector('#grid')

// Toggle la grille (utilise par le clic sur le bouton et par le
// raccourci clavier 'g'). Centralise la logique pour eviter la
// divergence entre les deux points d'entree.
toggleGrid = () => {
    activeGrid = !activeGrid
    updateGridButtonText()
    drawBoard()
    persistState()
}

gridBtn.addEventListener("click",(e) => {
    if (e.button !== 0) return
    toggleGrid()
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
    saveMesh()
})

let resetBtn = document.querySelector('#reset')
resetBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    showResetModal()
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
        // d'extension (ex: assets/meshes). Un filtre MIME/extension
        // strict masque ces fichiers dans le picker. On laisse le
        // navigateur montrer TOUS les fichiers, la validation se fait
        // dans importMeshesFromFile.
        document.body.appendChild(input)
        input.addEventListener('change', (evt) => {
            let f = evt.target.files && evt.target.files[0]
            if (f) importMeshesFromFile(f)
            evt.target.value = ''
        })
    }
    input.click()
})

// Ouvre un picker pour selectionner un fichier .json et l'importer
// comme scene courante. Meme validation finale que le drop sur canvas :
// le contenu est passe a importMeshFromFile qui appelle
// importMeshFromText -> buildShapesFromPayload.
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
// Les listeners sont attaches ici ; les elements eux-memes sont dans
// main.html. On tolere leur absence (pour tests headless sur ancien HTML).
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
    // '?' ouvre/ferme le panneau d'aide. Detecte via e.key (locale-
    // dependant : shift+/ sur US, shift+, sur AZERTY, etc.) et la
    // touche Help dediee si presente. Memo pour eviter une double
    // ouverture sur un repeat.
    let helpModal = document.querySelector('#helpModal')
    let isHelpOpen = helpModal && !helpModal.hidden
    let wantsHelp = !typing && (e.key === '?' || e.code === 'Help')
    if (wantsHelp && !e.repeat) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        else showHelp()
    }
    // Escape ferme la modale d'aide OU la modale de reinit si l'une
    // d'elles est ouverte (priorite a l'aide si les deux le sont).
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
    }
})

let helpModal = document.querySelector('#helpModal')

showHelp = () => {
    if (!helpModal) return
    helpModal.hidden = false
}

hideHelp = () => {
    if (!helpModal) return
    helpModal.hidden = true
}

// Bouton "Fermer" + clic sur le backdrop ferment l'aide. Le clic a
// l'interieur de la .modal-box NE propage pas vers le backdrop
// (stopPropagation implicite via le check sur data-help-close).
let helpCloseBtn = document.querySelector('#helpClose')
if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => hideHelp())
if (helpModal) helpModal.addEventListener('click', (e) => {
    let target = e.target
    if (target && target.dataset && target.dataset.helpClose !== undefined) hideHelp()
})

// Modale de reinitialisation (remplace l'ancien confirm() natif).
// Meme pattern d'interactions que la modale d'aide : Annuler, le
// bouton primaire declenche resetAll(), le backdrop ferme, et Escape
// est gere plus bas dans le keydown listener partage.
let resetModal = document.querySelector('#resetModal')

showResetModal = () => {
    if (!resetModal) return
    resetModal.hidden = false
}
hideResetModal = () => {
    if (!resetModal) return
    resetModal.hidden = true
}

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
    let tris = activeTriangles()
    selectedPoints.forEach(sp => {
        tris.forEach( (t,i) => {
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
    } else if(grabbed()) {
        // dx: meme sens screen/model
        let dx = mouseScreen.x - grabStartMouse.x
        // dy_model: inverse du deplacement screen (haut souris = +Y model)
        let dy = grabStartMouse.y - mouseScreen.y
        let activeShapeRef = shapes[activeShapeIndex]
        grabbedGroup.forEach(item => {
            let targetPos = { x: item.startX + dx, y: item.startY + dy }
            if(activeGrid) {
                targetPos = snapToGrid(targetPos)
            }
            let tri = activeShapeRef.triangles[item.triangleIndex]
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

// Met a jour le hover (point le plus proche, dim de la selection, etc).
// Le curseur est dessine en screen. Le calcul du nearestPoint/Line
// se fait en coords model (Y inverse), restreint a la forme active.
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
        drawLine(nearestLine.firstPoint, nearestLine.secondPoint, [], COLOR_LINES_INACTIVE)
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
    result =  { 
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
    if(shortTriangleIndex < 0) return undefined
    let firstPointId = ['p1','p2','p3'][shortLineIndex]
    let secondPointId = ['p2','p3','p1'][shortLineIndex]
    let trisRef = activeTriangles()
    return {
        triangleIndex:shortTriangleIndex, 
        firstPointIndex:[0,1,2][shortLineIndex],
        secondPointIndex:[1,2,0][shortLineIndex],
        triangle:trisRef[shortTriangleIndex],
        firstPointId:firstPointId,
        secondPointId:secondPointId,
        firstPoint:trisRef[shortTriangleIndex][firstPointId],
        secondPoint:trisRef[shortTriangleIndex][secondPointId]
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

// Ajoute un point uniquement dans la forme active. Le point est ajoute
// au dernier triangle en cours de construction, ou cree un nouveau
// triangle a partir de nearestLine si la forme en a deja 3 complets.
addPoint = (point) => {
    let tris = activeTriangles()
    // exclure un point déjà occupé (tolérance : < 1)
    for (let i = 0; i < tris.length; i++) {
        let triangle = tris[i]
        if(adjacentPoints(point,triangle.p1,1)) return
        if(triangle.p2!==undefined) if(adjacentPoints(point,triangle.p2,1)) return
        if(triangle.p3!==undefined) if(adjacentPoints(point,triangle.p3,1)) return
    }
    saveState()
    if (tris.length===0) {
        tris.push({p1:point})
    } 
    else {
        triangle = tris.at(-1)
        if(triangle.p2===undefined) {
            triangle.p2 = point
        }
        else if(triangle.p3===undefined) {
            triangle.p3 = point
        }
        else {
            tris.push({
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
    // Format : { shapes: [{ tris, pointList }...], activeShapeIndex,
    // activeGrid, GRID_STEP }. Chaque forme possede son propre
    // pointList : ne JAMAIS fusionner les indices de point entre formes.
    let serializedShapes = shapes.map(shape => {
        let pointList = []
        let pointMap = new Map()
        let tris = shape.triangles.map(t => {
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
        return { tris: tris, pointList: pointList }
    })
    return JSON.stringify({
        shapes: serializedShapes,
        activeShapeIndex: activeShapeIndex,
        activeGrid: activeGrid,
        GRID_STEP: GRID_STEP
    })
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

// Reconstruit un tableau de formes a partir d'un payload JSON.
// Accepte les deux formats :
//   - nouveau : { shapes: [{ tris, pointList }, ...], activeShapeIndex }
//   - ancien (compat) : { tris, pointList, activeShapeIndex }
buildShapesFromPayload = (data) => {
    if (!data || typeof data !== 'object') return null
    let result = []
    if (Array.isArray(data.shapes)) {
        data.shapes.forEach(shape => {
            let pts = []
            if (Array.isArray(shape.pointList)) {
                pts = shape.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
            }
            let ts = []
            if (Array.isArray(shape.tris)) {
                shape.tris.forEach(t => {
                    let nt = {}
                    if (t.p1 !== undefined && pts[t.p1]) nt.p1 = pts[t.p1]
                    if (t.p2 !== undefined && pts[t.p2]) nt.p2 = pts[t.p2]
                    if (t.p3 !== undefined && pts[t.p3]) nt.p3 = pts[t.p3]
                    return ts.push(nt)
                })
            }
            result.push({ triangles: ts })
        })
    } else {
        // Ancien format : un seul mesh -> une seule forme.
        let pts = []
        if (Array.isArray(data.pointList)) {
            pts = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        let ts = []
        if (Array.isArray(data.tris)) {
            data.tris.forEach(t => {
                let nt = {}
                if (t.p1 !== undefined && pts[t.p1]) nt.p1 = pts[t.p1]
                if (t.p2 !== undefined && pts[t.p2]) nt.p2 = pts[t.p2]
                if (t.p3 !== undefined && pts[t.p3]) nt.p3 = pts[t.p3]
                ts.push(nt)
            })
        }
        result.push({ triangles: ts })
    }
    if (result.length === 0) result = [{ triangles: [] }]
    return result
}

loadState = () => {
    let saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return
    try {
        let data = JSON.parse(saved)
        if (data.activeGrid !== undefined) activeGrid = !!data.activeGrid
        if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') {
            GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        }
        let loaded = buildShapesFromPayload(data)
        if (loaded) {
            shapes = loaded
            if (typeof data.activeShapeIndex === 'number' && data.activeShapeIndex >= 0 && data.activeShapeIndex < shapes.length) {
                activeShapeIndex = data.activeShapeIndex
            } else {
                activeShapeIndex = 0
            }
        }
        ctx.workIsSaved = 1
        updateGridButtonText()
        updateShapeHud()
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

saveMesh = () => {
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
    // 1) Parse + validation du payload d'abord, AVANT tout prompt.
    //    Si le JSON est mal forme on sort sans rien demander.
    let parsed = null
    let loaded = null
    try {
        let data = JSON.parse(text)
        if (!data || typeof data !== 'object') {
            log('Import fail: not a JSON object')
            return false
        }
        parsed = data
        loaded = buildShapesFromPayload(data)
    } catch (e) {
        log('Import fail: ' + e.message)
        return false
    }

    // 2) Strategie d'import selon l'etat de la scene.
    //    - Scene vide : pas de prompt, replace direct.
    //    - Scene non vide avec preference memorisee : applique sans prompt.
    //    - Scene non vide sans preference : affiche le modal HTML custom.
    if (isSceneEmpty()) {
        applyImport(parsed, loaded, 'replace')
        return true
    }

    // Scene non vide : on ouvre TOUJOURS le modal. Le radio est
    // pre-selectionne dans showImportModal sur le dernier choix
    // memorise (defaut 'replace' si premiere fois).
    let currentTriCount = shapes.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let importedTriCount = loaded.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let currentInfo = shapes.length + ' forme' + (shapes.length > 1 ? 's' : '') + ', ' + currentTriCount + ' triangle' + (currentTriCount > 1 ? 's' : '')
    let importedInfo = loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + importedTriCount + ' triangle' + (importedTriCount > 1 ? 's' : '')
    showImportModal({ currentInfo: currentInfo, importedInfo: importedInfo }, (result) => {
        if (!result) {
            log('Import cancelled')
            return
        }
        // On enregistre systematiquement le choix pour le pre-selectionner
        // au prochain import (le modal s'affiche a chaque fois, mais le
        // radio defaut reflete le dernier choix).
        saveStoredImportMode(result.mode)
        applyImport(parsed, loaded, result.mode)
    })
    return true
}

// ---------- Helpers d'import (modal, stockage, application) ----------

// Cle localStorage pour la preference "mode d'import memorise".
IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'

// Lit la preference. Renvoie 'replace' ou 'merge' ou null si absente/invalide.
getStoredImportMode = () => {
    try {
        let v = localStorage.getItem(IMPORT_MODE_STORAGE_KEY)
        return v === 'replace' || v === 'merge' ? v : null
    } catch (e) {
        return null
    }
}

// Persiste la preference. Les erreurs (quota, etc) sont ignorees pour
// ne JAMAIS bloquer l'import.
saveStoredImportMode = (mode) => {
    try {
        if (mode === 'replace' || mode === 'merge') {
            localStorage.setItem(IMPORT_MODE_STORAGE_KEY, mode)
        }
    } catch (e) {}
}

// Garde anti-double-modal : si un modal est deja ouvert, le second
// appel est ignore et le callback recoit null (= annule).
let importModalShown = false

// Affiche le modal HTML d'import. opts = { currentInfo, importedInfo }.
// callback(null) = annule (Escape, backdrop, bouton Annuler).
// callback({ mode, remember }) = choix valide.
showImportModal = (opts, callback) => {
    if (importModalShown) {
        callback(null)
        return
    }
    let modal = document.querySelector('#importModal')
    if (!modal) {
        // Le DOM modal n'existe pas (tests headless, ancien HTML).
        // On ne fait pas crasher l'import : on retombe sur replace
        // silencieux comme avant l'introduction du modal.
        log('Import modal absent, replace par defaut')
        callback({ mode: 'replace', remember: false })
        return
    }
    importModalShown = true

    let info = document.querySelector('#importModalInfo')
    if (info) {
        info.textContent = 'Scene en cours : ' + opts.currentInfo + '\nScene a charger : ' + opts.importedInfo
    }

    // Pre-selection du radio sur le dernier choix memorise (defaut
    // 'replace' si pas de memoire ou valeur invalide). Le modal
    // s'affiche a chaque import (cf. importMeshFromText), c'est donc
    // le seul mecanisme pour proposer le bon defaut sans demander
    // explicitement "se souvenir".
    let previousMode = getStoredImportMode()
    let defaultMode = (previousMode === 'replace' || previousMode === 'merge') ? previousMode : 'replace'
    let radios = modal.querySelectorAll('input[name="importMode"]')
    radios.forEach(r => { r.checked = (r.value === defaultMode) })

    let validateBtn = document.querySelector('#importModalValidate')
    let cancelBtn = document.querySelector('#importModalCancel')

    let cleanup = () => {
        modal.hidden = true
        document.removeEventListener('keydown', onKey)
        modal.removeEventListener('click', onBackdrop)
        if (validateBtn) validateBtn.removeEventListener('click', onValidate)
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel)
        importModalShown = false
    }
    let onValidate = () => {
        let radio = modal.querySelector('input[name="importMode"]:checked')
        let mode = (radio && radio.value === 'merge') ? 'merge' : 'replace'
        cleanup()
        callback({ mode: mode })
    }
    let onCancel = () => {
        cleanup()
        callback(null)
    }
    let onKey = (e) => {
        if (e.key === 'Escape') onCancel()
    }
    let onBackdrop = (e) => {
        // Le clic sur le fond (backdrop) doit annuler. Le DOM modal
        // contient <div class="modal-backdrop"> comme premier enfant,
        // donc e.target sur la zone sombre est ce div, PAS #importModal.
        // On accepte les deux cas (clic direct sur le container ou sur
        // le div backdrop) ; les clics sur .modal-box ou ses enfants ne
        // correspondent pas a ces classes et ne declenchent rien.
        if (e.target && (e.target === modal || e.target.classList && e.target.classList.contains('modal-backdrop'))) {
            onCancel()
        }
    }

    if (validateBtn) {
        validateBtn.addEventListener('click', onValidate)
        validateBtn.focus()
    }
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey)
    modal.addEventListener('click', onBackdrop)
    modal.hidden = false
}

// Applique le payload importe selon le mode ('replace' ou 'merge').
// Choix deja fait plus haut ; ici on ne fait QUE l'application
// (reset d'etat ephemere, mutation de shapes, persist, redraw).
applyImport = (parsed, loaded, mode) => {
    let resetEphemeralState = () => {
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
    }

    if (mode === 'merge') {
        let beforeCount = shapes.length
        if (parsed.activeGrid !== undefined) activeGrid = !!parsed.activeGrid
        if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
            GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
        }
        loaded.forEach(s => shapes.push(s))
        activeShapeIndex = beforeCount
        if (activeShapeIndex < 0 || activeShapeIndex >= shapes.length) {
            activeShapeIndex = Math.max(0, shapes.length - 1)
        }
        resetEphemeralState()
        persistState()
        updateGridButtonText()
        updateShapeHud()
        drawBoard()
        let totalTris = shapes.reduce((acc, s) => acc + s.triangles.length, 0)
        log('Import merge OK: +' + loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + shapes.length + ' au total, ' + totalTris + ' triangles')
        return true
    }

    // Replace mode
    shapes = loaded
    if (typeof parsed.activeShapeIndex === 'number' && parsed.activeShapeIndex >= 0 && parsed.activeShapeIndex < shapes.length) {
        activeShapeIndex = parsed.activeShapeIndex
    } else {
        activeShapeIndex = 0
    }
    if (parsed.activeGrid !== undefined) activeGrid = !!parsed.activeGrid
    if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
        GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
    }
    resetEphemeralState()
    persistState()
    updateGridButtonText()
    updateShapeHud()
    drawBoard()
    let totalTris = shapes.reduce((acc, s) => acc + s.triangles.length, 0)
    log('Import OK: ' + shapes.length + ' forme' + (shapes.length > 1 ? 's' : '') + ', ' + totalTris + ' triangle' + (totalTris > 1 ? 's' : ''))
    return true
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
    shapes = [{ triangles: [] }]
    activeShapeIndex = 0
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
    updateShapeHud()
    log('Reset OK')
}

doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
}
