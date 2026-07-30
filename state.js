// Module state.js : encapsule TOUT l'etat mutable de l'application
// dans un objet unique exporte. Pourquoi un objet plutot que des
// `let` exports ?
//
//   - Les bindings ES module sont read-only pour les importers.
//     `import { shapes } from './state.js'` ne permet PAS
//     `shapes = []` chez l'importer ; il faut passer par state.shapes
//     = [] (qui fonctionne, c'est une mutation de propriete, pas
//     une reassignation de binding).
//   - Un objet unique permet de regrouper l'etat sous une seule
//     reference documentee. Les modules dependents importent
//     `state` une fois et accedent aux sous-proprietes
//     (`state.shapes`, `state.ctx`, etc.).
//   - Tree-shaking : pas de pluralite de `let` top-level qui se
//     promeneraient. Une seule entite.
//
// Note sur le wrapping : a la migration, on transforme chaque
// `let foo = ...` en `state.foo = ...`. Les references `foo`
// deviennent `state.foo`. Sed bulk replace dans main.js.
//
// Note sur les imports circulaires : state.js n'importe RIEN
// d'autre (pure source de verite). Cela evite les cycles et les
// surprises d'ordre d'initialisation.

import { DEFAULT_GRID_STEP } from './constants.js'

export const state = {
    // ===== Scene / viewport =====
    // Scene = liste de formes ; SEULE la forme indexee par
    // activeShapeIndex est editable. shapes[].triangles contient
    // des triangless avec points partages entre triangles d'une
    // meme forme (mais JAMAIS entre formes).
    shapes: [{ triangles: [] }],
    activeShapeIndex: 0,

    // ctx = camera transform (zoom + viewCenter). center est en
    // pixels board (mis a jour apres resize), viewCenter en
    // coords modele (le point du modele qui apparait au centre
    // du board).
    ctx: {
        center: { x: 50, y: 50 },
        viewCenter: { x: 0, y: 0 },
        zoomLevel: 1,
        // rotationTracking : compteur HUD-only (somme cumulee des
        // angles appliques par rotateEachShapeAroundPivot). PAS
        // persiste en localStorage (l'orientation est dans les
        // vertices ; sur reload, le HUD repart a 0 meme si la
        // scene avait ete pivotee). PAS dans le undo/redo
        // (limitation mineure).
        rotationTracking: 0,
    },

    // Pas de la grille : mutable, persiste en localStorage.
    // Initialement DEFAULT_GRID_STEP, ajuste a la volee par
    // wheel/auxclick sur le bouton #grid.
    GRID_STEP: DEFAULT_GRID_STEP,

    // ===== Mouse / hover state =====
    nearestLine: undefined,
    nearestPoint: undefined,
    // nearestTriangle : mis a jour a chaque mousemove (cf.
    // updateMouseHover) en mode 'triangle'. Meme lifecycle que
    // nearestPoint/nearestLine. Indique le triangle sous le
    // curseur (point-in-polygon) pour highlight + selection.
    // Indetermine hors mode triangle mais calcule out-of-the-box
    // (cout O(n) negligeable) pour eviter une course conditionnelle
    // a chaque changement de mode via le bouton toolbar.
    nearestTriangle: undefined,
    lastMousePos: undefined,
    currentAction: undefined, // = ACTION_NONE au boot (= undefined)
    grabbedPoint: [],
    relativeGrabbingPosition: undefined,
    activeGrid: false,

    // ===== Reticule mode =====
    // 0 = off, 1 = simple, 2 = symetrique.
    reticleMode: 0,

    // ===== Selection mode =====
    // Definit ce qu'un clic court (mouseup dist < 5 px) selectionne
    // sur le board. Cyclique via le bouton #selectionMode.
    //   - 'vertex'   : clic sur un sommet (dist < 15 unites modele)
    //                   selectionne le(s) sommet(s) au meme endroit ;
    //                   clic en espace vide cree un point ou vide la
    //                   selection. = comportement historique.
    //   - 'segment'  : clic sur un edge d'un triangle (point projecte
    //                   entre les 2 sommets) selectionne les 2
    //                   extremites du segment ; clic sur un sommet
    //                   retombe sur le comportement vertex. Sinon
    //                   identique au mode vertex.
    //   - 'triangle' : clic a L'INTERIEUR d'un triangle selectionne
    //                   ses 3 sommets. Sinon retombe sur le
    //                   comportement vertex (clic en espace vide).
    // Toutes les operations (drag, grab, delete, merge, rotate,
    // box-drag) operent sur state.selectedPoints (refs de points),
    // donc le mode ne change QUE la facon dont un clic enrichit
    // selectedPoints ; rien d'autre a modifier.
    selectionMode: 'vertex',

    // ===== Selection / box =====
    selectedPoints: [],
    // selectedTriangles : INDICES (dans la forme active) des
    // triangles selectionnes en mode 'triangle'. Maintient
    // une vue O(1) sur "quels triangles sont selectionnes"
    // pour applyColorToSelectedTriangles : on itere
    // directement sur les indices au lieu de re-scanner les
    // 3-slots-pour-3 match de selectedPoints a chaque fois.
    // Le tableau est reinitialise quand la selection de
    // POINTS est videe (Cf. clearEditingTransientState dans
    // history.js, goToShape, toggleSelectionMode, et resetAll).
    selectedTriangles: [],
    // isTriangleColorPanelOpen : etat du panneau flottant de
    // coloration, ouverts/ferme par le bouton #triangleColor.
    // Etat ephemere (pas persiste en localStorage), comme les
    // autres overlays drag/resize.
    isTriangleColorPanelOpen: false,
    isSelectingBox: false,
    selectionBoxStart: undefined,
    selectionBoxCurrent: undefined,
    grabbedGroup: [],
    grabStartMouse: undefined,

    // ===== Move-all (AltGr grab) =====
    // Set dans beginGrabbing a !!(e.ctrlKey && e.altKey). Voir
    // comments originaux dans main.js pour les details AltGr.
    moveAllActive: false,

    // ===== Pan (clic-milieu drag) =====
    isPanning: false,
    panStartMouse: undefined,
    panStartViewCenter: undefined,

    // ===== History (undo/redo) =====
    historyStack: [],
    redoStack: [],

    // ===== Persist debounce timer =====
    // setTimeout ID pour la persistance localStorage debounced (cf.
    // persistState dans main.js). Annule au rechargement
    // (beforeunload) pour eviter un flush partiel du state
    // serialize au milieu d'une frame.
    persistTimer: undefined,

    // ===== Wheel rotations timers =====
    isWheelRotating: false,
    wheelRotateTimer: undefined,
    isEachShapeRotating: false,
    eachShapeRotateTimer: undefined,

    // Pivot de rotation AltGr en coords modele (cf. wheel handler
    // dans main.js). Re-evalue a chaque tick depuis
    // screenToModel(cursorScreen). Defini uniquement pendant une
    // gesture AltGlr.
    altGrRotationPivot: undefined,

    // Selection dimmed : pendant une rotation par molette de
    // points selectionnes, on attenue la couleur de selection
    // pour signaler que la rotation mute la geometrie. Voir
    // drawSelectedPoints.
    isSelectionDimmed: false,

    // ===== Pending legacy rotation (migration loadState) =====
    // Si la scene chargee avait ete sauvegardee avec l'ancien
    // code viewport-rotation, on y trouve data.rotation +
    // data.rotationPivot ; on les stocke ici et on les applique
    // apres buildShapesFromPayload. Remis a undefined quand
    // applique.
    pendingRotation: undefined,

    // ===== Console UI =====
    consoleVisible: true,
    consoleMoving: false,
    consoleResizing: false,
    consoleDragStart: null,

    // ===== DOM refs (queries faites au boot depuis main.js) =====
    // Non mutables apres init ; exposes ici pour que les autres
    // modules (draw.js, hud.js, etc.) puissent y acceder sans
    // avoir a refaire les queries. Si l'element manque dans le
    // DOM (ancien HTML, tests headless), la valeur reste
    // undefined et chaque callsite fait son check defensif.
    board: undefined,
    body: undefined,
    messageBoard: undefined,
    messageLog: undefined,
}

// Helper exporte pour initialiser les refs DOM au boot (depuis
// main.js). Mutation directe de state.* toleree ici (state est
// l'objet autorite, on l'initialise une seule fois au boot).
export const initDomRefs = () => {
    if (typeof document === 'undefined') return
    state.board = document.querySelector('#board')
    state.body = document.querySelector('body')
    state.messageBoard = document.querySelector('#messageBoard')
    state.messageLog = document.querySelector('#messageLog')
}
