// =================================================================
// IMPORTS ES6 MODULES (refactor : split main.js en modules)
// =================================================================

import {
    TAU, COLOR_AXIS, COLOR_LINES, COLOR_LINES_INACTIVE, POINT_COLOR_INACTIVE,
    PATTERN_AXIS, PATTERN_LINES, PATTERN_LINES_INACTIVE,
    DEFAULT_GRID_STEP, MIN_GRID_STEP, MAX_GRID_STEP,
    ACTION_NONE, ACTION_GRABBING, MAX_HISTORY,
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP_FACTOR, ROTATE_STEP,
    CONSOLE_MIN_WIDTH, CONSOLE_MIN_HEIGHT,
    SCENE_STORAGE_KEY, GRID_STEP_STORAGE_KEY, ACTIVE_GRID_STORAGE_KEY,
    ZOOM_STORAGE_KEY, VIEW_CENTER_STORAGE_KEY, RETICLE_MODE_STORAGE_KEY,
    CONSOLE_VISIBLE_STORAGE_KEY, CONSOLE_FRAME_STORAGE_KEY, IMPORT_MODE_STORAGE_KEY,
} from './constants.js'

import { state, initDomRefs } from './state.js'

import {
    modelToScreen, screenToModel, snapToGrid,
    activeTriangles, isSceneEmpty,
    getAllVertices, getPointsAtSamePosition, isPointSelected,
    adjacentPoints, computeOrthogonalProjection, scalarProduct, isInsideSegmentByDot,
} from './geometry.js'

import {
    updateShapeHud, updateUndoRedoHud, updateSelectionHud,
    updateGridButtonText, updateReticleButton, updateConsoleButton,
} from './hud.js'

import {
    drawBoard, drawPoint, drawTriangle, drawAxis, drawGrid, drawReticle,
    drawShapes, drawShape, drawSelectedPoints, drawSelectionBox, drawLine, drawMouse,
} from './draw.js'

import {
    parsePair, ensurePointIndex, convertMeshesLineToMesh, convertMeshesToMeshes,
    importMeshesFromFile, autoImportMeshesFromUrl,
} from './convert.js'

import { log } from './log.js'

// Re-export pour la dep circulaire restante avec convert.js (sera
// extrait dans un futur commit import_export.js quand saveMesh et
// importMeshFromText auront leur propre module).
export { importMeshFromText }

// =================================================================
// Reste de main.js : encore beaucoup a migrer dans les modules
// superieurs (history, persist, modals, shapes, import_export,
// events). Le split actuel etablit le PATTERN ES6 + state + imports.
// =================================================================


// Scene = liste de formes ; SEULE la forme indexee par state.activeShapeIndex
// est editable. state.shapes[].triangles contient des triangless avec points
// partages entre triangles d'une meme forme (mais JAMAIS entre formes).

// Helper : triangles de la forme active (lecture/ecriture). Toute la
// logique d'edition doit passer par cet accessor.

// Helper : change la forme active proprement. Annule toute action
// en cours, vide la selection, recalcule le hover et le HUD.
let goToShape = (newIndex) => {
    if (!Array.isArray(state.shapes) || state.shapes.length === 0) return
    if (newIndex < 0 || newIndex >= state.shapes.length) return
    if (newIndex === state.activeShapeIndex) return
    state.currentAction = ACTION_NONE
    state.grabbedGroup = []
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    state.activeShapeIndex = newIndex
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    // Selection videe au switch de forme -> pilule a 0.
    updateSelectionHud()
}

let prevShape = () => {
    if (state.shapes.length <= 1) return
    goToShape((state.activeShapeIndex - 1 + state.shapes.length) % state.shapes.length)
}

let nextShape = () => {
    if (state.shapes.length <= 1) return
    goToShape((state.activeShapeIndex + 1) % state.shapes.length)
}

let addShape = () => {
    saveState()
    state.shapes.push({ triangles: [] })
    goToShape(state.shapes.length - 1)
    persistState()
}

let deleteShape = () => {
    // Ouvre la modale de confirmation (memes charte que
    // resetModal / importModal). Le message d'info est adapte
    // dynamiquement dans showDeleteShapeModal selon qu'on
    // supprime la derniere forme ou une parmi plusieurs. La
    // suppression effective est deferree a performDeleteShape,
    // appelee par le bouton primary de la modale.
    showDeleteShapeModal()
}

// Logique de suppression effective : extraite de l'ancien
// deleteShape (qui utilisait des confirm() natifs) pour etre
// appelable depuis le bouton primary de la modale. La logique
// "derniere forme => creer une scene vide" reste identique a
// avant, juste enveloppe dans une fonction distincte.
let performDeleteShape = () => {
    hideDeleteShapeModal()
    saveState()
    if (state.shapes.length === 1) {
        state.shapes = [{ triangles: [] }]
        state.activeShapeIndex = 0
    } else {
        state.shapes.splice(state.activeShapeIndex, 1)
        if (state.activeShapeIndex >= state.shapes.length) state.activeShapeIndex = state.shapes.length - 1
    }
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.grabbedGroup = []
    state.currentAction = ACTION_NONE
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateShapeHud()
    updateSelectionHud()
    persistState()
}

let showDeleteShapeModal = () => {
    let modal = document.querySelector('#deleteShapeModal')
    let info = document.querySelector('#deleteShapeModalInfo')
    if (!modal || !info) return
    // Message dynamique : si c'est la derniere forme, on va creer
    // une scene vide en remplacement (l'utilisateur ne peut pas
    // finir avec 0 formes, sinon la scene est indefinie). Sinon
    // on supprime juste la forme active. Meme pattern que l'ancien
    // confirm() mais transcrit dans la charte graphique.
    if (state.shapes.length === 1) {
        info.textContent = 'Supprimer la dernière forme et créer une scène vide ?'
    } else {
        info.textContent = 'Supprimer la forme active ?'
    }
    modal.hidden = false
}

let hideDeleteShapeModal = () => {
    let modal = document.querySelector('#deleteShapeModal')
    if (modal) modal.hidden = true
}


// HUD acompagnant la pile d'annulations : le compteur
// #undoCount reflete la profondeur de state.historyStack (read-only,
// pas cliquable), et les boutons #undo/#redo recoivent l'attribut
// disabled=true quand leur pile respective est vide. Appelee
// depuis saveState (mute les deux piles), undo/redo (pop +
// push croises), applyImport.resetEphemeralState et resetAll
// (clear applique), et au boot (etat initial "(0)" tant que
// rien n'a bouge). Meme pattern defensif que updateShapeHud :
// chaque query est tolere a l'absence (retour silencieux) pour
// ne pas crasher dans des contextes partiels (ex: ancien HTML,
// tests headless).

// HUD acompagnant la selection : la pilule #selectionCount
// reflete le nombre de points actuellement dans state.selectedPoints
// (read-only, pas cliquable). Centralisee : tout chemin qui
// mute state.selectedPoints appelle updateSelectionHud() pour
// garantir que la pilule reflete l'etat a coup sur. Meme
// pattern defensif que updateUndoRedoHud : si l'element
// manque (ancien HTML, tests headless) retour silencieux,
// on ne crash pas. Update via textContent (entier brut,
// pas d'HTML a formatter — textContent est plus rapide et
// sans risque d'injection que innerHTML).

// Reticule : guide visuel au curseur, 3 etats :
//   0 = invisible, 1 = crosshair simple, 2 = projection
//   symetrique selon les 2 axes (curseur + miroirs a (-x,y),
//   (x,-y), (-x,-y)). Persiste en localStorage (cle dediee, pas
//   dans la scene JSON — c'est une preference UI, pas un
//   contenu). Lecture defensive avec fallback a 0 si la cle est
//   corrompue / hors plage (meme pattern que state.consoleVisible).
try {
    let stored = localStorage.getItem(RETICLE_MODE_STORAGE_KEY)
    if (stored !== null) {
        let parsed = parseInt(stored)
        if (parsed === 0 || parsed === 1 || parsed === 2) state.reticleMode = parsed
    }
} catch (e) {}


// Le systeme de coordonnees du modele est en convention maths :
// X+ vers la droite, Y+ vers le haut. Les coordonnees capturees
// depuis les evenements souris sont en coords screen (origine
// top-left, Y vers le bas).
//
// La projection model <-> screen tient compte du zoom et du
// viewCenter (= le point du modele qui apparait au centre du board) :
//   s.x = state.ctx.center.x + (m.x - state.ctx.viewCenter.x) * state.ctx.zoomLevel
//   s.y = state.ctx.center.y - (m.y - state.ctx.viewCenter.y) * state.ctx.zoomLevel
// Inversee :
//   m.x = (s.x - state.ctx.center.x) / state.ctx.zoomLevel + state.ctx.viewCenter.x
//   m.y = state.ctx.viewCenter.y - (s.y - state.ctx.center.y) / state.ctx.zoomLevel
// Par defaut (zoom=1, viewCenter={0,0}), la projection se reduit a
// s = m + state.ctx.center (mappage direct sur le board).
// Move-all mode : set dans beginGrabbing a !!(e.ctrlKey && e.altKey)
// puis reset dans endGrabbing. On detecte Ctrl+Alt simultanes
// (AltGr / Right Alt est transmis comme Ctrl+Alt dans le DOM X11/Wayland)
// et non Alt seul, parce que les WM (GNOME, KDE, X11, Wayland) peuvent
// intercepter Alt+drag comme geste de deplacement de fenetre avant
// que l'evenement n'atteigne le navigateur. Quand true, beginGrabbing
// repeuple state.grabbedGroup avec TOUS les points de TOUTES les formes, et
// resolveMouseMoveOnBoard snap le delta au lieu de chaque point (pour
// preserver l'uniformite du mouvement entre formes quand la grille
// est activee).
// Pan : clic-milieu (button===1) sur board + drag souris. Le contenu
// "suit" le curseur : drag a droite -> viewCenter.x decroit, drag en
// bas -> viewCenter.y decroit (convention "drag content" comme les
// apps de dessin). Les deux panStart* sont captures au mousedown,
// puis chaque mousemove recalcule viewCenter depuis ces valeurs
// de reference (pas d'accumulation, ce qui rend le pan naturel
// meme si le mousemove rate des events).

// Toutes les fonctions ci-dessous considerent uniquement les triangles
// de la FORME ACTIVE pour les operations d'edition/selection.




// Clone profond d'un tableau de triangless. Preserve le partage des
// references de point entre triangles d'un meme tableau (un meme
// point physique reste un seul objet apres clonage).
let cloneTriArray = (triArray) => {
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
let cloneScene = (shapesArray) => {
    return shapesArray.map(s => ({ triangles: cloneTriArray(s.triangles) }))
}

let saveState = () => {
    state.historyStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex
    })
    if (state.historyStack.length > MAX_HISTORY) {
        state.historyStack.shift()
    }
    state.redoStack = []
    // Mute les deux piles : mettre a jour le HUD compteur +
    // disabled ici garantit que tout chemin qui passe par
    // saveState (editions, drags, rotations, delete, etc.)
    // voit son etat synchronise.
    updateUndoRedoHud()
}

let undo = () => {
    if (state.historyStack.length === 0) return
    state.currentAction = ACTION_NONE
    state.redoStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex
    })
    let entry = state.historyStack.pop()
    // L'entree empilee par saveState est `{shapes, activeShapeIndex}`
    // (PAS un `{state: {...}}`). Cette lecture `entry.state.shapes`
    // etait un bug latent qui n'avait jamais fired en pratique (les
    // tests browser du refactor ES6 ne touchaient pas undo/redo).
    // Le refactor a fait remonter l'erreur en mode strict.
    state.shapes = entry.shapes
    state.activeShapeIndex = entry.activeShapeIndex
    if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
        state.activeShapeIndex = 0
    }
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    state.grabbedGroup = []
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    drawBoard()
    if (state.lastMousePos) {
        updateMouseHover(state.lastMousePos)
    }
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    persistState()
}

let redo = () => {
    if (state.redoStack.length === 0) return
    state.currentAction = ACTION_NONE
    state.historyStack.push({
        shapes: cloneScene(state.shapes),
        activeShapeIndex: state.activeShapeIndex
    })
    let entry = state.redoStack.pop()
    // Meme forme d'entree que dans undo (`{shapes, activeShapeIndex}`
    // empilee par saveState). Le smoke test post-extraction log.js
    // a fait fire ce bug latent sur undo (clic sur le bouton
    // #undo apres avoir ajoute un point), on corrige redo avec la
    // meme symetrie par precaution.
    state.shapes = entry.shapes
    state.activeShapeIndex = entry.activeShapeIndex
    if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
        state.activeShapeIndex = 0
    }
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    state.grabbedGroup = []
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    drawBoard()
    if (state.lastMousePos) {
        updateMouseHover(state.lastMousePos)
    }
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    persistState()
}

// Init des refs DOM depuis state.js : queries centralisees,
// accessibles depuis les autres modules (draw.js notamment).
initDomRefs()
state.body.style.overflow = 'hidden'
state.board.style.border = 'solid 1px black'
state.board.style.width = '99vw'
state.board.style.height = '99vh'
state.board.width = state.board.getBoundingClientRect().width
state.board.height = state.board.getBoundingClientRect().height
state.board.style.cursor = 'none'
state.ctx.center.x = state.board.width / 2
state.ctx.center.y = state.board.height / 2
// Canvas 2D context : initialise ici une fois, stocke dans state pour
// que draw.js y accede via state._ctx.
state._ctx = state.board.getContext('2d')
state._ctx.fillStyle = '#000000'
state._ctx.fillRect(0, 0, state.board.width, state.board.height)
// Le '*** CONSOLE ***' initial est dans le HTML (#messageLog),
// plus dans innerText ici — la assignation supprimerait le
// bouton #clearConsole frere.


let gridBtn = document.querySelector('#grid')

// Toggle la grille (utilise par le clic sur le bouton et par le
// raccourci clavier 'g'). Centralise la logique pour eviter la
// divergence entre les deux points d'entree.
let toggleGrid = () => {
    state.activeGrid = !state.activeGrid
    updateGridButtonText()
    drawBoard()
    persistState()
}

gridBtn.addEventListener("click",(e) => {
    if (e.button !== 0) return
    toggleGrid()
})

gridBtn.addEventListener("wheel", (e) => {
    if (!state.activeGrid) return
    e.preventDefault()
    if (e.deltaY < 0) {
        state.GRID_STEP = Math.min(MAX_GRID_STEP, state.GRID_STEP + 4)
    } else if (e.deltaY > 0) {
        state.GRID_STEP = Math.max(MIN_GRID_STEP, state.GRID_STEP - 4)
    }
    updateGridButtonText()
    drawBoard()
    persistState()
}, { passive: false })

gridBtn.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
        e.preventDefault()
        if (!state.activeGrid) return
        state.GRID_STEP = DEFAULT_GRID_STEP
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

// === Réticule : ===
// Bouton 3 etats cycles au clic (off -> simple -> symetrique -> off).
// Meme pattern que toggleGrid : toggle + update visuel + redraw +
// persist. updateReticleButton synchronise le bouton (classe
// .reticle-active si mode >= 1, texte #reticleText avec le
// numero d'etat "1" / "2" / vide pour off). Persistance via la
// cle meshesDesigner.reticleMode (cf. declaration plus haut).
let toggleReticle = () => {
    state.reticleMode = (state.reticleMode + 1) % 3
    updateReticleButton()
    drawBoard()
    persistState()
}


let reticleBtn = document.querySelector('#reticle')
if (reticleBtn) reticleBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    toggleReticle()
})

// Init visuel (au boot, apres lecture de localStorage) : affiche
// l'etat courant dans le bouton. Idempotent avec le HTML par
// defaut (qui laisse le <span> vide).
updateReticleButton()

// Toggle la console des messages (utilise par le clic sur le
// bouton ; centralise comme toggleGrid). Preference persistee a
// part de la scene : l'overlay est ephemere, pas lie aux formes.

// Restauration depuis localStorage au chargement (meme pattern que
// IMPORT_MODE_STORAGE_KEY : pas de try/catch, les callers tolerent
// deja l'absence de cle).
if (localStorage.getItem(CONSOLE_VISIBLE_STORAGE_KEY) === '0') {
    state.consoleVisible = false
}


let toggleConsole = () => {
    state.consoleVisible = !state.consoleVisible
    updateConsoleButton()
    localStorage.setItem(CONSOLE_VISIBLE_STORAGE_KEY, state.consoleVisible ? '1' : '0')
}

let consoleBtn = document.querySelector('#toggleConsole')
if (consoleBtn) consoleBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    toggleConsole()
})

// Init : applique visuellement la preference restauree (meme
// quand state.consoleVisible=true, set style.display='' est idempotent).
updateConsoleButton()

// === Console frame : position + taille draggables, persistees ===
// La cadre de la console a un bandeau superieur (drag handle) et
// une poignee SE (resize). Les valeurs en px (left, top, width,
// height) sont posees sur #messageBoard via JS pendant le drag,
// puis memorisees dans localStorage a la fin du drag pour survivre
// au rechargement. Cle isolee de la scene (cf. cle separee aussi
// pour state.consoleVisible et importMode — pas dans la scene JSON).

let applyConsoleFrame = () => {
    if (!state.messageBoard) return
    try {
        let stored = localStorage.getItem(CONSOLE_FRAME_STORAGE_KEY)
        if (!stored) return
        let f = JSON.parse(stored)
        if (!f || typeof f !== 'object') return
        // Validation : on n'applique que si les valeurs sont san-
        // seisantes. Un top/left negatif n'a pas de sens ; width
        // /height en dessous d'un minimum fonctionnel (80/30)
        // rendrait le cadre inutilisable (resize listener borne a
        // ces memes minimums en JS). dropped => garde la CSS
        // default (top:64px, left:1vw, width:auto, height:auto).
        if (typeof f.left === 'number' && f.left >= 0) state.messageBoard.style.left = f.left + 'px'
        if (typeof f.top === 'number' && f.top >= 0) state.messageBoard.style.top = f.top + 'px'
        if (typeof f.width === 'number' && f.width >= 80) state.messageBoard.style.width = f.width + 'px'
        if (typeof f.height === 'number' && f.height >= 30) state.messageBoard.style.height = f.height + 'px'
    } catch (e) {}
}

let persistConsoleFrame = () => {
    if (!state.messageBoard) return
    try {
        // On ecrit la position / taille en px (parseInt extrait le
        // nombre, ignore 'px' ; utilise 0 si absent/auto). C'est
        // importe d'ecrire MEME si l'utilisateur n'a pas bouge,
        // pour que le CSS default '1vw' soit converti en px exact
        // (plus stable au reload quelle que soit la largeur
        // viewport).
        let f = {
            left: parseInt(state.messageBoard.style.left) || 0,
            top: parseInt(state.messageBoard.style.top) || 0,
            width: parseInt(state.messageBoard.style.width) || 0,
            height: parseInt(state.messageBoard.style.height) || 0
        }
        localStorage.setItem(CONSOLE_FRAME_STORAGE_KEY, JSON.stringify(f))
    } catch (e) {}
}

// === Drag/resize state ===
// Deux flags distincts pour bouger vs redimensionner, plus une
// capture de la position initiale au mousedown pour calculer les
// deltas en mousemove. Pas d'accumulation : le mousemove applique
// (current - initial) sur la valeur stockée, donc meme si un
// event est rate, le tick suivant produit la position correcte.

// === Mousedown handlers (sur elements precis, pas document) ===
// e.button === 0 strict : un mousedown au milieu ou a droite ne
// lance pas un drag. La classe body.dragging-console /
// resizing-console set le cursor OS en !important (le canvas a
// cursor: 'none' inline ; pas de regle non-important ne l'out-
// repasse). restore au mouseup.
// Note : `document.body` (et NON `document.state.body`). Le bulk
// rename du refactor ES6 avait transforme `document.body` en
// `document.state.body` (10 sites au total), pattern qui n'a
// aucun sens : `document.state` est undefined, donc l'acces jetait
// TypeError des que l'utilisateur touchait la console ou cliquait
// sur les boutons d'import. Restore ici l'original. Meme
// pattern que le fix `entry.state.X` -> `entry.X` sur undo/redo.
let consoleTitleBar = document.querySelector('#consoleTitleBar')
if (consoleTitleBar) consoleTitleBar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (!state.messageBoard) return
    e.preventDefault()
    state.consoleMoving = true
    // Capture une seule fois (au mousedown) le rect + position
    // souris. Le delta en mousemove se calcule a partir de ces
    // refs, pas d'accumulation.
    let rect = state.messageBoard.getBoundingClientRect()
    state.consoleDragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        mbLeft: rect.left,
        mbTop: rect.top
    }
    document.body.classList.add('dragging-console')
})

let consoleResizeHandle = document.querySelector('#consoleResizeHandle')
if (consoleResizeHandle) consoleResizeHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (!state.messageBoard) return
    e.preventDefault()
    state.consoleResizing = true
    let rect = state.messageBoard.getBoundingClientRect()
    state.consoleDragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        mbWidth: rect.width,
        mbHeight: rect.height
    }
    document.body.classList.add('resizing-console')
})

// === Mousemove document-level ===
// Handler distinct du mousemove existant (qui dispatche sur
// resolveMouseMoveOnBoard si e.target est board) — pas de conflit,
// les deux early-return quand leur condition n'est pas remplie.
// Pas de transition CSS sur left/top/width/height : les transitions
// rendraient le drag lent/laggy.
document.addEventListener('mousemove', (e) => {
    if (!state.consoleMoving && !state.consoleResizing) return
    if (!state.messageBoard) return
    if (!state.consoleDragStart) return
    let dx = e.clientX - state.consoleDragStart.mouseX
    let dy = e.clientY - state.consoleDragStart.mouseY
    if (state.consoleMoving) {
        state.messageBoard.style.left = (state.consoleDragStart.mbLeft + dx) + 'px'
        state.messageBoard.style.top = (state.consoleDragStart.mbTop + dy) + 'px'
    } else if (state.consoleResizing) {
        // Le resize est ancre en haut-gauche : le coin top-left du
        // cadre ne bouge pas, on elargit vers le bas-droite. Math
        // aux minimums (80x30) pour eviter que l'utilisateur
        // ecrase le cadre a 0x0 (devient inutilisable).
        let w = Math.max(CONSOLE_MIN_WIDTH, state.consoleDragStart.mbWidth + dx)
        let h = Math.max(CONSOLE_MIN_HEIGHT, state.consoleDragStart.mbHeight + dy)
        state.messageBoard.style.width = w + 'px'
        state.messageBoard.style.height = h + 'px'
    }
})

// === Mouseup document-level ===
document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    if (!state.consoleMoving && !state.consoleResizing) return
    state.consoleMoving = false
    state.consoleResizing = false
    state.consoleDragStart = null
    document.body.classList.remove('dragging-console')
    document.body.classList.remove('resizing-console')
    // Persist uniquement a la fin du drag (pas pendant le mousemove)
    // — localStorage n'est pas concu pour du haut debit, et les
    // valeurs intermediaires sont transitoires.
    persistConsoleFrame()
})

// === Reset au blur ===
// Edge case : si l'utilisateur commence un drag, puis change de
// fenetre ou alt-tab pendant le drag, le mouseup peut etre rate.
// Sans ce handler, les flags restent a true indefiniment et le
// prochain mousemove reprendrait le drag la ou il etait, en
// utilisant un ancien dragStart — comportement bizarre. Reset
// propre au blur.
window.addEventListener('blur', () => {
    if (!state.consoleMoving && !state.consoleResizing) return
    state.consoleMoving = false
    state.consoleResizing = false
    state.consoleDragStart = null
    document.body.classList.remove('dragging-console')
    document.body.classList.remove('resizing-console')
    persistConsoleFrame()
})

// Au boot : applique le frame precedemment sauvegarde. Si pas de
// cle, garde top:64px / left:1vw / width:auto / height:auto
// definis dans la CSS de #messageBoard.
applyConsoleFrame()

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

let selectAllPoints = () => {
    let result = []
    getAllVertices().forEach(p => {
        getPointsAtSamePosition(p).forEach(q => {
            if (!result.some(r => r === q)) result.push(q)
        })
    })
    state.selectedPoints = result
    state.nearestPoint = undefined
    drawBoard()
    if (state.lastMousePos) {
        updateMouseHover(state.lastMousePos)
    }
    // Toute la forme est selectionnee -> pilule reflete result.length.
    updateSelectionHud()
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
        // `document.body` : voir le commentaire en L555 pour le
        // pattern de sur-rename du bulk refactor.
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
        // `document.body` : voir le commentaire en L555 pour le
        // pattern de sur-rename du bulk refactor.
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

// Wiring des boutons Annuler / Retablir de la toolbar. Meme
// pattern defensif que les autres boutons (tolere l'absence
// pour les tests headless / ancien HTML). Les fonctions undo()
// et redo() sont deja courtes : si la pile correspondante est
// vide elles no-op immediatement ; le bouton est de toute
// facon desactive via l'attribut HTML disabled (cf.
// updateUndoRedoHud), donc double securite.
let undoToolbarBtn = document.querySelector('#undo')
if (undoToolbarBtn) undoToolbarBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    undo()
})

let redoToolbarBtn = document.querySelector('#redo')
if (redoToolbarBtn) redoToolbarBtn.addEventListener('click', (e) => {
    if (e.button !== 0) return
    redo()
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
    // Fin d'un pan clic-milieu. On persist le viewCenter final mem'
    // si l'utilisateur n'a pas bouge entre mousedown et mouseup (force un
    // save pour eviter qu'une scene non persistee avant un pan vide
    // soit perdue apres une fermeture).
    if(state.isPanning && e.button===1) {
        state.isPanning = false
        state.panStartMouse = undefined
        state.panStartViewCenter = undefined
        persistState()
    }
    if(e.target.id==='board' && e.button===0) {
        if(state.isSelectingBox) {
            let dist = Math.hypot(state.selectionBoxCurrent.x - state.selectionBoxStart.x, state.selectionBoxCurrent.y - state.selectionBoxStart.y)
            state.isSelectingBox = false
            if(dist < 5) {
                let mouseScreen = { x: e.x - state.board.getBoundingClientRect().x, y: e.y - state.board.getBoundingClientRect().y }
                let np = findNearestPoint(screenToModel(mouseScreen))
                if(np && np.distance < 15) {
                    let pointsAtPos = getPointsAtSamePosition(np.point)
                    // Trois branches mutuellement exclusives sur les modifiers :
                    //   - shift : toggle (existant)
                    //   - ctrl/meta : ajoute a la selection sans toggle (NEW)
                    //   - aucun : remplace (existant)
                    // shift teste en premier pour preserver sa priorite si
                    // l'utilisateur combine shift+ctrl (rare). ctrl + metaKey
                    // supportes ensemble : Ctrl sur Linux/Windows, Cmd sur Mac.
                    // L'operation 'ajouter sans toggle' est idempotente : si le
                    // point (ou le cluster getPointsAtSamePosition) est deja
                    // dans la selection, le push n'ajoute pas de doublon (filtre
                    // isPointSelected ci-dessous).
                    if(e.shiftKey) {
                        let anySelected = pointsAtPos.some(p => isPointSelected(p))
                        if(anySelected) {
                            state.selectedPoints = state.selectedPoints.filter(sp => !pointsAtPos.some(p => adjacentPoints(sp, p, 0.01)))
                        } else {
                            pointsAtPos.forEach(p => {
                                if(!isPointSelected(p)) state.selectedPoints.push(p)
                            })
                        }
                    } else if(e.ctrlKey || e.metaKey) {
                        // Ctrl/Cmd + click sur un point : AJOUTE a la selection.
                        // Permet d'accumuler une selection point-par-point en
                        // chainant plusieurs Ctrl+click, sans devoir maintenir
                        // un modifier jusqu'a la fin d'un geste (le user
                        // clique, relache, reclique ailleurs, etc.).
                        pointsAtPos.forEach(p => {
                            if(!isPointSelected(p)) state.selectedPoints.push(p)
                        })
                    } else {
                        state.selectedPoints = [...pointsAtPos]
                    }
                } else {
                    // Clic en espace vide (pas de point proche).
                    //   - plain : clear selection + cree un point (creation).
                    //   - shift : preserve selection + cree un point (existant).
                    //   - ctrl/meta : preserve selection, NE cree PAS de point
                    //     (modifiers = operations sur la selection, pas sur
                    //     la scene). Coherent avec la nouvelle branche
                    //     'ajouter sans toggle' : Ctrl+click accidentel en vide
                    //     ne pollue pas la scene.
                    if(e.shiftKey) {
                        resolveMouseClickOnBoard(e)
                    } else if(e.ctrlKey || e.metaKey) {
                        // no-op : ne cree pas de point, ne touche pas a la
                        // selection. Evite qu'un Ctrl+click maladroit n'ajoute
                        // un sommet fantome.
                    } else {
                        state.selectedPoints = []
                        resolveMouseClickOnBoard(e)
                    }
                }
            }
            drawBoard()
            // Pilule selection : tout le bloc if(dist<5) ci-dessus
            // mute state.selectedPoints selon le modifier (shift toggle,
            // ctrl add, rien replace) ou clear en espace vide.
            // Un seul appel a la fin couvre toutes les branches.
            updateSelectionHud()
        }
    }
})

document.addEventListener('mousedown',(e) => {
    if(e.target.id==='board') {
        let mousePos = { x: e.x - state.board.getBoundingClientRect().x, y: e.y - state.board.getBoundingClientRect().y }
        if(e.button===2) {
            beginGrabbing(e)
        } else if(e.button===0) {
            state.selectionBoxStart = mousePos
            state.selectionBoxCurrent = mousePos
            state.isSelectingBox = true
        } else if(e.button===1) {
            // Clic-milieu : debut d'un pan du viewCenter. On sauve la
            // position screen + le viewCenter courant pour les utiliser
            // comme references dans resolveMouseMoveOnBoard. e.preventDefault
            // sur le mousedown est inutile car le browser n'a pas de
            // comportement par defaut sur clic du milieu sur un canvas
            // (pas de scroll/paste ici), mais on le met par precaution
            // et pour eviter une potentielle selection native.
            state.isPanning = true
            state.panStartMouse = mousePos
            state.panStartViewCenter = { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y }
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
    // R : cycle du mode reticule (off -> simple -> symetrique -> off).
    // Meme pattern que 'G' pour la grille : pas de modifier, ignore
    // si la cible est dans un input (ne pas capter la frappe quand
    // l'utilisateur tape un 'r' dans un futur champ texte) ou dans
    // #grid (evite le double-toggle consecutif apres un clic).
    let inReticleBtn = t && typeof t.closest === 'function' && t.closest('#reticle')
    if (!typing && !inReticleBtn && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        toggleReticle()
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
    // Escape ferme la modale d'aide, la modale de reinit OU la
    // modale de suppression de forme si l'une d'elles est ouverte
    // (priorite a l'aide si plusieurs le sont — heritage de
    // l'ordre d'apparition historique).
    let isResetOpen = resetModal && !resetModal.hidden
    let isDeleteShapeOpen = deleteShapeModal && !deleteShapeModal.hidden
    if (e.code === 'Escape' && !e.repeat && (isHelpOpen || isResetOpen || isDeleteShapeOpen)) {
        e.preventDefault()
        if (isHelpOpen) hideHelp()
        if (isResetOpen) hideResetModal()
        if (isDeleteShapeOpen) hideDeleteShapeModal()
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
        // scene (100% + origine modele au centre, scene non
        // rotatee). Memo pour eviter un double-fire sur repeat
        // clavier. apres le reset, on redessine et on met a jour le
        // HUD pour que l'indicateur tombe a "1.0x rot 0".
        if (e.repeat) return
        e.preventDefault()
        state.ctx.zoomLevel = 1
        state.ctx.viewCenter.x = 0
        state.ctx.viewCenter.y = 0
        // Le compteur de rotation retombe a 0 lui aussi : la
        // scene est dans un etat "neuf" (zoom 100%, origine au
        // centre, aucune rotation cumulee affichee).
        state.ctx.rotationTracking = 0
        drawBoard()
        if (state.lastMousePos) updateMouseHover(state.lastMousePos)
        updateZoomDisplay()
        persistState()
    }
})

let helpModal = document.querySelector('#helpModal')

let showHelp = () => {
    if (!helpModal) return
    helpModal.hidden = false
}

let hideHelp = () => {
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

let showResetModal = () => {
    if (!resetModal) return
    resetModal.hidden = false
}
let hideResetModal = () => {
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

// Modale de suppression d'une forme. Meme pattern que resetModal /
// importModal : element + bouton Annuler + bouton primary +
// delegation du clic sur le backdrop. show/hide centralises comme
// les autres modales. La validation declenche performDeleteShape
// (extrait de l'ancien deleteShape qui utilisait des confirm()
// natifs). Pas de confirm() natif ici pour rester coherent avec
// la charte graphique des autres modales (resetModal, importModal).
let deleteShapeModal = document.querySelector('#deleteShapeModal')

let deleteShapeModalCancelBtn = document.querySelector('#deleteShapeModalCancel')
if (deleteShapeModalCancelBtn) deleteShapeModalCancelBtn.addEventListener('click', () => hideDeleteShapeModal())
let deleteShapeModalValidateBtn = document.querySelector('#deleteShapeModalValidate')
if (deleteShapeModalValidateBtn) deleteShapeModalValidateBtn.addEventListener('click', performDeleteShape)
if (deleteShapeModal) deleteShapeModal.addEventListener('click', (e) => {
    let target = e.target
    if (target && target.dataset && target.dataset.deleteShapeClose !== undefined) hideDeleteShapeModal()
})


// Molette : trois branches dans l'ordre suivant :
//   (1) AltGr + molette = rotation de la scene ENTIERE autour du
//       curseur (chacun des N wheel ticks pivote d'un meme angle) ;
//   (2) 2+ points selectionnes = rotation des points selectionnes
//       autour du point sous le curseur (comportement historique) ;
//   (3) sinon : zoom centre sur le curseur.
// Le pan du viewCenter se fait separement, via clic-milieu
// (button===1) sur le board + drag souris, voir
// resolveMouseMoveOnBoard.
state.board.addEventListener('wheel', (e) => {
    e.preventDefault()
    let boardRect = state.board.getBoundingClientRect()
    let cursorScreen = { x: e.x - boardRect.x, y: e.y - boardRect.y }
    // Detection AltGr : on reutilise la meme primitive robuste que
    // dans beginGrabbing (Ctrl+Alt OU getModifierState('AltGraph'))
    // pour eviter les conflits avec le WM qui peuvent intercepter
    // Alt seul.
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    if (isAltGrDown) {
        // A CHAQUE tick de la gesture AltGlr + wheel : on capture
        // la POSITION DU CURSEUR DANS LA SCENE (= coords modele
        // du point sous la souris avec la rotation cumulee
        // COURANTE) comme pivot de rotation. Le pivot suit le
        // curseur en espace model tick apres tick :
        //   - curseur immobile pendant le geste : le pivot est
        //     INVARIANT (memes proprietes anti-drift qu'un
        //     lock-at-first-tick screen, puisque le model feature
        //     vise ne change pas si la souris ne bouge pas),
        //   - curseur qui bouge pendant le geste : le pivot suit
        //     la souris = rotation orbitale classique. La scene
        //     pivote autour du model feature courant sous le
        //     curseur.
        //
        // On passe en coords MODELE : la rotation est par essence
        // autour d'un point dans la scene ("autour du curseur dans
        // la scene"), pas d'un pixel screen. Le code de rendu
        // (modelToScreen / screenToModel) derive a chaque appel
        // le pivot screen effectif depuis ce pivot modele.
        state.altGrRotationPivot = screenToModel(cursorScreen)
        let angle = e.deltaY < 0 ? -ROTATE_STEP : ROTATE_STEP
        rotateEachShapeAroundPivot(state.altGrRotationPivot, angle)
        return
    }
    // Sans AltGlr : on libere le pivot capture pour que la
    // prochaine gesture AltGlr demarre sur un nouveau point.
    // (= relacher AltGlr briavement = "je veux recadrer la
    // rotation autour d'un autre point de la scene".) Edge case
    // : si l'utilisateur voitures avec un doigt sans AltGlr au
    // milieu d'une sequence AltGlr, le pivot est reset mais la
    // rotation cumulee reste (pas catastrophe).
    if (state.altGrRotationPivot) state.altGrRotationPivot = undefined
    let canRotate = state.selectedPoints.length >= 2 && !state.isSelectionDimmed
    if (canRotate) {
        // Ancien comportement : rotation autour du model point sous
        // le curseur (uniquement les points selectionnes de la forme
        // active).
        let center = screenToModel(cursorScreen)
        let angleStep = ROTATE_STEP
        let angle = e.deltaY < 0 ? -angleStep : angleStep
        rotateSelectedPoints(center, angle)
    } else {
        // Zoom centre sur le curseur. Math :
        //   m_under = (cursorScreen - state.ctx.center) / oldZoom + viewCenter
        //   Apres zoom on veut garder m_under sous cursorScreen :
        //     cursorScreen.x = state.ctx.center.x + (m_under.x - newVC.x) * newZoom
        //   => newVC.x = viewCenter.x + (cursorScreen.x - state.ctx.center.x) * (1/oldZoom - 1/newZoom)
        let oldZoom = state.ctx.zoomLevel
        let factor = e.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR
        let newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor))
        if (newZoom === oldZoom) return
        state.ctx.viewCenter.x += (cursorScreen.x - state.ctx.center.x) * (1 / oldZoom - 1 / newZoom)
        state.ctx.viewCenter.y -= (cursorScreen.y - state.ctx.center.y) * (1 / oldZoom - 1 / newZoom)
        state.ctx.zoomLevel = newZoom
        drawBoard()
        if (state.lastMousePos) updateMouseHover(state.lastMousePos)
        updateZoomDisplay()
        persistState()
    }
}, { passive: false })

state.board.addEventListener("dragover", (e) => {
    e.preventDefault()
})
state.board.addEventListener("drop", (e) => {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    let file = e.dataTransfer.files[0]
    importMeshFromFile(file)
})


// Scene rotation par AltGr + wheel. Meme pattern que
// rotateSelectedPoints : saveState au premier tick d'un geste
// (avec timer 400ms pour la persistance), state.selectedPoints vide pour
// eviter que le surlignage cyan ne trompe l'utilisateur sur ce qui
// bouge (la rotation mute TOUS les points de TOUTES les formes).
// Meme pattern que rotateSelectedPoints : saveState au premier tick,
// timer 400ms, selection videe au debut.
// Pivot de rotation ALTGR (en COORDS MODELE) : re-evalue a chaque
// tick de la gesture AltGlr + wheel depuis screenToModel(cursorScreen).
// Comme screenToModel ne depend que de la camera transform (zoom +
// viewCenter), le pivot est invariant tant que la souris reste fixe
// sur le meme pixel screen (drift-free : +5/-5 sans bouger la souris
// = identite) ; si la souris bouge, le pivot suit et les formes
// "orbitent" autour de la nouvelle position.
// Le state passe a undefined quand isAltGlr devient faux (= debut/fin
// d'une gesture).

// Migration LEGACY (etat transitoire d'une restauration
// loadState) : si la scene chargee avait ete sauvegardee
// avec l'ancien code viewport-rotation, on y trouve un champ
// data.rotation (radians) et un data.rotationPivot (model ou
// ancien screen). On ne peut pas l'appliquer aux vertices ici
// car state.shapes n'est pas encore charge ; on stocke dans
// state.pendingRotation, et le code de loadState applique apres
// buildShapesFromPayload. Remis a undefined quand applique.

// Helper : applique la rotation "legacy viewport" stockee dans
// state.pendingRotation aux vertices de chaque forme passee en argument.
// Meme formule CCW standard que rotateEachShapeAroundPivot (et
// rotateSelectedPoints), juste appelee une fois en bloc sur un
// tableau de formes au lieu d'un point a la fois. Utilisee par
// loadState ET applyImport pour migrer les scenes sauvegardees
// avec l'ancien format viewport-rotation : voir state.pendingRotation
// plus haut dans loadState pour le parsing initial.
let applyPendingRotationToShapes = (shapeArray) => {
    if (!state.pendingRotation || !shapeArray || shapeArray.length === 0) return
    let angle = state.pendingRotation.angle
    let pivot = state.pendingRotation.pivot
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
    state.pendingRotation = undefined
}

let rotateEachShapeAroundPivot = (pivotModel, angle) => {
    // Rotation PER-SHAPE (mutation reelle des vertices), pas une
    // rotation de viewport : on itere sur TOUTES les formes et
    // TOUS leurs points (chaque triangle p1/p2/p3) et on tourne
    // chacun autour du pivot en coords modele. Meme formule que
    // rotateSelectedPoints, juste sur un scope plus large.
    //
    // Choix "Suivre à chaque tick" : le wheel handler passe un
    // pivot re-evalue a chaque wheel event (state.altGrRotationPivot =
    // screenToModel(cursorScreen)). Si la souris reste fixe, M_k
    // est invariant ; si elle bouge, le pivot suit (= rotation
    // orbitale).
    if (!state.shapes || state.shapes.length === 0) return
    if (!state.isEachShapeRotating) {
        saveState()
        state.isEachShapeRotating = true
            // Vider la selection : la rotation mute TOUS les points,
            // pas seulement les selectionnes ; ne pas laisser le
            // surlignage cyan suggerer le contraire.
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
    // Affiche ensuite en degres dans updateZoomDisplay (tour
    // complet = retour a 0 degre).
    state.ctx.rotationTracking = ((state.ctx.rotationTracking + angle) % TAU + TAU) % TAU

    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateZoomDisplay()
}

let rotateSelectedPoints = (center, angle) => {
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

    let activeShapeRef = state.shapes[state.activeShapeIndex]

    state.selectedPoints.forEach(sp => {
        let dx = sp.x - center.x
        let dy = sp.y - center.y
        let nx = center.x + dx * cos - dy * sin
        let ny = center.y + dx * sin + dy * cos

        let target = { x: nx, y: ny }
        if (state.activeGrid) {
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
    if (state.lastMousePos) {
        updateMouseHover(state.lastMousePos)
    }
}

let deleteSelectedPoint = () => {
    let targets = []
    if (state.selectedPoints.length > 0) {
        targets = [...state.selectedPoints]
    } else if (state.nearestPoint && state.nearestPoint.point) {
        targets = getPointsAtSamePosition(state.nearestPoint.point)
    }
    if(targets.length === 0) return
    saveState()
    let activeShapeRef = state.shapes[state.activeShapeIndex]
    // Regle : la suppression d'un segment est effective SSI l'un
    // de ses points n'existe pas. Quand on supprime un point P :
    //   - chaque triangle contenant P voit P retire de ses slots ;
    //   - les segments incidents a P (deux par triangle) sont
    //     supprimes implicitement (l'un de leurs points n'existe
    //     plus, la regle s'applique) ;
    //   - le segment OPPOSE (entre les deux autres points du
    //     triangle) survit car ses deux endpoints existent
    //     toujours.
    // Pour representer ca dans le modele triangle-only, on
    // reordonne les slots du triangle pour ramener les points
    // survivants en tete (t.p1, t.p2, t.p3) et laisse undefined
    // pour les slots non utilises. drawTriangle trace alors
    // naturellement le segment p1->p2 quand p3===undefined (cf.
    // son test "if (p2 !== undefined)" qui saute le lineTo vers
    // p3, et l'absence de lineTo de fermeture).
    // Un triangle dont il reste <2 points survivants est filtre
    // (degenere : 0 segment possible ; les eventuels points
    // orphelins disparaissent avec).
    activeShapeRef.triangles = activeShapeRef.triangles
        .map(t => {
            let surviving = []
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
    if(state.lastMousePos) {
        updateMouseHover(state.lastMousePos)
    }
    updateSelectionHud()
    persistState()
}



// Efface le contenu de la console. Le bouton #clearConsole est
// rendu inoperant quand la console est cachee par toggleConsole
// (display:none sur #messageBoard cache aussi son contenu). Une
// confirmation n'est pas demandee : les logs sont ephemeres
// (non persistes en localStorage), pas un etat irreversible.
let clearConsole = () => {
    if (!state.messageLog) return
    state.messageLog.innerText = ''
}

let clearConsoleBtn = document.querySelector('#clearConsole')
if (clearConsoleBtn) {
    // stopPropagation sur mousedown : empeche le drag du bandeau
    // parent de se declencher quand l'utilisateur veut juste
    // effacer la console ("mousedown sur bouton" ne doit pas
    // demarrer un drag accidentel sur le titre). e.stopPropagation
    // court-circuite la propagation au titre (le listener du
    // titre ne voit pas l'event).
    clearConsoleBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    clearConsoleBtn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        clearConsole()
    })
}

let grabbed = () => {
    return state.currentAction === ACTION_GRABBING
}

let beginGrabbing = (e) => {
    let mouseScreen = {
        x : e.x - state.board.getBoundingClientRect().x,
        y : e.y - state.board.getBoundingClientRect().y
    }    // Detection AltGr robuste : on accepte (a) le couple DOM
    // ctrlKey+altKey (cas Linux X11/Wayland classiques) OU (b)
    // getModifierState('AltGraph') (primitive W3C, fonctionne
    // meme quand le DOM ne traduit pas AltGr en Ctrl+Alt sur
    // certaines configs XKB ou ecrans tactiles). Le test
    // d'existence evite un crash si getModifierState est absent
    // (vieux navigateurs).
    const isAltGrDown = (e.ctrlKey && e.altKey) || (e.getModifierState && e.getModifierState('AltGraph'))
    state.moveAllActive = isAltGrDown
    state.grabbedGroup = []


    // AltGr (Ctrl+Alt, transmis comme tel par le DOM) tenu pendant
    // le drag = deplacer TOUTES les formes d'un meme delta (quasi-
    // mode capture au mousedown : le relachement d'AltGr pendant le
    // drag ne change rien). Mode SCENE-WIDE : pas d'ancre sur un
    // point, on accepte le grab meme en espace vide (le user n'a
    // pas besoin de cliquer pile sur un sommet pour demarrer un
    // move-all). C'est la raison pour laquelle on branche sur
    // AltGr AVANT le test findNearestPoint : sans ca, un clic droit
    // dans une zone vide court-circuite tout le drag.
    if (isAltGrDown) {
        state.currentAction = ACTION_GRABBING
        state.grabStartMouse = mouseScreen
        // Vider la selection pour eviter que le surlignage cyan
        // des points de la forme active laisse croire a
        // l'utilisateur que seuls ces points bougent. Le message de
        // log ci-dessous annonce le nombre TOTAL de points (toutes
        // formes), ce qui doit etre la seule reference visible.
        state.selectedPoints = []
        updateSelectionHud()
        state.shapes.forEach((shape, sIndex) => {
            shape.triangles.forEach((t, tIndex) => {
                ['p1','p2','p3'].forEach((pid, j) => {
                    let p = t[pid]
                    if (!p) return
                    state.grabbedGroup.push({
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
        // Scene vide : aucune forme n'a de triangles, donc rien a
        // deplacer. On annule AVANT saveState pour ne pas polluer
        // l'historique undo avec une entree vide, et on laisse
        // l'etat interne coherent (state.currentAction / state.grabStartMouse
        // remis, pas de curseur 'move' signale).
        if (state.grabbedGroup.length === 0) {
            state.currentAction = undefined
            state.grabStartMouse = undefined
            return
        }
        // Snapshot pour undo (cf. fin de grab dans endGrabbing).
        saveState()
        log('AltGr detecte - deplacement de ' + state.shapes.length + ' forme(s) : ' + state.grabbedGroup.length + ' points')
        // Curseur OS 'move' pendant le drag en mode 'toutes les
        // formes'. Le canvas dessine son propre curseur drawMouse,
        // mais le curseur OS sert de fallback si jamais il redevient
        // visible (ex: sorties de canvas) et de signal visuel en
        // backup. Restore dans endGrabbing.
        state.board.style.cursor = 'move'
        return
    }

    // Mode historique (sans Alt) : grab ancre sur le point le plus
    // proche, ne bouge que la forme active. Si aucun point n'est
    // proche de la souris, le drag est abandonne (early-return).
    let np = findNearestPoint(screenToModel(mouseScreen))
    if(!np || !np.point) return

    state.currentAction = ACTION_GRABBING
    state.grabStartMouse = mouseScreen
    saveState()

    if(!isPointSelected(np.point)) {
        let pointsAtPos = getPointsAtSamePosition(np.point)
        if(!e.shiftKey) {
            state.selectedPoints = [...pointsAtPos]
        } else {
            pointsAtPos.forEach(p => {
                if(!isPointSelected(p)) state.selectedPoints.push(p)
            })
        }
        // Branche non-AltGlr de beginGrabbing : mute state.selectedPoints
        // selon le modifier (remplace ou ajoute). Pilule mise a
        // jour ici plutot qu'en fin de fonction pour eviter un
        // decalage si la logique plus bas mute a nouveau.
        updateSelectionHud()
    }

    let tris = activeTriangles()
    state.selectedPoints.forEach(sp => {
        tris.forEach( (t,i) => {
            [t.p1,t.p2,t.p3].forEach( (p,j) => {
                if(p && adjacentPoints(p, sp, 0.01)) {
                    state.grabbedGroup.push({
                        shapeIndex: state.activeShapeIndex,
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

let endGrabbing = (e) => {
    state.currentAction = ACTION_NONE
    resolveMouseMoveOnBoard(e)
    // Restore le curseur OS : beginGrabbing peut l'avoir passe en
    // 'move' (Alt tenu = mode toutes les formes). Le canvas est
    // en 'none' par defaut (curseur custom drawMouse), donc meme
    // si beginGrabbing ne l'a pas change l'ecriture reste idempotente.
    state.board.style.cursor = 'none'
    // Reset du flag move-all : sans ca un futur grabbing classique
    // heriterait du flag de la session precedente et snapperait le
    // delta comme en move-all (comportement buggue). Valeur
    // ecrasee au prochain beginGrabbing.
    state.moveAllActive = false
    persistState()
}

let resolveMouseMoveOnBoard = (e) => {
    let mouseScreen = {
        x : e.x - state.board.getBoundingClientRect().x,
        y : e.y - state.board.getBoundingClientRect().y
    }

    if(state.isSelectingBox) {
        state.selectionBoxCurrent = mouseScreen
        // Les deux coins sont en coords screen ; on les convertit en
        // coords model (avec zoom et viewCenter) puis on prend min/max
        // pour avoir le bounding box. La conversion passe par
        // screenToModel qui inverse Y (Y screen +bas = Y model +haut).
        let m1 = screenToModel(state.selectionBoxStart)
        let m2 = screenToModel(state.selectionBoxCurrent)
        let minXM = Math.min(m1.x, m2.x)
        let maxXM = Math.max(m1.x, m2.x)
        let minYM = Math.min(m1.y, m2.y)
        let maxYM = Math.max(m1.y, m2.y)

        // Ne selectionne QUE dans la forme active.
        let activeShapeRef = state.shapes[state.activeShapeIndex]
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
        state.selectedPoints = expanded    } else if(state.isPanning) {
        // Pan du viewCenter (clic-milieu + drag souris). Convention
        // "drag content" : le contenu suit le curseur.
        //   X : drag a droite (dx > 0) -> viewCenter.x *decroit* car
        //       origin_screen.x = center.x - viewCenter.x * zoom.
        //   Y : drag en bas (dy > 0) -> viewCenter.y *augmente* car
        //       origin_screen.y = center.y + viewCenter.y * zoom.
        // Le delta est divise par zoomLevel pour rendre le pan
        // homogene : 100 px screen -> 100 unites model a zoom 1,
        // 20 unites a zoom 5.
        let dx = mouseScreen.x - state.panStartMouse.x
        let dy = mouseScreen.y - state.panStartMouse.y
        state.ctx.viewCenter.x = state.panStartViewCenter.x - dx / state.ctx.zoomLevel
        state.ctx.viewCenter.y = state.panStartViewCenter.y + dy / state.ctx.zoomLevel
        drawBoard()
        if (state.lastMousePos) updateMouseHover(state.lastMousePos)
        updateZoomDisplay()
    } else if(grabbed()) {
        // Conversion screen -> model en tenant compte du zoom, puis
        // delta en coords model. Si on ne divisait pas par zoom, le
        // drag deplacerait les points en pixels screen au lieu de les
        // deplacer en unites model (ce qui correspond a l'attente
        // visuelle : drag de 10 model units = drag de 10*zoom pixels
        // screen, peu importe le zoom).
        let curModel = screenToModel(mouseScreen)
        let startModel = screenToModel(state.grabStartMouse)
        let dx = curModel.x - startModel.x
        let dy = curModel.y - startModel.y
        // Mode move-all + grille : on snap le DELTA (pas chaque
        // point), sinon le snap independant casserait l'uniformite
        // entre formes (un point a (0,0) et un autre a (1,0)
        // translate de dx=15 seraient rattaches a des cellules de
        // grille differentes -> deplacements relatifs incoherents).
        // Mode actif-only : on garde le snap par-point (coherent car
        // une seule forme).
        if (state.activeGrid && state.moveAllActive) {
            let snapped = snapToGrid({ x: dx, y: dy })
            dx = snapped.x
            dy = snapped.y
        }
        state.grabbedGroup.forEach(item => {
            let targetPos = { x: item.startX + dx, y: item.startY + dy }
            if(state.activeGrid && !state.moveAllActive) {
                targetPos = snapToGrid(targetPos)
            }
            // item.shapeIndex est toujours defini : par defaut egal a
            // state.activeShapeIndex (mode historique), ou sIndex de la
            // forme concernee en mode Alt. On n'utilise plus la
            // constante state.activeShapeIndex pour cibler la forme afin
            // de supporter l'iteration sur plusieurs formes en un
            // seul appel.
            let tri = state.shapes[item.shapeIndex].triangles[item.triangleIndex]
            if (!tri) return  // safety: la forme a pu changer
            tri[item.pointId] = targetPos
            if (item.selectedPointRef) {
                item.selectedPointRef.x = targetPos.x
                item.selectedPointRef.y = targetPos.y
            }
        })
    }

    state.lastMousePos = mouseScreen
    updateMouseHover(mouseScreen)
    // Fin de resolveMouseMoveOnBoard : centralise l'appel pour
    // couvrir toutes les branches qui mutent state.selectedPoints
    // (selection box du drag, etc). La mutation du drag-clic
    // (qui mute state.selectedPoints via state.grabbedGroup) ne change pas
    // la selection logique, donc on s'en passe la. Idempotent
    // avec les appels plus haut dans le flow drag.
    updateSelectionHud()
}

// Met a jour le hover (point le plus proche, dim de la selection, etc).
// Le curseur est dessine en screen. Le calcul du state.nearestPoint/Line
// se fait en coords model (Y inverse), restreint a la forme active.
let updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    let actionModel = screenToModel(cursorScreen)
    let target = state.activeGrid ? snapToGrid(actionModel) : actionModel
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

// Affiche la position du curseur et du point le plus proche dans le
// HUD en bas de l'ecran, en coords model (Y inverse, origine au centre).
// Vide le HUD si pas de curseur. Utilise textContent (pas innerText) pour
// eviter un reflow a chaque mousemove.
let updateCoordsDisplay = (cursorScreen) => {
    let div = document.querySelector('#coords')
    if (!div) return
    if (!cursorScreen) {
        div.textContent = ''
        return
    }
    let m = screenToModel(cursorScreen)
    let np = (state.nearestPoint && state.nearestPoint.point) ? state.nearestPoint.point : null
    let cursorTxt = `(${Math.round(m.x)}, ${Math.round(m.y)})`
    let nearestTxt = np ? `(${Math.round(np.x)}, ${Math.round(np.y)})` : '\u2014'
    div.textContent = `curseur ${cursorTxt}  plus proche ${nearestTxt}`
}

// Affiche le niveau de zoom + la position du viewCenter + la
// rotation de la scene dans le HUD bas-gauche (#zoomDisplay).
// Format compact : "1.2x pos(45, -30)" ; quand la scene est
// pivotee, on ajoute "  rot 45°" pour donner un feedback visuel
// immediat (sinon l'utilisateur n'a aucun moyen de savoir qu'il a
// fait tourner la scene si le coin haut-gauche revient pile au
// meme endroit apres rotation).
// Mise a jour appelee : initialisation, restauration d'etat
// (loadState), apres chaque tick de molette (pan, zoom, AltGr +
// scene rotation), apres Ctrl+0, et apres chaque commande qui
// modifie viewCenter (pan).
// textContent pour eviter un reflow.
let updateZoomDisplay = () => {
    let div = document.querySelector('#zoomDisplay')
    if (!div) return
    let vc = state.ctx.viewCenter
    let text = state.ctx.zoomLevel.toFixed(1) + 'x  pos(' +
        Math.round(vc.x) + ', ' + Math.round(vc.y) + ')'
    // Compteur de rotation cumulee (HUD-only). Affiche en
    // degres plutot qu'en radians (les utilisateurs pensent en
    // degres). Le caractere degre est U+00B0, distinct du 'o'.
    // Tour complet (= 360) ramene a 0 grace au modulo 2*PI
    // dans rotateEachShapeAroundPivot.
    if (state.ctx.rotationTracking !== 0) {
        let deg = Math.round(state.ctx.rotationTracking * 180 / Math.PI)
        text += '  rot ' + deg + '\u00b0'
    }
    div.textContent = text
    }

let resolveMouseClickOnBoard = (e) =>  {
    let mouseScreen = {
        x : e.x - state.board.getBoundingClientRect().x,
        y : e.y - state.board.getBoundingClientRect().y
    }
    let pointToAdd = snapToGrid(screenToModel(mouseScreen))
    addPoint(pointToAdd)
    drawBoard()
    drawMouse(mouseScreen)
}

let findNearestPoint = (point) => {
    return findNextNearestPoint({ point:point, triangleIndex:-1 })
}

let findNextNearestPoint = (nearestPoint) => {
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
    // `result` est declare ici (et non en tete de fonction) car il
    // n'est assigne qu'apres le calcul de shortIndex. Avant le
    // refactor ES6 modules, ce code s'executait en mode sloppy et
    // beneficiait de la creation implicite d'un global `result` ;
    // les modules ES sont strict par defaut, donc l'assignation
    // nue leve ReferenceError. Meme pattern que les autres vars
    // locales (shortIndex, shortDistance, etc.) declarees plus haut.
    let result = {
        triangleIndex:shortIndex,
        distance:shortDistance,
        pointIndex:shortPointIndex,
        triangle:trisRef[shortIndex],
        pointId:pointId,
        point:trisRef[shortIndex][pointId]
    }
    return result
} 

let findNearestLine = (point) => {
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

let findSelectedLine = (point) => {
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

// Ajoute un point uniquement dans la forme active. Le point est ajoute
// au dernier triangle en cours de construction, ou cree un nouveau
// triangle a partir de state.nearestLine si la forme en a deja 3 complets.
let addPoint = (point) => {
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
        // `triangle` est declare ici (et non dans la boucle for
        // au-dessus) car il est utilise APRES la fin de cette
        // boucle. Le `let triangle = tris[i]` dans la boucle
        // n'a qu'une portee de bloc (loop body), invisible ici.
        // Avant le refactor ES6 modules, l'assignation nue
        // beneficiait de la creation implicite d'un global en
        // mode sloppy ; les modules ES sont strict par defaut,
        // donc ReferenceError. Cf. fix similaire sur `result`
        // dans findNextNearestPoint.
        let triangle = tris.at(-1)
        if(triangle.p2===undefined) {
            triangle.p2 = point
        }
        else if(triangle.p3===undefined) {
            triangle.p3 = point
        }
        else {
            tris.push({
                p1:state.nearestLine.firstPoint,
                p2:state.nearestLine.secondPoint,
                p3:point
            })
        }
    }
    state.ctx.workIsSaved = 0;
    state.ctx.workIsBackuped = 0;
    persistState()
}

// Serialize l'etat complet en JSON. Consomme par loadState (boot
// restore depuis localStorage) ET par saveMesh (export fichier).
// Format FLAT (pas de wrapping `state.X` malgre le bulk rename du
// refactor ES6 qui en avait ajoute dans loadState — meme pattern
// que le bug `entry.state.X` sur undo/redo).
//
// Champs inclus :
//   - scene : shapes + activeShapeIndex (couple inseparable)
//   - grille : activeGrid + GRID_STEP
//   - camera : zoomLevel + viewCenter
// Champs NON emis (mais lus conditionnellement par loadState si
// presents) :
//   - rotation + rotationPivot : LEGACY, emis par l'ancien code
//     viewport-rotation. Le code actuel integre la rotation dans
//     les vertices donc on n'emet rien — loadState.skip
//     silencieusement s'ils sont absents. Une scene chargee
//     avec ces champs (migration depuis un ancien format) reste
//     supportee a la lecture.
// Convertit state.shapes (triangles avec refs de points partagees)
// vers le format mesh consumable par buildShapesFromPayload :
// chaque forme devient {pointList, tris} ou pointList est la liste
// de points uniques (deduplicated par coords) et tris.p1/p2/p3 sont
// des INDICES dans pointList. Necessaire pour que loadState ->
// buildShapesFromPayload puisse reconstruire state.shapes
// correctement : bug latent du commit e8e2775 (serializeState
// ecrivait state.shapes directement, mais buildShapesFromPayload
// attend le format mesh, donc les formes ne s'affichaient pas au
// reload). Meme format utilise par le file-import
// (importMeshFromText -> buildShapesFromPayload), donc saveMesh
// produit aussi un fichier coherent avec le format d'import.
let shapeToMesh = (shape) => {
    let pointMap = new Map()
    let pointList = []
    let tris = []
    shape.triangles.forEach(t => {
        let indices = { p1: undefined, p2: undefined, p3: undefined }
        ['p1', 'p2', 'p3'].forEach(pid => {
            let p = t[pid]
            if (!p) return
            let key = p.x + ',' + p.y
            if (!pointMap.has(key)) {
                pointMap.set(key, pointList.length)
                pointList.push({ x: p.x, y: p.y })
            }
            indices[pid] = pointMap.get(key)
        })
        tris.push({ p1: indices.p1, p2: indices.p2, p3: indices.p3 })
    })
    return { pointList, tris }
}

let serializeState = () => {
    return JSON.stringify({
        activeGrid: state.activeGrid,
        GRID_STEP: state.GRID_STEP,
        shapes: state.shapes.map(shapeToMesh),
        activeShapeIndex: state.activeShapeIndex,
        zoomLevel: state.ctx.zoomLevel,
        viewCenter: { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y }
    })
}

let persistState = () => {
    clearTimeout(state.persistTimer)
    state.persistTimer = setTimeout(() => {
        try {
            localStorage.setItem(SCENE_STORAGE_KEY, serializeState())
            state.ctx.workIsSaved = 1
        } catch (e) {
            log('Persist fail: ' + e.message)
        }
    }, 150)
}

// Reconstruit un tableau de formes a partir d'un payload JSON.
// Accepte les deux formats :
//   - nouveau : { shapes: [{ tris, pointList }, ...], state.activeShapeIndex }
//   - ancien (compat) : { tris, pointList, state.activeShapeIndex }
// Helper interne : convertit un tableau de tris en [{p1,p2,p3}] resolus
// contre pts. Utilise par les 3 branches de buildShapesFromPayload
// (mesh format, migration state.shapes, legacy single-mesh) pour eviter
// la duplication du pattern "3 lignes de nt.pX conditionnel" dans
// chaque branche. DRY : un seul endroit pour faire evoluer la
// resolution (ajout de tolerance, support de nouveaux slots...).
// Retourne [] si trisArray n'est pas un tableau (defensif : un mesh
// sans tris donne un shape vide, ce qui preservait l'ancien
// comportement des 3 branches avant le DRY).
let resolveTrisToTriangles = (trisArray, pts) => {
    let ts = []
    if (!Array.isArray(trisArray)) return ts
    trisArray.forEach(t => {
        let nt = {}
        if (t.p1 !== undefined && pts[t.p1]) nt.p1 = pts[t.p1]
        if (t.p2 !== undefined && pts[t.p2]) nt.p2 = pts[t.p2]
        if (t.p3 !== undefined && pts[t.p3]) nt.p3 = pts[t.p3]
        ts.push(nt)
    })
    return ts
}

let buildShapesFromPayload = (data) => {
    if (!data || typeof data !== 'object') return null
    let result = []
    if (Array.isArray(data.shapes)) {
        data.shapes.forEach(shape => {
            let pts = []
            let trisSource = undefined
            if (Array.isArray(shape.pointList)) {
                // Format mesh (ecrit par le nouveau serializeState) :
                // pointList contient les coords brutes, tris contient
                // des indices dans pointList.
                pts = shape.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = shape.tris
            } else if (Array.isArray(shape.triangles)) {
                // ANCIEN format state.shapes natif (ecrit par les versions
                // buggees d'avant le commit de fix : serializeState
                // serialisait directement cloneScene(state.shapes)).
                // triangles[i].p1|p2|p3 etaient des REFERENCES d'objets
                // points. Sans cette branche, les utilisateurs avec un
                // localStorage ecrit en v1 voient des formes vides au
                // reload (rien ne matche le format mesh). On convertit
                // via shapeToMesh pour reutiliser le meme chemin de
                // sortie (pointList dedup + indices).
                let mesh = shapeToMesh(shape)
                pts = (mesh.pointList || []).map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = mesh.tris
            }
            result.push({ triangles: resolveTrisToTriangles(trisSource, pts) })
        })
    } else {
        // Legacy single-mesh format (avant le split : la scene etait
        // un seul {pointList, tris}, pas un tableau de formes).
        let pts = []
        if (Array.isArray(data.pointList)) {
            pts = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        result.push({ triangles: resolveTrisToTriangles(data.tris, pts) })
    }
    if (result.length === 0) result = [{ triangles: [] }]
    return result
}

let loadState = () => {
    let saved = localStorage.getItem(SCENE_STORAGE_KEY)
    if (!saved) return
    try {
        // Reset de state.pendingRotation au demarrage du try block,
        // avant parsing. Sans ca, si une exception survient
        // apres que state.pendingRotation ait ete set (cf. plus bas)
        // et que buildShapesFromPayload jette, le state reste
        // pollue et un futur applyImport appliquerait la
        // rotation stale silencieusement (applyImport ne
        // reparse pas data.rotation, il appelle juste
        // applyPendingRotationToShapes).
        state.pendingRotation = undefined
        let data = JSON.parse(saved)
        if (data.activeGrid !== undefined) state.activeGrid = !!data.activeGrid
        if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        }
        // Zoom et viewCenter : on les restaure avec le meme clamp que
        // la wheel handler (bornes identiques cote MIN/MAX).
        if (typeof data.zoomLevel === 'number' && data.zoomLevel > 0) {
            state.ctx.zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, data.zoomLevel))
        }
        if (data.viewCenter && typeof data.viewCenter.x === 'number' && typeof data.viewCenter.y === 'number') {
            state.ctx.viewCenter.x = data.viewCenter.x
            state.ctx.viewCenter.y = data.viewCenter.y
        }
        // Migration LEGACY : les scenes sauvegardees avec l'ancien
        // code viewport-rotation contiennent data.rotation (radians)
        // et data.rotationPivot (coords modele depuis le passage
        // precedent, ou screen pixels avant ca). Avec le nouveau
        // code, la rotation n'est plus un etat de viewport mais
        // integree aux vertices ; on "applique" donc la rotation
        // sauvegardee aux vertices de chaque forme chargee une
        // bonne fois. Pivot par defaut si absent : origine modele
        // (0, 0). Cas absents / non-finis : on ignore la rotation
        // sauvegardee (= scene chargee telle qu'elle).
        if (typeof data.rotation === 'number' && Number.isFinite(data.rotation) && data.rotation !== 0) {
            let r = data.rotation % TAU
            if (r < 0) r += TAU
            let pivot = { x: 0, y: 0 }
            if (data.rotationPivot && typeof data.rotationPivot.x === 'number' && typeof data.rotationPivot.y === 'number' && Number.isFinite(data.rotationPivot.x) && Number.isFinite(data.rotationPivot.y)) {
                if (data.rotationPivot.kind === 'model') {
                    pivot.x = data.rotationPivot.x
                    pivot.y = data.rotationPivot.y
                } else {
                    // Ancien format screen : conversion via camera
                    // transform inverse (meme logique que la
                    // precedente migration screen -> model).
                    pivot.x = state.ctx.viewCenter.x + (data.rotationPivot.x - state.ctx.center.x) / state.ctx.zoomLevel
                    pivot.y = state.ctx.viewCenter.y - (data.rotationPivot.y - state.ctx.center.y) / state.ctx.zoomLevel
                }
            }
            // Migration deferred : on ne peut pas tourner les
            // vertices ici car state.shapes n'est pas encore charge.
            // On flag et on applique apres buildShapesFromPayload.
            state.pendingRotation = { angle: r, pivot: pivot }
        } else {
            state.pendingRotation = undefined
        }
        // Mise a jour du HUD zoom apres restauration (sinon l'indicateur
        // reste a la valeur par defaut affichee dans le HTML initial).
        updateZoomDisplay()
        let loaded = buildShapesFromPayload(data)
        if (loaded) {
            state.shapes = loaded
            if (typeof data.activeShapeIndex === 'number' && data.activeShapeIndex >= 0 && data.activeShapeIndex < state.shapes.length) {
                state.activeShapeIndex = data.activeShapeIndex
            } else {
                state.activeShapeIndex = 0
            }
            // Migration LEGACY : applique la rotation sauvegardee
            // (vue avec l'ancien code viewport-rotation) aux
            // vertices. Voir state.pendingRotation plus haut + helper
            // applyPendingRotationToShapes.
            applyPendingRotationToShapes(state.shapes)
        }
        state.ctx.workIsSaved = 1
        updateGridButtonText()
        updateShapeHud()
    } catch (e) {
        // Reset de pendingRotation : si le parsing a deja
        // assigne une rotation et que buildShapesFromPayload
        // a jete apres, on ne veut pas qu'un futur
        // applyImport (qui ne reparse pas) l'applique
        // silencieusement. Belt-and-braces avec le reset en
        // debut de try.
        state.pendingRotation = undefined
        log('Load fail: ' + e.message)
    }
    // Defense en profondeur : saveState/undo/redo couvrent les
    // mutations explicites des piles, applyImport.resetEphemeralState
    // et resetAll couvrent les wipes. Si loadState pousse oucleared
    // les piles par un chemin non couvert (futur refactor), le
    // HUD compteur se synchronise au moins a la fin du load
    // plutot que d'attendre la prochaine mutation. Idempotent
    // avec l'appel en fin de doit() au boot.
    updateUndoRedoHud()
}

window.addEventListener('beforeunload', () => {
    clearTimeout(state.persistTimer)
    try {
        localStorage.setItem(SCENE_STORAGE_KEY, serializeState())
    } catch (e) {}
})

let saveMesh = () => {
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

let importMeshFromText = (text) => {
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
    let currentTriCount = state.shapes.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let importedTriCount = loaded.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let currentInfo = state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + currentTriCount + ' triangle' + (currentTriCount > 1 ? 's' : '')
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
// IMPORT_MODE_STORAGE_KEY is imported from constants.js (mesh-designer-import-mode)
// Lit la preference. Renvoie 'replace' ou 'merge' ou null si absente/invalide.
let getStoredImportMode = () => {
    try {
        let v = localStorage.getItem(IMPORT_MODE_STORAGE_KEY)
        return v === 'replace' || v === 'merge' ? v : null
    } catch (e) {
        return null
    }
}

// Persiste la preference. Les erreurs (quota, etc) sont ignorees pour
// ne JAMAIS bloquer l'import.
let saveStoredImportMode = (mode) => {
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
let showImportModal = (opts, callback) => {
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
// (reset d'etat ephemere, mutation de state.shapes, persist, redraw).
let applyImport = (parsed, loaded, mode) => {
    let resetEphemeralState = () => {
        state.historyStack = []
        state.redoStack = []
        state.selectedPoints = []
        state.nearestPoint = undefined
        state.nearestLine = undefined
        state.grabbedGroup = []
        state.currentAction = undefined
        state.isSelectingBox = false
        state.selectionBoxStart = undefined
        state.selectionBoxCurrent = undefined
        clearTimeout(state.wheelRotateTimer)
        state.wheelRotateTimer = undefined
        state.isWheelRotating = false
        // Import = wipe des piles avant reconstitution de la
        // scene ; le HUD doit refleter etat vide immediatement,
        // sans attendre une eventuelle prochaine mutation.
        updateUndoRedoHud()
        // Wipe de la selection avant reconstitution -> pilule a 0.
        updateSelectionHud()
    }

    if (mode === 'merge') {
        let beforeCount = state.shapes.length
        if (parsed.state.activeGrid !== undefined) state.activeGrid = !!parsed.state.activeGrid
        if (parsed.state.GRID_STEP !== undefined && typeof parsed.state.GRID_STEP === 'number') {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.state.GRID_STEP))
        }
        loaded.forEach(s => state.shapes.push(s))
        // Migration LEGACY : la rotation viewport sauvegardee dans
        // le fichier importe est appliquee aux nouvelles formes
        // ajoutees (loaded), pas aux anciennes (shapes).
        applyPendingRotationToShapes(loaded)
        state.activeShapeIndex = beforeCount
        if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
            state.activeShapeIndex = Math.max(0, state.shapes.length - 1)
        }
        resetEphemeralState()
        persistState()
        updateGridButtonText()
        updateShapeHud()
        drawBoard()
        let totalTris = state.shapes.reduce((acc, s) => acc + s.triangles.length, 0)
        log('Import merge OK: +' + loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + state.shapes.length + ' au total, ' + totalTris + ' triangles')
        return true
    }

    // Replace mode
    state.shapes = loaded
    // Migration LEGACY : rotation viewport du fichier importe,
    // appliquee aux vertices de toutes les nouvelles formes.
    applyPendingRotationToShapes(state.shapes)
    if (typeof parsed.state.activeShapeIndex === 'number' && parsed.state.activeShapeIndex >= 0 && parsed.state.activeShapeIndex < state.shapes.length) {
        state.activeShapeIndex = parsed.state.activeShapeIndex
    } else {
        state.activeShapeIndex = 0
    }
    if (parsed.state.activeGrid !== undefined) state.activeGrid = !!parsed.state.activeGrid
    if (parsed.state.GRID_STEP !== undefined && typeof parsed.state.GRID_STEP === 'number') {
        state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.state.GRID_STEP))
    }
    resetEphemeralState()
    persistState()
    updateGridButtonText()
    updateShapeHud()
    drawBoard()
    let totalTris = state.shapes.reduce((acc, s) => acc + s.triangles.length, 0)
    log('Import OK: ' + state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + totalTris + ' triangle' + (totalTris > 1 ? 's' : ''))
    return true
}

let importMeshFromFile = (file) => {
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

let resetAll = () => {
    state.shapes = [{ triangles: [] }]
    state.activeShapeIndex = 0
    state.selectedPoints = []
    state.historyStack = []
    state.redoStack = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.grabbedGroup = []
    state.currentAction = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    // Reset complet du viewport (zoom + pan). La rotation de
    // scene n'a plus d'etat propre : les vertices des formes
    // (qui sont vides apres ce reset) portent zero orientation
    // cumulee.
    state.ctx.zoomLevel = 1
    state.ctx.viewCenter.x = 0
    state.ctx.viewCenter.y = 0
    // Compteur de rotation : reset avec la scene vide.
    state.ctx.rotationTracking = 0
    persistState()
    drawBoard()
    updateZoomDisplay()
    updateShapeHud()
    updateUndoRedoHud()
    // Selection videe par resetAll -> pilule a 0.
    updateSelectionHud()
    log('Reset OK')
}

let doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
    updateZoomDisplay()
    // Premier appel au HUD undo/redo : initialise le compteur a
    // (0) et grise les boutons tant que la scene restauree n'a
    // pas une premiere entree dans state.historyStack. Meme pattern
    // que updateShapeHud() qui se cale en fin de boot.
    updateUndoRedoHud()
    // Initialise aussi la pilule de selection au boot. Si
    // loadState a restaure une scene avec selection non vide
    // (cas rare : non persiste, mais defense en profondeur),
    // on reflette l'etat reel plutot que le "0" du HTML par defaut.
    updateSelectionHud()
}

// Boot : appele en bas de main.js (module differe via type="module").
doit()
