// Rationale : voir DESIGN.md §5.1

export const TAU = 2 * Math.PI

export const COLOR_AXIS = '#00A000'
export const COLOR_LINES = '#FFFFFF'
export const COLOR_LINES_INACTIVE = '#5A5A5A'
export const POINT_COLOR_INACTIVE = '#7A7800'
// Rationale : voir DESIGN.md §1.1
export const COLOR_TRIANGLE_FILL_ACTIVE = 'rgba(255, 255, 255, 0.10)'
export const COLOR_HOVER_NEAREST_LINE = 'rgba(0, 255, 0, 0.7)'
export const LINE_WIDTH_HOVER_NEAREST_LINE = 3
// Rationale : voir DESIGN.md §7.4
export const COLOR_HOVER_NEAREST_POINT = '#00FF00'
export const COLOR_HOVER_NEAREST_TRIANGLE_STROKE = 'rgba(0, 255, 0, 0.6)'
export const COLOR_HOVER_NEAREST_TRIANGLE_FILL = 'rgba(0, 255, 0, 0.18)'

// Rationale : voir DESIGN.md §7.2
export const POINT_COLOR_ACTIVE = '#FFFF00'
// Rationale : voir DESIGN.md §7.6
export const COLOR_SELECTED_POINT = '#00FFFF'
export const COLOR_SELECTED_POINT_DIMMED = 'rgba(0, 255, 255, 0.6)'
export const COLOR_SELECTION_BOX_FILL = 'rgba(0, 255, 255, 0.15)'
export const COLOR_SELECTION_BOX_STROKE = '#00FFFF'
// Rationale : voir DESIGN.md §7.10
// Marqueur des sommets multi-points : anneau orange autour des
// positions portant PLUSIEURS entrees pointList (doublons de scenes
// legacy/importees) — candidats a la fusion #mergePoints. Orange
// (#FFA500) choisi pour rester distinct a tous les etats : du jaune
// des points actifs (#FFFF00), du cyan de selection (#00FFFF), du
// vert de hover (#00FF00) et du blanc du curseur (#FFFFFF). Rayon
// situe entre le cercle de hover (5 px) et celui de selection (6 px)
// pour un anneau lisible autour du point jaune (rayon 2).
export const COLOR_MULTI_POINT = '#FFA500'
export const MULTI_POINT_RADIUS = 5
// Rationale : voir DESIGN.md §8
export const COLOR_CURSOR = '#FFFFFF'
export const COLOR_RETICLE = '#FFFFFF'
export const CANVAS_BACKGROUND = '#000000'
// Rationale : voir DESIGN.md §2.2
export const COLOR_GRID = '#333333'

export const PATTERN_AXIS = [2, 1, 3, 1]
export const PATTERN_LINES = [2, 2]
export const PATTERN_LINES_INACTIVE = [4, 4]

export const DEFAULT_GRID_STEP = 32
export const MIN_GRID_STEP = 8
export const MAX_GRID_STEP = 128

// Rationale : voir DESIGN.md §2.2
export const ACTION_NONE = undefined
export const ACTION_GRABBING = 1

// ===== Outil cercle (creation par eventail de triangles) =====
// Couleur de la previsualisation en mode cercle (cercle en pointilles,
// polygone des N cotes, ligne de rayon, marqueur centre). Meme famille
// que COLOR_HOVER_NEAREST_LINE (vert) mais plus opaque pour ressortir
// sur le canvas noir pendant le geste.
export const COLOR_CIRCLE_PREVIEW = 'rgba(0, 255, 0, 0.8)'
// Nombre de cotes du polygone genere : borne basse 3 (triangle),
// borne haute 128 (visuellement un disque lisse). Reglable a la
// molette en mode cercle, meme langage que le pas de grille.
export const CIRCLE_MIN_SEGMENTS = 3
export const CIRCLE_MAX_SEGMENTS = 128
export const CIRCLE_DEFAULT_SEGMENTS = 24
// Rayon minimum (en pixels ecran) pour qu'un geste cercle soit
// commite : en dessous, un clic sans glissement est traite comme un
// abandon plutot que de creer un cercle degeneré. Exprime en px
// ecran (converti en model via le zoom) comme les tolerances de
// hit-testing, pour une sensation constante a tous les zooms.
export const CIRCLE_MIN_RADIUS_PX = 5

// ===== Formes predéfinies (panneau #shapes) =====
// Catalogue des formes proposees par le panneau (bouton #shapes).
// kind -> label francais court affiche sur le bouton quand l'outil
// est arme. La generation geometrique est deleguee par kind :
//   - rect   : rectangle par 2 coins (rectGeometry)
//   - square : carre (cote = max(|dx|,|dy|), signe preserve)
//   - tri    : triangle equilateral = triangleGeometry (3 sommets,
//     UN SEUL triangle — pas d'eventail, cf. cahier des charges)
//   - penta / hexa : polygones reguliers = circleGeometry(n)
//   - star   : etoile (starGeometry, 5 branches)
//   - annulus : anneau (cercle perçé d'un trou) = annulusGeometry
//     (2×N sommets, 2×N triangles — mode 3 clics, cf. editor.js)
export const SHAPE_DEFS = {
    rect:   { label: 'rectangle' },
    square: { label: 'carré' },
    tri:    { label: 'triangle' },
    penta:  { label: 'pentagone' },
    hexa:   { label: 'hexagone' },
    star:   { label: 'étoile' },
    annulus: { label: 'anneau' },
}
// Etoile : nombre de branches + ratio rayon interne / rayon externe.
export const SHAPE_STAR_POINTS = 5
export const SHAPE_STAR_INNER_RATIO = 0.4
// Bornes du ratio interne (profondeur des branches) : le 3e clic du
// mode etoile regle la profondeur par la distance curseur - centre
// (0 = branches qui touchent le centre, 1 = etoile plate). Partagees
// par starGeometry (clamp a la generation) et par updateStarGesture /
// drawStarModePreview (clamp a la saisie et au rendu).
export const STAR_INNER_RATIO_MIN = 0.05
export const STAR_INNER_RATIO_MAX = 0.95
// Bornes du ratio du trou de l'anneau (cercle perçé d'un trou) : le
// 3e clic du mode anneau regle le rayon interne par la distance
// curseur - centre (0 = pas de trou, 1 = anneau infiniment fin),
// normalisee par le rayon externe verrouille. Partagees par
// annulusGeometry (clamp a la generation) et par updateAnnulusGesture /
// drawAnnulusPreview (clamp a la saisie et au rendu).
export const ANNULUS_INNER_RATIO_MIN = 0.05
export const ANNULUS_INNER_RATIO_MAX = 0.95
// Ratio de trou par defaut affiche en phase 1 du geste (avant le
// 3e clic) : un trou a mi-rayon — compromis lisible entre un disque
// plein (0) et un anneau fin (proche de 1).
export const ANNULUS_INNER_RATIO_DEFAULT = 0.5

export const MAX_HISTORY = 50

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 10
export const ZOOM_STEP_FACTOR = 1.1
export const ROTATE_STEP = (5 * Math.PI) / 180

export const CONSOLE_MIN_WIDTH = 80
export const CONSOLE_MIN_HEIGHT = 30

// Rationale : voir DESIGN.md §2.2
export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'
// Historique undo/redo persiste (cle separee de la scene : l'undo ne
// doit jamais transiter par le wire format des fichiers exportes —
// serializeState alimente aussi saveMesh). Vaut pour historyStack ET
// redoStack, plus un fingerprint `scene` (= le string serializeState
// ecrit au meme instant dans SCENE_STORAGE_KEY) pour verifier au
// boot que les entries appartiennent bien a la scene courante.
export const UNDO_STORAGE_KEY = 'meshesDesigner.undo'
export const GRID_STEP_STORAGE_KEY = 'meshesDesigner.gridStep'
export const ACTIVE_GRID_STORAGE_KEY = 'meshesDesigner.activeGrid'
export const ZOOM_STORAGE_KEY = 'meshesDesigner.zoom'
export const VIEW_CENTER_STORAGE_KEY = 'meshesDesigner.viewCenter'
export const RETICLE_MODE_STORAGE_KEY = 'meshesDesigner.reticleMode'
export const SELECTION_MODE_STORAGE_KEY = 'meshesDesigner.selectionMode'
export const EDITING_MODE_STORAGE_KEY = 'meshesDesigner.editingMode'
// Mode d'édition unique : fluide, combine création, sélection et
// déplacement. L'ancienne matrice a trois modes (édition, construction,
// sélection) a été réduite à une seule valeur pour simplifier le
// contrat de clic et supprimer les branches mortes (DESIGN §1.3).
// On garde le tableau + la constante storage pour la migration
// silencieuse d'anciennes sessions qui auraient stocké un autre
// identifiant dans localStorage.
export const EDITING_MODES = ['edition']
export const SELECTION_MODES = ['vertex', 'segment', 'triangle']  

// Hit-testing tolerances stay constant in screen pixels, so selection feels
// equally precise at every zoom level.
export const POINT_HIT_RADIUS_PX = 36
export const LINE_HIT_RADIUS_PX = 60
export const TRIANGLE_CENTROID_HIT_RADIUS_PX = 20
// Limite de la « fusion par déplacement » (2e fonction du bouton
// #mergePoints, cf. DESIGN.md §7.11) : distance maximale entre le
// point relâché et un autre point pour que la fusion s'opère au
// relâchement du drag. Exprimée en pixels écran (convertie en unités
// modèle via le zoom, comme les tolérances de hit-testing §1.4) pour
// une sensation constante à tous les niveaux de zoom. Réglable à la
// molette sur le bouton Fusionner quand le mode est armé (même langage
// que le nombre de côtés du cercle : libellé « 20px » sur le bouton).
// Bornes volontairement serrées (8-64 px) : la fusion doit rester un
// geste délibéré. Valeur courante dans state.mergeDropRadius,
// préférence de session persistée (clé MERGE_DROP_RADIUS_STORAGE_KEY),
// hors du wire format des fichiers exportés.
export const MERGE_DROP_RADIUS_DEFAULT_PX = 20
export const MERGE_DROP_RADIUS_MIN_PX = 8
export const MERGE_DROP_RADIUS_MAX_PX = 64
// Pas de la molette (en px) par cran de rotation — proportionné à la
// plage (8-64 px), comme le pas ±4 de la grille sur sa plage (8-128).
export const MERGE_DROP_RADIUS_STEP_PX = 2
export const MERGE_DROP_RADIUS_STORAGE_KEY = 'meshesDesigner.mergeDropRadius'

// Stable envelope for exported JSON scenes. Legacy payloads without these
// fields remain readable for backwards compatibility.
export const SCENE_FORMAT = 'meshes-designer'
export const SCENE_FORMAT_VERSION = 1
// Rationale : voir DESIGN.md §7.3
// Opacite UNIQUE appliquee a toute peinture de triangle (evolution
// « l'opacite choisie par l'utilisateur est conservee et appliquee a
// chaque fois que l'on peint un triangle », cf. DESIGN.md §7.3.2) :
// le curseur #colorAlpha du panneau la regle (persistee
// manuellement), et chaque couleur de la palette est peinte a cette
// opacite — la palette ne stocke que des couleurs (hex), pas
// d'alpha par swatch.
export const TRIANGLE_COLOR_DEFAULT_ALPHA = 0.45
export const TRIANGLE_COLOR_PRESETS = [
    { bg: '#E53935', fill: `rgba(229, 57, 53, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#FB8C00', fill: `rgba(251, 140, 0, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#FDD835', fill: `rgba(253, 216, 53, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#43A047', fill: `rgba(67, 160, 71, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#00ACC1', fill: `rgba(0, 172, 193, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#1E88E5', fill: `rgba(30, 136, 229, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#8E24AA', fill: `rgba(142, 36, 170, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
    { bg: '#FFFFFF', fill: `rgba(255, 255, 255, ${TRIANGLE_COLOR_DEFAULT_ALPHA})` },
]
export const TRIANGLE_COLOR_CLEAR = '__default__'

// (evolution palette persitee + opacite globale, cf. DESIGN.md
// §7.3.1 / §7.3.2) : construit le fill rgba depuis un hex #rrggbb
// (ou #rgb, expandu) et une alpha (defaut TRIANGLE_COLOR_DEFAULT_ALPHA,
// meme semantique que les presets). Sert aux couleurs de la palette
// (fill derive au chargement et a chaque changement d'opacite) ET au
// pinceau (le curseur d'opacite arme le pinceau avec bg + alpha
// courante). Retourne bg tel quel si le parse echoue (defense — la
// valeur transiterait telle quelle vers t.fill). L'alpha est clamplee
// [0, 1] : un alpha hors bornes rendrait le canvas silencieusement
// avec une couleur invalide (et passerait tel quel dans le wire
// format des scenes).
export const triangleFillFromBg = (bg, alpha = TRIANGLE_COLOR_DEFAULT_ALPHA) => {
    if (typeof bg !== 'string') return bg
    let hex = bg.trim()
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
        hex = '#' + hex.slice(1).split('').map(c => c + c).join('')
    }
    const m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) return bg
    const n = parseInt(m[1], 16)
    // null / undefined / NaN / Infinity tombent sur le defaut plutot
    // que sur un alpha invalide (une couleur transparente silencieuse
    // serait un piege). Les valeurs numeriques valides sont clamplees
    // [0, 1].
    const numeric = alpha == null ? TRIANGLE_COLOR_DEFAULT_ALPHA : Number(alpha)
    const a = Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : TRIANGLE_COLOR_DEFAULT_ALPHA))
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
export const CONSOLE_VISIBLE_STORAGE_KEY = 'meshesDesigner.consoleVisible'
export const CONSOLE_FRAME_STORAGE_KEY = 'meshesDesigner.consoleFrame'
export const IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'
export const FPS_VISIBLE_STORAGE_KEY = 'meshesDesigner.fpsVisible'
// Nombre de cotes du cercle persiste (meme statut de preference que
// GRID_STEP / reticleMode : restauré au boot, reglé a la molette).
export const CIRCLE_SEGMENTS_STORAGE_KEY = 'meshesDesigner.circleSegments'
// Palette de couleurs des triangles (evolution « palette modifiable /
// enrichie, conservee en localhost ») : liste des `bg` hex #rrggbb,
// persisee comme preference (meme statut que consoleVisible /
// reticleMode), restauree au boot par restoreColorPalette (editor.js)
// et ecrite a chaque mutation (persistColorPalette).
export const COLOR_PALETTE_STORAGE_KEY = 'meshesDesigner.colorPalette'
// Opacite de travail du curseur #colorAlpha (evolution « l'opacite
// choisie par l'utilisateur est conservee et appliquee a chaque fois
// que l'on peint un triangle », cf. DESIGN.md §7.3.2) : nombre [0,1],
// persise comme preference. Elle n'est persistee QUE quand
// l'utilisateur deplace le curseur lui-meme — les synchronisations
// d'affichage (clic swatch, Reset, Defauts...) ne doivent pas ecraser
// le reglage manuel.
export const COLOR_ALPHA_STORAGE_KEY = 'meshesDesigner.colorAlpha'
// Emplacements d'enregistrement de la scène (évolution « enregistrement
// scène ») : noms des scènes déjà sauvegardées, du plus récent au plus
// ancien, persistés comme préférence (même statut que consoleVisible /
// colorPalette). C'est la liste affichée par la fenêtre d'enregistrement
// (sélection de l'emplacement + renommage), qui se positionne sur
// l'emplacement précédent (= le plus récent). Hors du wire format des
// fichiers exportés.
export const SAVED_SCENES_STORAGE_KEY = 'meshesDesigner.savedScenes'
// Nombre maximal d'emplacements mémorisés : la liste reste lisible dans
// la fenêtre d'enregistrement (une liste démesurée deviendrait
// inutilisable à parcourir).
export const MAX_SAVED_SCENES = 20
