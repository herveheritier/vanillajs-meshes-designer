// ---------------------------------------------------------------
// constants.js
//
// Pure constants : aucune dependance, declare en premier dans
// main.html : tous les autres modules y accedent via global.
// Convention : `const`/`let` au top-level du <script> = global
// lexical binding (accessible a tous les <script> suivants).
// ---------------------------------------------------------------

const TAU = 2 * Math.PI
const COLOR_AXIS = '#00A000'
const COLOR_LINES = '#FFFFFF'
// Couleur/dash pour les formes INACTIVES : gris atténue pour signaler
// "non editable" tout en restant visibles.
const COLOR_LINES_INACTIVE = '#5A5A5A'
const POINT_COLOR_INACTIVE = '#7A7800'
const PATTERN_AXIS = [2,1,3,1]
const PATTERN_LINES = [2,2]
const PATTERN_LINES_INACTIVE = [4,4]
const DEFAULT_GRID_STEP = 32
const MIN_GRID_STEP = 8
const MAX_GRID_STEP = 128
const ACTION_NONE = undefined
const ACTION_GRABBING = 1
const MAX_HISTORY = 50
const MIN_ZOOM = 0.1
const MAX_ZOOM = 10
const ZOOM_STEP_FACTOR = 1.1
const ROTATE_STEP = (5 * Math.PI) / 180
// Cle localStorage pour l'etat de la scene (cf. serializeState /
// persistState / loadState dans import_export.js).
const STORAGE_KEY = 'mesh-designer-state'
// Cle localStorage pour la preference "mode d'import memorise".
const IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'
