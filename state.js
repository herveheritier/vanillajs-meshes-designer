// Rationale : voir DESIGN.md §1.1

import { DEFAULT_GRID_STEP } from './constants.js'

export const state = {
    // ===== Scene / viewport =====
    shapes: [{ pointList: [], tris: [] }],
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

    // ===== Scene baseline (dirty reconciliation) =====
    // Fingerprint JSON de `state.shapes` capture a chaque evenement
    // qui pose un nouvel etat de reference propre :
    //   - saveMesh (post-export) : baseline = la scene qui vient
    //     d'etre serialisee en fichier.
    //   - applyImport REPLACE/MERGE (post-load) : baseline = la
    //     scene qui vient d'etre importee (= le fichier source).
    //   - loadState (post-restore) : baseline = la scene restauree
    //     depuis localStorage (= dernier save connu).
    //   - resetAll (post-wipe) : baseline = scene vide.
    // La valeur est un string (JSON.stringify) pour comparaison O(1)
    // dans history.undo / history.redo via recomputeSceneDirty
    // (io.js). Default vide : captureSceneBaseline est invoque au
    // boot par loadState() ou, en absence de sauvegarde, applique
    // l'etat vide (forme vide indexe [{ pointList: [], tris: [] }]).
    // Maintient invariant : sceneDirty = true <=> state.shapes
    // diverge de la baseline (= une mutation utilisateur non
    // annulee ni sauvegardee s'est produite depuis le dernier
    // evenement « clean »).
    sceneBaselineFingerprint: '',

    // ===== Scene name =====
    // Nom logique de la scene affiche dans #sceneStatus (hud.js
    // updateSceneStatus). Trois sources possibles :
    //   - nom de fichier a l'import (mesh-wail.json -> 'mesh-wail',
    //     extension strippee via replace(/\.[^.]+$/, ''))
    //   - default 'nouvelleScene' au boot frais, apres
    //     resetAll, ou quand un fichier n'a pas de nom exploitable
    //     (autoImportMeshesFromUrl, fichiers importes sans nom)
    //   - persiste a travers les reloads via le wire format
    //     (io.js serializeState inclut 'name', loadState le
    //     restaure ; anciens fichiers sans 'name' retombent sur le
    //     default)
    // En mode MERGE, le nom existant est preserve (les formes
    // ajoutees ne renommment pas la scene — seul l'import REPLACE
    // adopte le nom du fichier source).
    sceneName: 'nouvelleScene',

    // ===== Selection / box =====
    selectedPoints: [],
    selectedTriangles: [],
    isTriangleColorPanelOpen: false,
    isSelectingBox: false,
    selectionBoxStart: undefined,
    selectionBoxCurrent: undefined,
    grabbedGroup: [],
    grabStartMouse: undefined,
    grabHistorySaved: false,
    hasDragged: false,
    activeConstructionTriangle: undefined,

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

    // ===== FPS HUD =====
    fpsVisible: false,

    // ===== Preview (mode visualisation seule) =====
    // Vue transitoire de focus : masque les points de contrôle, axes,
    // grille, HUD et boutons pour ne laisser que la géométrie. Non
    // persistée en localStorage (cf. viewport.js togglePreview) : au
    // reload, on retombe toujours sur l'état d'édition par défaut.
    previewMode: false,

    // ===== Render time instrumentation (gate) =====
    // Flag dev pour activer console.time('renderScene')/timeEnd dans
    // renderSceneToOffscreen (cf. draw.js). Default false pour eviter
    // la pollution devtools en prod. Activation runtime depuis la
    // console navigateur : `state.debugRenderTime = true`. Voir
    // DESIGN.md §2.5.5 pour le protocole de capture.
    debugRenderTime: false,

    // ===== Modal focus restoration =====
    lastFocusedElement: undefined,

    // ===== Pending deferred history patches (delta storage §8) =====
    // Patch "en attente" dont le slot `after` sera rempli depuis
    // le live state à la fin du geste (mouseup pour grab, fin de
    // debounce pour rotation). Cf. history.js resolveDeferredAfter.
    _pendingGrabPatch: null,
    _pendingEachShapeRotatePatch: null,
    _pendingSelectedRotatePatch: null,

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
