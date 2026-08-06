import { DEFAULT_GRID_STEP, CIRCLE_DEFAULT_SEGMENTS, SHAPE_STAR_INNER_RATIO, ANNULUS_INNER_RATIO_DEFAULT, TRIANGLE_COLOR_PRESETS, TRIANGLE_COLOR_DEFAULT_ALPHA, MERGE_DROP_RADIUS_DEFAULT_PX } from './constants.js'

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

    // ===== Outil cercle =====
    // Mode transitoire (non persiste, comme la preview) : 1er clic = centre,
    // mouvement = rayon + angle, 2e clic = valider. circleCenterModel defini
    // = geste en cours (le prochain clic valide au lieu de reinitialiser).
    circleMode: false,
    circleCenterModel: undefined,
    circleRadiusModel: 0,
    circleOffsetAngle: 0,
    // Nombre de cotes du polygone, reglable a la molette, persiste.
    circleSegments: CIRCLE_DEFAULT_SEGMENTS,

    // ===== Outil étoile (creation en 3 clics) =====
    // 1er clic = centre, 2e = verrouille rayon + angle (starPhase -> 1) et
    // regle la profondeur des branches (starInnerRatio), 3e = valide.
    starMode: false,
    starCenterModel: undefined,
    starRadiusModel: 0,
    starOffsetAngle: 0,
    starPhase: 0,
    starInnerRatio: SHAPE_STAR_INNER_RATIO,

    // ===== Outil anneau (cercle perçé d'un trou, 3 clics) =====
    // Meme geste que l'etoile ; le 2e clic verrouille le rayon externe et
    // le 3e regle le trou (annulusInnerRatio, ratio interne / externe).
    annulusMode: false,
    annulusCenterModel: undefined,
    annulusOuterRadiusModel: 0,
    annulusOffsetAngle: 0,
    annulusPhase: 0,
    annulusInnerRatio: ANNULUS_INNER_RATIO_DEFAULT,

    // ===== Formes prédéfinies (panneau #shapes) =====
    shapesPanelOpen: false,

    // ===== Alignement / répartition des points sélectionnés =====
    alignPanelOpen: false,
    // Outil de forme armé : shapeKind = cle du catalogue SHAPE_DEFS ;
    // shapeAnchorModel = 1er coin (rect/square) ou centre (polygones),
    // shapeRadiusModel = rayon. Desarme apres la creation ou via Echap.
    shapeKind: undefined,
    shapeAnchorModel: undefined,
    shapeCurrentModel: undefined,
    shapeRadiusModel: 0,
    // Orientation par souris des polygones reguliers : angle du sommet 0.
    shapeOffsetAngle: 0,

    // ===== Scene baseline (dirty reconciliation) =====
    // Fingerprint JSON de state.shapes pose a chaque evenement « propre »
    // (saveMesh, import, loadState, resetAll) ; invariant : sceneDirty = true
    // <=> state.shapes diverge de la baseline.
    sceneBaselineFingerprint: '',

    // ===== Scene name =====
    // Nom affiche dans #sceneStatus : nom de fichier a l'import (extension
    // strippee), 'nouvelleScene' par defaut, persiste via le wire format.
    // En mode MERGE, le nom existant est conserve.
    sceneName: 'nouvelleScene',

    // ===== Palette de couleurs (#triangleColor) =====
    // isTriangleColorPanelOpen : panneau deploye (independant de brushMode).
    // brushMode / brushColor : non persistes ; le pinceau est arme a
    // l'ouverture du panneau (1er preset actif), desarme a la fermeture
    // (Escape / clic exterieur) ou au Reset (panneau reste ouvert).
    isTriangleColorPanelOpen: false,
    brushMode: false,
    brushColor: undefined,
    // Palette = PREFERENCE persistee : tableau {bg, fill} initie aux presets,
    // restaure au boot, re-ecrit a chaque mutation ; fill TOUJOURS derive de
    // (bg, colorAlpha) par triangleFillFromBg. colorPaletteEditingIndex =
    // swatch en cours d'edition (double-clic), EditingBefore = bg d'origine
    // pour annuler (Echap).
    colorPalette: TRIANGLE_COLOR_PRESETS.map(p => ({ bg: p.bg, fill: p.fill })),
    colorPaletteEditingIndex: undefined,
    colorPaletteEditingBefore: undefined,
    // Opacite de travail [0,1] appliquee a chaque peinture ; la valeur
    // persistee n'est mise a jour QUE par un reglage MANUEL du curseur.
    colorAlpha: TRIANGLE_COLOR_DEFAULT_ALPHA,

    // ===== Selection / box =====
    selectedPoints: [],
    selectedTriangles: [],
    isSelectingBox: false,
    selectionBoxStart: undefined,
    selectionBoxCurrent: undefined,
    grabbedGroup: [],
    grabStartMouse: undefined,
    grabHistorySaved: false,
    hasDragged: false,
    activeConstructionTriangle: undefined,
    // Fusion par deplacement (2e fonction de #mergePoints) : mode arme quand
    // exactement 1 point est selectionne ; mergeDropCandidate = point cible
    // le plus proche pendant le drag (undefined si aucun dans la limite),
    // consomme au relachement (attemptDropMerge).
    mergeOnDropActive: false,
    // Sous-etat verrouille (2e clic sur le bouton arme) : apres une fusion
    // reussie, le mode RESTE arme pour enchaner. Transitoire, n'est vrai que
    // si mergeOnDropActive.
    mergeOnDropLocked: false,
    mergeDropCandidate: undefined,
    // Rayon courant (px ecran) de la fusion par deplacement, regle a la
    // molette, preference de session persistee (meme statut que circleSegments).
    mergeDropRadius: MERGE_DROP_RADIUS_DEFAULT_PX,

    // ===== Presse-papiers interne (couper / copier / coller) =====
    // { points: [{x,y}...], tris: [{p1,p2,p3,fill}...], offset } — pas l'API
    // navigateur (format interne + fragile sous file://). Tris re-indexes en
    // indices RELATIFS a la liste copiee ; offset = compteur de collages
    // (decalage d'un demi-pas de grille par collage). undefined = vide.
    // Session seule, jamais persiste.
    clipboard: undefined,

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
    // Transitoire, jamais persiste : masque points de controle, axes, grille,
    // HUD et boutons pour ne laisser que la geometrie.
    previewMode: false,
    // Sous-etat « plans » (cycle off -> preview -> plans -> off) : TOUTES les
    // formes rendues comme plans remplis dans l'ordre du tableau (forme n =
    // plan n, la plus haute recouvre les precedentes).
    previewPlans: false,

    // ===== Render time instrumentation (gate) =====
    // Flag dev : `state.debugRenderTime = true` (console navigateur) active
    // console.time autour de renderSceneToOffscreen. Voir DESIGN.md §2.5.5.
    debugRenderTime: false,

    // ===== Modal focus restoration =====
    lastFocusedElement: undefined,

    // ===== Pending deferred history patches (delta storage §8) =====
    // Patchs « en attente » dont le slot `after` est rempli depuis le live
    // state a la fin du geste (mouseup pour grab, fin de debounce pour
    // rotation). Cf. history.js resolveDeferredAfter.
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
