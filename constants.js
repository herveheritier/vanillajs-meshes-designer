// Rationale : voir DESIGN.md §5.1

export const TAU = 2 * Math.PI

export const COLOR_AXIS = '#00A000'
export const COLOR_LINES = '#FFFFFF'
// Couleur/dash pour les formes INACTIVES : gris attenué pour signaler
// "non editable" tout en restant visibles.
export const COLOR_LINES_INACTIVE = '#5A5A5A'
export const POINT_COLOR_INACTIVE = '#7A7800'
// Rationale : voir DESIGN.md §1.1
export const COLOR_TRIANGLE_FILL_ACTIVE = 'rgba(255, 255, 255, 0.10)'
// Couleur du trait "nearest" en hover (modes 'vertex' et
// 'segment') : vert accent rgba(0,255,0,0.7), meme teinte
// (legerement plus opaque) que le triangle hover du mode
// 'triangle' (0.6). Visuel coherent "feedback vert = cette
// entite est sous le curseur et sera utilisee comme ancre
// du prochain ajout". Permet de distinguer rapidement le
// trait hovered d'un contour de triangle standard (1px blanc
// / 1px gris dash [4,4]).
export const COLOR_HOVER_NEAREST_LINE = 'rgba(0, 255, 0, 0.7)'
// Epaisseur de ligne pour le trait "nearest" en hover : 3
// px (vs 1 px par defaut) pour ressortir nettement parmi
// les autres traits. Reset a 1 apres chaque stroke par le
// caller (cf. updateMouseHover) pour eviter la pollution
// du lineWidth global entre rendus.
export const LINE_WIDTH_HOVER_NEAREST_LINE = 3

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

// Rationale : voir DESIGN.md §2.2
export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'
export const GRID_STEP_STORAGE_KEY = 'meshesDesigner.gridStep'
export const ACTIVE_GRID_STORAGE_KEY = 'meshesDesigner.activeGrid'
export const ZOOM_STORAGE_KEY = 'meshesDesigner.zoom'
export const VIEW_CENTER_STORAGE_KEY = 'meshesDesigner.viewCenter'
export const RETICLE_MODE_STORAGE_KEY = 'meshesDesigner.reticleMode'
// Cle de la preference "mode de selection" (cyclique, persiste
// pour survivre aux reloads comme le reticule).
export const SELECTION_MODE_STORAGE_KEY = 'meshesDesigner.selectionMode'
// Liste ordonnee des modes cycles par le bouton #selectionMode.
// L'ordre est l'ordre du cycle (un clic = mode suivant modulo len).
// 'vertex' est en premier pour qu'au premier toggle on aille vers
// 'segment', qui est la decouverte de feature la plus naturelle.
export const SELECTION_MODES = ['vertex', 'segment', 'triangle']
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
// Couleur "clear" appliquee quand l'utilisateur clique sur le
// bouton "effacer la couleur" dans le panneau : la valeur
// sentinelle STRING qui fait que applyColorToSelectedTriangles
// supprime t.fill (au lieu d'ecrire une valeur). Cf. draw.js
// : drawShape retombe sur COLOR_TRIANGLE_FILL_ACTIVE quand
// t.fill est absent ou undefined.
export const TRIANGLE_COLOR_CLEAR = '__default__'
export const CONSOLE_VISIBLE_STORAGE_KEY = 'meshesDesigner.consoleVisible'
export const CONSOLE_FRAME_STORAGE_KEY = 'meshesDesigner.consoleFrame'
export const IMPORT_MODE_STORAGE_KEY = 'mesh-designer-import-mode'
