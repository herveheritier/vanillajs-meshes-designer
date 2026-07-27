// ---------------------------------------------------------------
// state.js
//
// Etat partage mutable (variables globales let) + accesseurs
// simples sur la scene/forme active et la navigation entre formes.
//
// Le reste du code accede a ces variables en lecture/ecriture
// directe (convention script-only : pas de wrapper namespace).
// Doit etre charge AVANT tout module qui utilise `shapes`,
// `selectedPoints`, etc.
// ---------------------------------------------------------------

let GRID_STEP = DEFAULT_GRID_STEP
let ctx = {
    center: { x: 50, y: 50 },
    // viewCenter est en COORDS MODELE (pas board pixels) : c'est le
    // point du modele qui apparait au centre du board. Initialement
    // l'origine (0,0) du modele.
    viewCenter: { x: 0, y: 0 },
    zoomLevel: 1,
    // Pas d'etat de rotation viewport ici : la "rotation de
    // scene" AltGlr+molette mute directement les vertices de
    // chaque forme (cf. rotateEachShapeAroundPivot). L'orientation
    // cumulee est portee par les vertices eux-memes.
    // rotationTracking est un compteur HUD-only : la somme
    // cumulee des angles appliques par rotateEachShapeAroundPivot,
    // affiche a cote du zoom dans #zoomDisplay pour donner un
    // feedback visuel apres plusieurs tours. PAS persiste en
    // localStorage (l'orientation est dans les vertices ; sur
    // reload, le HUD repart a 0 meme si la scene avait ete
    // pivotee). PAS dans le undo/redo (limitation mineure : apres
    // un undo la scene revient bien a sa position pre-rotation,
    // mais le HUD peut afficher un angle different — accepte en
    // compromis de simplicite).
    rotationTracking: 0,
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

// ---- Selection / interaction state (let, shared by HUD + interaction) ----
let nearestLine = undefined
let nearestPoint = undefined
let lastMousePos = undefined
let currentAction = undefined
let grabbedPoint = []
let relativeGrabbingPosition = undefined
let activeGrid = false
// Visibilite de la console in-canvas (overlay #messageBoard). Toggle
// via le bouton #console ou la touche `c` (cf. hud.js / events.js).
// Default true : on garde la console visible au chargement initial.
// Persistee dans localStorage (cf. import_export.js).
let consoleVisible = true
let selectedPoints = []
let isSelectingBox = false
let selectionBoxStart = undefined
let selectionBoxCurrent = undefined
let grabbedGroup = []
let grabStartMouse = undefined
// Move-all mode : set dans beginGrabbing a !!(e.ctrlKey && e.altKey)
// puis reset dans endGrabbing. On detecte Ctrl+Alt simultanes
// (AltGr / Right Alt est transmis comme Ctrl+Alt dans le DOM X11/Wayland)
// et non Alt seul, parce que les WM (GNOME, KDE, X11, Wayland) peuvent
// intercepter Alt+drag comme geste de deplacement de fenetre avant
// que l'evenement n'atteigne le navigateur. Quand true, beginGrabbing
// repeuple grabbedGroup avec TOUS les points de TOUTES les formes, et
// resolveMouseMoveOnBoard snap le delta au lieu de chaque point (pour
// preserver l'uniformite du mouvement entre formes quand la grille
// est activee).
let moveAllActive = false
// Pan : clic-milieu (button===1) sur board + drag souris. Le contenu
// "suit" le curseur : drag a droite -> viewCenter.x decroit, drag en
// bas -> viewCenter.y decroit (convention "drag content" comme les
// apps de dessin). Les deux panStart* sont captures au mousedown,
// puis chaque mousemove recalcule viewCenter depuis ces valeurs
// de reference (pas d'accumulation, ce qui rend le pan naturel
// meme si le mousemove rate des events).
let isPanning = false
let panStartMouse = undefined
let panStartViewCenter = undefined
let isSelectionDimmed = false

// ---- History / rotation / persistence (let, shared) ----
let historyStack = []
let redoStack = []
let isWheelRotating = false
let wheelRotateTimer = undefined
// Scene rotation par AltGr + wheel. Meme pattern que
// rotateSelectedPoints : saveState au premier tick d'un geste
// (avec timer 400ms pour la persistance), selectedPoints vide pour
// eviter que le surlignage cyan ne trompe l'utilisateur sur ce qui
// bouge (la rotation mute TOUS les points de TOUTES les formes).
let isEachShapeRotating = false
let eachShapeRotateTimer = undefined
// Pivot de rotation ALTGR (en COORDS MODELE) : re-evalue a chaque
// tick de la gesture AltGlr + wheel depuis screenToModel(cursorScreen).
// Le state passe a undefined quand isAltGlr devient faux (= debut/fin
// d'une gesture).
let altGrRotationPivot = undefined
// Migration LEGACY (etat transitoire d'une restauration loadState)
// : voir applyPendingRotationToShapes dans scene_ops.js. Remis a
// undefined quand la rotation a ete appliquee aux vertices.
let pendingRotation = undefined
// Timer "debounce" pour eviter de re-serialiser a chaque tick
// (cf. persistState dans import_export.js : 400 ms apres la
// derniere mutation).
let persistTimer = undefined
// Flag controle par showImportModal (modals.js / import_export.js)
// pour eviter une double ouverture du modal d'import pendant la
// duree du choix.
let importModalShown = false
