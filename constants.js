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

export const MAX_HISTORY = 50

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 10
export const ZOOM_STEP_FACTOR = 1.1
export const ROTATE_STEP = (5 * Math.PI) / 180

export const CONSOLE_MIN_WIDTH = 80
export const CONSOLE_MIN_HEIGHT = 30

// Rationale : voir DESIGN.md §2.2
export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'
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
