// Rationale : voir DESIGN.md §1.1

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

    // ===== Outil cercle (creation par eventail de triangles) =====
    // Mode transitoire (non persiste, comme la preview) : tant qu'il
    // est actif, le geste « 1er clic = centre, mouvement de la
    // souris = rayon + angle de depart, 2e clic = valider » trace
    // un cercle (orientation par souris, cf. cahier des charges des
    // evolutions). L'utilisateur peut relacher la souris entre les
    // deux clics (le mode reste armé, l'angle se fige sur la
    // dernière valeur du curseur).
    // circleCenterModel : centre du cercle en cours en coords model
    // (snapToGrid applique sur le 1er mousedown), undefined par
    // defaut (= pas encore pose). Sa presence signale qu'on est en
    // milieu de geste : le prochain 1er mousedown validera via
    // commitCircleGesture au lieu de reinitialiser le centre.
    // circleRadiusModel : rayon courant en coords model, mis a
    // jour a chaque mousemove (pilote la previsualisation).
    // circleOffsetAngle : angle de depart du polygone en radians
    // (atan2 du vecteur curseur - centre, evalue en coords screen
    // pour rester intuitif malgre l'axe Y inverse du canvas).
    // Reset a 0 a chaque debut / annulation / fin de geste.
    // circleSegments : nombre de cotes du polygone genere,
    // reglable a la molette en mode cercle (clamp
    // CIRCLE_MIN_SEGMENTS..CIRCLE_MAX_SEGMENTS), persiste en
    // localStorage.
    circleMode: false,
    circleCenterModel: undefined,
    circleRadiusModel: 0,
    circleOffsetAngle: 0,
    circleSegments: CIRCLE_DEFAULT_SEGMENTS,

    // ===== Outil étoile (creation en 3 clics) =====
    // Mode transitoire (non persiste, comme le cercle) calqué sur le
    // geste du cercle + une phase supplementaire :
    //   1. 1er clic = centre (starCenterModel), mouvement = rayon +
    //      angle de depart (le 1er pic de l'etoile pointe vers la
    //      souris, cf. updateStarGesture : offset = atan2 + PI/2
    //      compense le -PI/2 canonique de starGeometry).
    //   2. 2e clic = verrouille rayon + angle (starPhase -> 1) ; le
    //      mouvement regle alors la PROFONDEUR des branches
    //      (starInnerRatio = distance curseur - centre / rayon).
    //   3. 3e clic = valide l'etoile (rayon, angle, profondeur
    //      courants) puis desarme le mode (comme le cercle).
    // La molette du cercle (cotes) ne s'applique pas ici ; Echap
    // quitte le mode, clic droit / Backspace annulent le trace en
    // cours sans desarmer.
    starMode: false,
    starCenterModel: undefined,
    starRadiusModel: 0,
    starOffsetAngle: 0,
    // Phase du geste : 0 = reglage rayon + angle (apres le 1er clic),
    // 1 = reglage profondeur des branches (apres le 2e clic).
    starPhase: 0,
    // Profondeur des branches : ratio rayon interne / rayon externe,
    // regle au mouvement entre le 2e et le 3e clic (clamp
    // STAR_INNER_RATIO_MIN..MAX), initie a la valeur par defaut du
    // catalogue (SHAPE_STAR_INNER_RATIO).
    starInnerRatio: SHAPE_STAR_INNER_RATIO,

    // ===== Outil anneau (cercle perçé d'un trou, creation en 3 clics) =====
    // Mode transitoire (non persiste, comme le cercle / l'étoile)
    // calqué sur le geste de l'étoile (meme logique que le cercle +
    // reglage supplementaire au 3e clic) :
    //   1. 1er clic = centre (annulusCenterModel), mouvement = rayon
    //      EXTERIEUR + angle de depart (le sommet exterieur 0 pointe
    //      vers la souris, meme convention que le cercle).
    //   2. 2e clic = verrouille rayon externe + angle
    //      (annulusPhase -> 1) ; le mouvement regle alors le rayon du
    //      TROU (annulusInnerRatio = distance curseur - centre /
    //      rayon externe, clamp ANNULUS_INNER_RATIO_MIN..MAX).
    //   3. 3e clic = valide l'anneau (rayon externe, angle, trou
    //      courants) puis desarme le mode (comme le cercle).
    // La molette regle le nombre de cotes (meme compteur que le
    // cercle, state.circleSegments) ; Echap quitte le mode, clic
    // droit / Backspace annulent le trace en cours sans desarmer.
    annulusMode: false,
    annulusCenterModel: undefined,
    annulusOuterRadiusModel: 0,
    annulusOffsetAngle: 0,
    // Phase du geste : 0 = reglage rayon externe + angle (apres le
    // 1er clic), 1 = reglage rayon du trou (apres le 2e clic).
    annulusPhase: 0,
    // Taille du trou : ratio rayon interne / rayon externe, reglee au
    // mouvement entre le 2e et le 3e clic (clamp
    // ANNULUS_INNER_RATIO_MIN..MAX), initiee a la valeur par defaut
    // (ANNULUS_INNER_RATIO_DEFAULT).
    annulusInnerRatio: ANNULUS_INNER_RATIO_DEFAULT,

    // ===== Formes prédéfinies (panneau #shapes) =====
    // Panneau flottant du bouton #shapes (liste des formes
    // prédéfinies), ouvert/ferme par le bouton ou clic exterieur.
    shapesPanelOpen: false,
    // Outil de forme armé : shapeKind = 'rect' | 'square' | 'tri' |
    // 'penta' | 'hexa' | 'star' (clé du catalogue SHAPE_DEFS). Une
    // forme armée attend un geste clic + glisser sur le canvas :
    //   - rect / square : shapeAnchorModel = 1er coin, courant = 2e coin
    //   - polygones / étoile : shapeAnchorModel = centre,
    //     shapeRadiusModel = rayon
    // L'outil se désarme automatiquement après la création (comme le
    // cercle) ou via Echap / re-clic sur le bouton.
    shapeKind: undefined,
    shapeAnchorModel: undefined,
    shapeCurrentModel: undefined,
    shapeRadiusModel: 0,
    // Orientation par souris des polygones reguliers (tri / penta /
    // hexa) : angle de depart du sommet 0 en radians, calcule en coords
    // model comme le cercle (le sommet 0 pointe vers la souris).
    // rect / square restent axis-aligned (taille seule). Initie a 0
    // a chaque armement / debut / annulation / fin de geste.
    shapeOffsetAngle: 0,

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

    // ===== Palette de couleurs (#triangleColor) =====
    // Trois champs couvrent le cycle de vie de la palette, groupes
    // ici parce qu'ils sont lus ensemble par hud.js + editor.js :
    //
    // isTriangleColorPanelOpen : true tant que le panneau flottant
    // est deploye (cache ou visible via positionPanelUnderButton).
    // Indépendant de brushMode — un utilisateur peut ouvrir le
    // panneau sans armer le pinceau (clic sur Reset, qui pose
    // brushMode = false tout en laissant le panneau ouvert à la
    // recherche d'une nouvelle couleur).
    //
    // brushMode / brushColor : non persistés (meme politique que
    // previewMode / circleMode / shapeKind). Le pinceau peut etre
    // armé ou non pendant que la palette est ouverte :
    //   - à l'ouverture (showTriangleColorPanel), brushMode = true
    //     ET brushColor = 1er preset actif (1er swatch mis en
    //     surbrillance) — l'utilisateur peut peindre des le
    //     premier coup, sans cliquer une couleur.
    //   - clic sur un swatch / input color picker = maj
    //     brushColor, brushMode reste true.
    //   - clic sur le bouton Reset du panneau = brushMode = false
    //     (panneau reste ouvert).
    //   - fermeture du panneau (re-clic bouton, Escape, clic
    //     exterieur) = brushMode = false ET brushColor =
    //     undefined.
    // Le pipeline souris (main.js mousedown) court-circuite la
    // branche lasso quand brushMode est vrai : clic gauche sur un
    // triangle = peintresTriangleAtCursor. Les clics milieu (pan)
    // et droit (grab selon le mode) ne sont PAS affectes —
    // l'evolution precise que le bouton droit garde la semantique
    // de deplacement.
    isTriangleColorPanelOpen: false,
    brushMode: false,
    brushColor: undefined,

    // (evolution palette persitee + opacite unique, cf. DESIGN.md
    // §7.3.1 / §7.3.2) — la palette est une PREFERENCE utilisateur :
    // tableau de { bg, fill } initialise aux presets historiques
    // (TRIANGLE_COLOR_PRESETS), remplace au boot par
    // restoreColorPalette (editor.js) si une sauvegarde existe dans
    // COLOR_PALETTE_STORAGE_KEY, et re-ecrit a chaque mutation
    // (ajout / retrait / edition / restauration des defauts). La
    // palette ne stocke QUE des couleurs (bg) — l'opacite de peinture
    // est UNIQUE et globale (state.colorAlpha, curseur #colorAlpha) ;
    // fill est TOUJOURS derive du couple (bg, colorAlpha) par
    // triangleFillFromBg (refreshPaletteFills a chaque changement
    // d'opacite). Contrairement a brushMode/brushColor (session
    // seule), la palette survit aux rechargements.
    // colorPaletteEditingIndex : index du swatch en cours d'edition
    // (double-clic) — tant qu'il est defini, le picker met a jour la
    // couleur du swatch en direct. colorPaletteEditingBefore : bg
    // d'origine du swatch edite, pour annuler (Echap).
    colorPalette: TRIANGLE_COLOR_PRESETS.map(p => ({ bg: p.bg, fill: p.fill })),
    colorPaletteEditingIndex: undefined,
    colorPaletteEditingBefore: undefined,

    // colorAlpha : opacite de travail du curseur #colorAlpha ([0,1],
    // defaut TRIANGLE_COLOR_DEFAULT_ALPHA) — l'opacite APPLIQUEE a
    // chaque peinture, quelle que soit la couleur armee (swatch ou
    // picker). Valeur de SESSION synchronisee par
    // setColorAlphaSlider ; la valeur PERSISTEE
    // (COLOR_ALPHA_STORAGE_KEY) n'est mise a jour que par un reglage
    // MANUEL du curseur (drag) — cliquer un swatch ne remplace pas la
    // preference de l'utilisateur (cf. DESIGN §7.3.2). Restauree au
    // boot par restoreColorPalette (editor.js).
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
    // (fusion par déplacement, cf. DESIGN.md §7.11) — 2e fonction du
    // bouton #mergePoints, armée quand exactement 1 point est
    // sélectionné : glisser ce point puis le relâcher près d'un autre
    // point (rayon MERGE_DROP_RADIUS_PX en pixels écran) le fusionne
    // avec lui. mergeOnDropActive = le mode est armé (bouton en accent
    // vert) ; mergeDropCandidate = index pointList du point cible le
    // plus proche pendant le drag armé (undefined = aucun candidat
    // dans la limite), calculé à chaque tick par editor.js
    // (updateMergeDropCandidate), affiché par draw.js (renderTransient,
    // anneau orange) et consommé par merge.js (attemptDropMerge) au
    // relâchement.
    mergeOnDropActive: false,
    // (évolution verrouillage, cf. DESIGN.md §7.11) — sous-état du mode
    // armé : le bouton est VERROUILLÉ (2e clic quand le mode est armé,
    // icône cadenas + ring inset). Signification : après une fusion
    // réussie, le mode RESTE armé (et verrouillé) au lieu de se
    // désarmer, pour enchaîner plusieurs fusions sans réarmer.
    // Transitoire comme mergeOnDropActive (jamais persisté) : n'est
    // vrai que si mergeOnDropActive est vrai. Effacé par le clic sur le
    // bouton verrouillé (désarme tout), par une sélection multi-points
    // (garde updateSelectionHud) et par la fusion classique.
    mergeOnDropLocked: false,
    mergeDropCandidate: undefined,
    // Rayon courant de la fusion par déplacement (px écran), réglé à la
    // molette sur le bouton Fusionner quand le mode est armé (même
    // statut de préférence que circleSegments : clampé [MIN, MAX],
    // persisté dans MERGE_DROP_RADIUS_STORAGE_KEY, restauré au boot
    // par restoreMergeDropRadius). Cf. DESIGN.md §7.11.
    mergeDropRadius: MERGE_DROP_RADIUS_DEFAULT_PX,

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
