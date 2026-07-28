// Module constants.js : constantes pures extraites du top-level de main.js.
// Pas de dependances : peut etre importe n'importe ou sans effet de bord.
// Convention : named exports pour permettre un tree-shaking eventuel.

export const TAU = 2 * Math.PI

export const COLOR_AXIS = '#00A000'
export const COLOR_LINES = '#FFFFFF'
// Couleur/dash pour les formes INACTIVES : gris attenué pour signaler
// "non editable" tout en restant visibles.
export const COLOR_LINES_INACTIVE = '#5A5A5A'
export const POINT_COLOR_INACTIVE = '#7A7800'

export const PATTERN_AXIS = [2, 1, 3, 1]
export const PATTERN_LINES = [2, 2]
export const PATTERN_LINES_INACTIVE = [4, 4]

export const DEFAULT_GRID_STEP = 32
export const MIN_GRID_STEP = 8
export const MAX_GRID_STEP = 128

// Actions : ancien systeme enumere en constantes globales. ACTION_NONE
// vaut undefined pour permettre une comparaison `currentAction === undefined`
// idiomatique. ACTION_GRABBING = 1 (drag d'un point en cours).
export const ACTION_NONE = undefined
export const ACTION_GRABBING = 1

export const MAX_HISTORY = 50

// Bornes zoom : 0.1x a 10x (cf. wheel handler).
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 10
export const ZOOM_STEP_FACTOR = 1.1
// Rotation molette : 5 degres par tick (vers la droite = +angle CCW en
// coords modele maths, Y+ vers le haut).
export const ROTATE_STEP = (5 * Math.PI) / 180

// Minimums taille cadre console (resize listener borne a ces valeurs
// pour eviter que l'utilisateur ecrase le cadre a 0x0 = inutilisable).
export const CONSOLE_MIN_WIDTH = 80
export const CONSOLE_MIN_HEIGHT = 30

// Clefs localStorage (isolees de la scene JSON, voir knowledge.md
// "localStorage is sticky across reloads"). Les prefixes sont
// explicites pour permettre un audit rapide dans devtools.
export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'
export const GRID_STEP_STORAGE_KEY = 'meshesDesigner.gridStep'
export const ACTIVE_GRID_STORAGE_KEY = 'meshesDesigner.activeGrid'
export const ZOOM_STORAGE_KEY = 'meshesDesigner.zoom'
export const VIEW_CENTER_STORAGE_KEY = 'meshesDesigner.viewCenter'
export const RETICLE_MODE_STORAGE_KEY = 'meshesDesigner.reticleMode'
export const CONSOLE_VISIBLE_STORAGE_KEY = 'meshesDesigner.consoleVisible'
export const CONSOLE_FRAME_STORAGE_KEY = 'meshesDesigner.consoleFrame'
export const IMPORT_MODE_STORAGE_KEY = 'meshesDesigner.importMode'
