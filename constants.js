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
//   - tri / penta / hexa : polygones reguliers = circleGeometry(n)
//   - star   : etoile (starGeometry, 5 branches)
export const SHAPE_DEFS = {
    rect:   { label: 'rectangle' },
    square: { label: 'carré' },
    tri:    { label: 'triangle' },
    penta:  { label: 'pentagone' },
    hexa:   { label: 'hexagone' },
    star:   { label: 'étoile' },
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

// Stable envelope for exported JSON scenes. Legacy payloads without these
// fields remain readable for backwards compatibility.
export const SCENE_FORMAT = 'meshes-designer'
export const SCENE_FORMAT_VERSION = 1
// Rationale : voir DESIGN.md §7.3
const triangleAlpha = 0.45
export const TRIANGLE_COLOR_PRESETS = [
    { bg: '#E53935', fill: `rgba(229, 57, 53, ${triangleAlpha})` },
    { bg: '#FB8C00', fill: `rgba(251, 140, 0, ${triangleAlpha})` },
    { bg: '#FDD835', fill: `rgba(253, 216, 53, ${triangleAlpha})` },
    { bg: '#43A047', fill: `rgba(67, 160, 71, ${triangleAlpha})` },
    { bg: '#00ACC1', fill: `rgba(0, 172, 193, ${triangleAlpha})` },
    { bg: '#1E88E5', fill: `rgba(30, 136, 229, ${triangleAlpha})` },
    { bg: '#8E24AA', fill: `rgba(142, 36, 170, ${triangleAlpha})` },
    { bg: '#FFFFFF', fill: `rgba(255, 255, 255, ${triangleAlpha})` },
]
export const TRIANGLE_COLOR_CLEAR = '__default__'
export const CONSOLE_VISIBLE_STORAGE_KEY = 'meshesDesigner.consoleVisible'
export const CONSOLE_FRAME_STORAGE_KEY = 'meshesDesigner.consoleFrame'
export const IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'
export const FPS_VISIBLE_STORAGE_KEY = 'meshesDesigner.fpsVisible'
// Nombre de cotes du cercle persiste (meme statut de preference que
// GRID_STEP / reticleMode : restauré au boot, reglé a la molette).
export const CIRCLE_SEGMENTS_STORAGE_KEY = 'meshesDesigner.circleSegments'
