// Constantes du projet ; les justifications détaillées sont dans DESIGN.md.

export const TAU = 2 * Math.PI

export const COLOR_AXIS = '#00A000'
export const COLOR_LINES = '#FFFFFF'
export const COLOR_LINES_INACTIVE = '#5A5A5A'
export const POINT_COLOR_INACTIVE = '#7A7800'
export const COLOR_TRIANGLE_FILL_ACTIVE = 'rgba(255, 255, 255, 0.10)'
export const COLOR_HOVER_NEAREST_LINE = 'rgba(0, 255, 0, 0.7)'
export const LINE_WIDTH_HOVER_NEAREST_LINE = 3
export const COLOR_HOVER_NEAREST_POINT = '#00FF00'
export const COLOR_HOVER_NEAREST_TRIANGLE_STROKE = 'rgba(0, 255, 0, 0.6)'
export const COLOR_HOVER_NEAREST_TRIANGLE_FILL = 'rgba(0, 255, 0, 0.18)'

export const POINT_COLOR_ACTIVE = '#FFFF00'
export const COLOR_SELECTED_POINT = '#00FFFF'
export const COLOR_SELECTED_POINT_DIMMED = 'rgba(0, 255, 255, 0.6)'
export const COLOR_SELECTION_BOX_FILL = 'rgba(0, 255, 255, 0.15)'
export const COLOR_SELECTION_BOX_STROKE = '#00FFFF'
// Anneau orange autour des sommets multi-points (doublons de scenes legacy),
// candidats a la fusion #mergePoints : orange distinct du jaune actif, du
// cyan de selection, du vert de hover et du blanc du curseur.
export const COLOR_MULTI_POINT = '#FFA500'
export const MULTI_POINT_RADIUS = 5
export const COLOR_CURSOR = '#FFFFFF'
export const COLOR_RETICLE = '#FFFFFF'
export const CANVAS_BACKGROUND = '#000000'
export const COLOR_GRID = '#333333'

export const PATTERN_AXIS = [2, 1, 3, 1]
export const PATTERN_LINES = [2, 2]
export const PATTERN_LINES_INACTIVE = [4, 4]

export const DEFAULT_GRID_STEP = 32
export const MIN_GRID_STEP = 8
export const MAX_GRID_STEP = 128

export const ACTION_NONE = undefined
export const ACTION_GRABBING = 1

// ===== Outil cercle (creation par eventail de triangles) =====
export const COLOR_CIRCLE_PREVIEW = 'rgba(0, 255, 0, 0.8)'
// Nombre de cotes du polygone genere (molette en mode cercle), bornes 3..128.
export const CIRCLE_MIN_SEGMENTS = 3
export const CIRCLE_MAX_SEGMENTS = 128
export const CIRCLE_DEFAULT_SEGMENTS = 24
// Rayon minimum (px ecran) pour commiter un cercle : en dessous, un clic
// sans glissement est un abandon plutot qu'un cercle degenere.
export const CIRCLE_MIN_RADIUS_PX = 5

// ===== Formes predéfinies (panneau #shapes) =====
// kind -> label francais ; generation geometrique par kind (geometry.js).
export const SHAPE_DEFS = {
    rect:   { label: 'rectangle' },
    square: { label: 'carré' },
    tri:    { label: 'triangle' },
    penta:  { label: 'pentagone' },
    hexa:   { label: 'hexagone' },
    star:   { label: 'étoile' },
    annulus: { label: 'anneau' },
}
export const SHAPE_STAR_POINTS = 5
export const SHAPE_STAR_INNER_RATIO = 0.4
// Bornes du ratio interne (profondeur des branches) et du trou de
// l'anneau, regles au 3e clic (clamp a la generation et a la saisie).
export const STAR_INNER_RATIO_MIN = 0.05
export const STAR_INNER_RATIO_MAX = 0.95
export const ANNULUS_INNER_RATIO_MIN = 0.05
export const ANNULUS_INNER_RATIO_MAX = 0.95
// Ratio de trou par defaut affiche en phase 1 du geste (mi-rayon).
export const ANNULUS_INNER_RATIO_DEFAULT = 0.5

export const MAX_HISTORY = 50

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 10
export const ZOOM_STEP_FACTOR = 1.1
export const ROTATE_STEP = (5 * Math.PI) / 180

export const CONSOLE_MIN_WIDTH = 80
export const CONSOLE_MIN_HEIGHT = 30

export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'
// Cle separee de la scene : l'undo ne doit jamais transiter par le wire
// format des fichiers exportes. Porte historyStack + redoStack + un
// fingerprint `scene` (= string serializeState ecrit au meme instant dans
// SCENE_STORAGE_KEY) pour verifier au boot que les entries correspondent.
export const UNDO_STORAGE_KEY = 'meshesDesigner.undo'
export const GRID_STEP_STORAGE_KEY = 'meshesDesigner.gridStep'
export const ACTIVE_GRID_STORAGE_KEY = 'meshesDesigner.activeGrid'
export const ZOOM_STORAGE_KEY = 'meshesDesigner.zoom'
export const VIEW_CENTER_STORAGE_KEY = 'meshesDesigner.viewCenter'
export const RETICLE_MODE_STORAGE_KEY = 'meshesDesigner.reticleMode'
export const SELECTION_MODE_STORAGE_KEY = 'meshesDesigner.selectionMode'
export const EDITING_MODE_STORAGE_KEY = 'meshesDesigner.editingMode'
// Mode d'edition unique (la matrice a trois modes a ete reduite) : on garde
// le tableau + la cle storage pour la migration silencieuse d'anciennes
// sessions localStorage qui auraient stocke un autre identifiant.
export const EDITING_MODES = ['edition']
export const SELECTION_MODES = ['vertex', 'segment', 'triangle']

// Tolerances de hit-testing en pixels ecran : sensation constante a tous les zooms.
export const POINT_HIT_RADIUS_PX = 36
export const LINE_HIT_RADIUS_PX = 60
export const TRIANGLE_CENTROID_HIT_RADIUS_PX = 20
// Fusion par deplacement (2e fonction de #mergePoints) : rayon en px ecran
// du point relache au point cible, reglable a la molette quand le mode est
// arme, bornes serrees 8-64. Preference de session hors du wire format.
export const MERGE_DROP_RADIUS_DEFAULT_PX = 20
export const MERGE_DROP_RADIUS_MIN_PX = 8
export const MERGE_DROP_RADIUS_MAX_PX = 64
export const MERGE_DROP_RADIUS_STEP_PX = 2
export const MERGE_DROP_RADIUS_STORAGE_KEY = 'meshesDesigner.mergeDropRadius'

// Enveloppe stable des scenes JSON exportees ; les payloads legacy restent lisibles.
export const SCENE_FORMAT = 'meshes-designer'
export const SCENE_FORMAT_VERSION = 1
// Opacite UNIQUE appliquee a toute peinture de triangle (curseur #colorAlpha) ;
// la palette ne stocke que des hex, sans alpha par swatch.
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

// Construit le fill rgba depuis un hex #rrggbb (ou #rgb, expandu) et une alpha
// clampée [0,1] ; renvoie bg tel quel si le parse echoue. null/NaN/Infinity
// retombent sur le defaut (une couleur transparente silencieuse serait un piege).
export const triangleFillFromBg = (bg, alpha = TRIANGLE_COLOR_DEFAULT_ALPHA) => {
    if (typeof bg !== 'string') return bg
    let hex = bg.trim()
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
        hex = '#' + hex.slice(1).split('').map(c => c + c).join('')
    }
    const m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) return bg
    const n = parseInt(m[1], 16)
    const numeric = alpha == null ? TRIANGLE_COLOR_DEFAULT_ALPHA : Number(alpha)
    const a = Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : TRIANGLE_COLOR_DEFAULT_ALPHA))
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
export const CONSOLE_VISIBLE_STORAGE_KEY = 'meshesDesigner.consoleVisible'
export const CONSOLE_FRAME_STORAGE_KEY = 'meshesDesigner.consoleFrame'
export const IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'
export const FPS_VISIBLE_STORAGE_KEY = 'meshesDesigner.fpsVisible'
// Nombre de cotes du cercle persiste (preference de session, regle a la molette).
export const CIRCLE_SEGMENTS_STORAGE_KEY = 'meshesDesigner.circleSegments'
// Palette de couleurs : preference persistee (meme statut que consoleVisible),
// restauree au boot par restoreColorPalette, re-ecrite a chaque mutation.
export const COLOR_PALETTE_STORAGE_KEY = 'meshesDesigner.colorPalette'
// Opacite de travail #colorAlpha : persistee UNIQUEMENT au deplacement manuel
// du curseur (les clics swatch / Reset / Defauts ne doivent pas l'ecraser).
export const COLOR_ALPHA_STORAGE_KEY = 'meshesDesigner.colorAlpha'
// Noms des scenes deja sauvegardees (du plus recent au plus ancien), affiches
// par la fenetre d'enregistrement. Hors du wire format des fichiers exportes.
export const SAVED_SCENES_STORAGE_KEY = 'meshesDesigner.savedScenes'
// Nombre maximal d'emplacements memorises : la liste reste lisible.
export const MAX_SAVED_SCENES = 20
