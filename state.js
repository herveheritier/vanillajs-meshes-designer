// Rationale : voir DESIGN.md §1.1

import { DEFAULT_GRID_STEP } from './constants.js'

export const state = {
    // ===== Scene / viewport =====
    shapes: [{ triangles: [] }],
    activeShapeIndex: 0,

    ctx: {
        center: { x: 50, y: 50 },
        viewCenter: { x: 0, y: 0 },
        zoomLevel: 1,
        rotationTracking: 0,
    },

    GRID_STEP: DEFAULT_GRID_STEP,

    // ===== Mouse / hover state =====
    nearestLine: undefined,
    nearestPoint: undefined,
    nearestTriangle: undefined,
    lastMousePos: undefined,
    currentAction: undefined,
    grabbedPoint: [],
    relativeGrabbingPosition: undefined,
    activeGrid: false,

    // ===== Reticule mode =====
    reticleMode: 0,

    // ===== Interaction modes =====
    editingMode: 'edition',
    selectionMode: 'vertex',
    sceneDirty: false,

    // ===== Selection / box =====
    selectedPoints: [],
    selectedTriangles: [],
    isTriangleColorPanelOpen: false,
    isSelectingBox: false,
    selectionBoxStart: undefined,
    selectionBoxCurrent: undefined,
    grabbedGroup: [],
    grabStartMouse: undefined,

    // ===== Move-all (AltGr grab) =====
    moveAllActive: false,

    // ===== Pan (clic-milieu drag) =====
    isPanning: false,
    panStartMouse: undefined,
    panStartViewCenter: undefined,

    // ===== History (undo/redo) =====
    historyStack: [],
    redoStack: [],

    // ===== Persist debounce timer =====
    persistTimer: undefined,

    // ===== Wheel rotations timers =====
    isWheelRotating: false,
    wheelRotateTimer: undefined,
    isEachShapeRotating: false,
    eachShapeRotateTimer: undefined,

    altGrRotationPivot: undefined,

    isSelectionDimmed: false,

    // ===== Pending legacy rotation (migration loadState) =====
    pendingRotation: undefined,

    // ===== Console UI =====
    consoleVisible: true,
    consoleMoving: false,
    consoleResizing: false,
    consoleDragStart: null,

    // ===== Modal focus restoration =====
    lastFocusedElement: undefined,

    // ===== DOM refs (queries faites au boot depuis main.js) =====
    board: undefined,
    body: undefined,
    messageBoard: undefined,
    messageLog: undefined,
}

export const initDomRefs = () => {
    if (typeof document === 'undefined') return
    state.board = document.querySelector('#board')
    state.body = document.querySelector('body')
    state.messageBoard = document.querySelector('#messageBoard')
    state.messageLog = document.querySelector('#messageLog')
}
