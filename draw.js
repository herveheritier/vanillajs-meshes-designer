// Rationale : voir DESIGN.md §2.3

import { state } from './state.js'
import { modelToScreen, screenToModel } from './geometry.js'
import {
    TAU,
    COLOR_AXIS,
    COLOR_LINES,
    COLOR_LINES_INACTIVE,
    CANVAS_BACKGROUND,
    COLOR_CURSOR,
    COLOR_RETICLE,
    COLOR_GRID,
    POINT_COLOR_ACTIVE,
    POINT_COLOR_INACTIVE,
    COLOR_TRIANGLE_FILL_ACTIVE,
    COLOR_SELECTED_POINT,
    COLOR_SELECTED_POINT_DIMMED,
    COLOR_SELECTION_BOX_FILL,
    COLOR_SELECTION_BOX_STROKE,
    COLOR_CIRCLE_PREVIEW,
    SHAPE_STAR_POINTS, SHAPE_STAR_INNER_RATIO,
    PATTERN_AXIS,
    PATTERN_LINES,
    PATTERN_LINES_INACTIVE,
} from './constants.js'

export const drawPoint = (p, radius = 3, color = '#FFFFFF') => {
    if (!p) return
    let sp = modelToScreen(p)
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, radius, 0, TAU)
    state._ctx.stroke()
}

// ===== Performance : drawPointsBatch =====
// (feature/performance opt #1) — factorise N drawPoint successifs en un
// seul beginPath + N sub-paths (moveTo + arc) + un seul stroke(). Sur
// un mesh de 1000 triangles (~3000 vertex partages : chaque sommet
// partage entre 2-6 triangles referenciait le meme arc stroke N fois),
// on tombe de 3000 cycles beginPath/stroke (chaque cycle = setLineDash +
// setStrokeStyle + beginPath + arc + stroke) a UN seul. Sur mesh-wail
// (33 pts, 36 tris) on attend ~108 -> 1 beginPath/stroke pour la forme
// active.
//
// API inchangee cote caller : un tableau de points en model coords, un
// radius, une couleur de stroke. Les callers qui ont besoin de tracer
// un point isole (hover overlays : drawMouse, drawPoint direct dans
// editor.js updateMouseHover pour le nearest-point vert radius 5)
// continuent a utiliser drawPoint() — leur cycle est rendu SUR le
// visible canvas apres le blit offscreen, pas dans la phase de
// repeint offscreen, et doit rester identifie pour ne pas etre avalé
// par un batch offscreen en cours.
//
// Sub-path moveTo explicite : arc() NE reset PAS le "current point"
// du path apres son trace (spec Canvas 2D : "If the previous point
// of the sub-path... a line will be drawn from the last point to the
// start point of the arc"). Si on enchaînait deux arc() sans moveTo,
// le path tracerait une ligne parasite entre les deux centres AVANT
// chaque arc, ce qui ajouterait des segments entre tous les points
// du batch. Le moveTo(sp.x, sp.y) avant chaque arc casse la
// continuite et isole chaque cercle en sous-path ferme ; le stroke()
// final trace tous les arcs ensemble, en un seul appel GPU.
export const drawPointsBatch = (points, radius, color) => {
    if (!points || points.length === 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!p) continue
        const sp = modelToScreen(p)
        state._ctx.moveTo(sp.x, sp.y)
        state._ctx.arc(sp.x, sp.y, radius, 0, TAU)
    }
    state._ctx.stroke()
}

// drawMouse : la croix / point blanc au curseur est dessinée ici
// (et pas en CSS — le curseur du board est `display:none` inline,
// cf. main.js boot, pour qu'on controle tout pixel-par-pixel).
// En mode pinceau (panel de couleurs ouvert ET brushMode actif), on
// ajoute en dessous du curseur un petit disque rempli de la couleur
// courante du pinceau — feedback visuel immediate de « tu vas peindre
// de cette couleur-là ». Le ring blanc exterieur reste pour distinguer
// le marqueur d'un selecteur de couleur opaque (sur fond noir / sur
// triangles deja colores). Taille (rayon 7) choisie pour rester
// lisible sans envahir la zone de hit : ~3 px du disque blanc central
// + 4 px de « padding » sur le pourtour.
const BRUSH_CURSOR_RADIUS = 7
export const drawMouse = (p) => {
    if (!p) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_CURSOR
    state._ctx.beginPath()
    state._ctx.arc(p.x, p.y, 3, 0, TAU)
    state._ctx.stroke()
    if (state.brushMode && typeof state.brushColor === 'string') {
        state._ctx.beginPath()
        state._ctx.fillStyle = state.brushColor
        state._ctx.arc(p.x, p.y, BRUSH_CURSOR_RADIUS, 0, TAU)
        state._ctx.fill()
        // Ring blanc fin pour rendre le marqueur lisible quand
        // brushColor est proche du noir (ex: un preset futur) ou
        // sur fond deja proche de la couleur (un triangle deja
        // peint de la meme teinte).
        state._ctx.strokeStyle = '#ffffff'
        state._ctx.lineWidth = 1
        state._ctx.stroke()
    }
}

// Label d'identifiant stable du sommet survole (cf. §7.8) : petite
// pill sombre sous le point avec l'index 0-based du vertex dans
// activeShapeIndex (convention dev-friendly alignee sur les arrays
// JS de getAllVertices()). Permet d'identifier chaque point sans
// ambiguite quand plusieurs refs partagent la meme position.
// Position sous le cercle vert (offset Y +14) pour eviter la
// collision visuelle avec les elements superieurs du stack.
// Choix d'un fond semi-transparent pour rester lisible sur
// n'importe quelle zone du canvas (sombre ou deja coloree par un
// triangle custom).
const VERTEX_LABEL_OFFSET_Y = 14
const VERTEX_LABEL_HEIGHT = 14
const VERTEX_LABEL_PADDING_X = 6
const VERTEX_LABEL_FONT = '10px monospace'
const VERTEX_LABEL_COLOR = '#FFFFFF'
const VERTEX_LABEL_BACKGROUND = 'rgba(0, 0, 0, 0.6)'
export const drawVertexLabel = (p, label) => {
    if (!p || label === undefined || label === null) return
    const sp = modelToScreen(p)
    state._ctx.font = VERTEX_LABEL_FONT
    state._ctx.textAlign = 'center'
    state._ctx.textBaseline = 'middle'
    const text = String(label)
    const w = state._ctx.measureText(text).width + VERTEX_LABEL_PADDING_X * 2
    const x0 = sp.x - w / 2
    const y0 = sp.y + VERTEX_LABEL_OFFSET_Y - VERTEX_LABEL_HEIGHT / 2
    state._ctx.fillStyle = VERTEX_LABEL_BACKGROUND
    state._ctx.fillRect(x0, y0, w, VERTEX_LABEL_HEIGHT)
    state._ctx.fillStyle = VERTEX_LABEL_COLOR
    state._ctx.fillText(text, sp.x, sp.y + VERTEX_LABEL_OFFSET_Y)
}

// Liste des slots triangles qui partagent le sommet survole (cf.
// §7.9). Pill 2 lignes : header golden "stack (N)" + body blanc
// "T1.p1, T3.p2, ...". Position sous le label §7.8 (offset Y +32)
// sans overlap avec le label (+14/+21) ni avec le canvas bottom
// edge (pas de flip -- un stack de plusieurs refs est rare ; si
// besoin ajouter un clamp bottom-edge ici).
const STACK_LIST_OFFSET_Y = 32
const STACK_LIST_HEIGHT = 14
const STACK_LIST_PADDING_X = 6
const STACK_LIST_PADDING_Y = 4
const STACK_LIST_FONT = '10px monospace'
const STACK_LIST_HEADER_COLOR = '#FFD700'
const STACK_LIST_BODY_COLOR = '#FFFFFF'
const STACK_LIST_BACKGROUND = 'rgba(0, 0, 0, 0.7)'
export const drawStackList = (p, refs) => {
    if (!p || !Array.isArray(refs) || refs.length === 0) return
    const sp = modelToScreen(p)
    state._ctx.font = STACK_LIST_FONT
    state._ctx.textAlign = 'center'
    state._ctx.textBaseline = 'middle'
    const headerText = `stack (${refs.length})`
    const bodyText = refs.map(r => `T${r.triangleIndex}.${r.slotId}`).join(', ')
    const headerWidth = state._ctx.measureText(headerText).width
    const bodyWidth = state._ctx.measureText(bodyText).width
    const contentWidth = Math.max(headerWidth, bodyWidth)
    const w = contentWidth + STACK_LIST_PADDING_X * 2
    const h = STACK_LIST_HEIGHT * 2 + STACK_LIST_PADDING_Y * 2
    const x0 = sp.x - w / 2
    const y0 = sp.y + STACK_LIST_OFFSET_Y
    state._ctx.fillStyle = STACK_LIST_BACKGROUND
    state._ctx.fillRect(x0, y0, w, h)
    state._ctx.fillStyle = STACK_LIST_HEADER_COLOR
    state._ctx.fillText(headerText, sp.x, y0 + STACK_LIST_PADDING_Y + STACK_LIST_HEIGHT / 2)
    state._ctx.fillStyle = STACK_LIST_BODY_COLOR
    state._ctx.fillText(bodyText, sp.x, y0 + STACK_LIST_PADDING_Y + STACK_LIST_HEIGHT * 1.5)
}

// ===== Scene cache (feature/performance) =====
//
// Rationale : avec l'ancien drawBoard, chaque mousemove repaintait
// integralement le visible canvas (background + grid + axes + N
// formes + selection + reticule + selectionBox). Meme quand rien
// d'observable n'avait change (curseur qui derive sur zone vide,
// mouseup sans mutation relle, etc.) on payait le cout de re-stroker
// toutes les formes + toutes les lignes de la grille.
//
// Le nouveau pipeline separe la SCENE STABLE (tout ce qui depend de
// state.shapes / state.ctx.zoomLevel-viewCenter / state.selectedPoints
// / state.selectedTriangles / state.GRID_STEP / state.activeGrid) de
// la SURFACE TRANSITOIRE (reticule + selectionBox, depend du runtime
// pas du modele). La scene stable est rendue une fois dans un canvas
// offscreen (offscreen board) puis blittee sur le visible via
// drawImage (= 1 memcpy GPU/CPU rapide). Le transitoire est repeint
// a chaque frame par-dessus (le reticule depend de la position du
// curseur, la selectionBox de la drag en cours).
//
// API publique ajoutee :
//   invalidateScene() : force le re-render offscreen au prochain
//     drawBoard. A appeler apres TOUT path qui mute la scene stable.
//     (Non obligatoire si on appelle requestDraw — voir ci-dessous.)
//   requestDraw() : coalesce via requestAnimationFrame (= au plus un
//     drawBoard par frame) + invalide la scene. Le chemin privilegie
//     pour les paths de mutation asynchrones (undo, drag mousemove,
//     wheel-zoom). Premier appel du frame pose le flag dirty, les
//     appels suivants sont coalesces ; le rAF callback voit un seul
//     drawBoard.
//   isSceneDirty() : introspection pour les tests / debug.

// Etat du cache offscreen. Le flag sceneDirty demarre a true pour
// que le premier appel de drawBoard repeint integralement l'offscreen.
// frameScheduled empeche les rafales d'appels requestDraw de
// multiplier les callbacks rAF (= 1 max en parallele).
let offscreen = null
let offCtx = null
let sceneDirty = true
let frameScheduled = false

// ===== HiDPI (devicePixelRatio) =====
//
// Rationale : voir DESIGN.md §2.7. Le bitmap du canvas est dimensionne
// en pixels PHYSIQUES (CSS x devicePixelRatio) pour un rendu net sur
// ecrans HiDPI, mais TOUTES les coordonnees internes (souris,
// hit-testing, state.ctx.center, modelToScreen, bornes grille/axes)
// restent en pixels CSS. La conversion se fait aux deux seules
// frontieres :
//   1. la taille du bitmap (main.js boot + resize) ;
//   2. la transform canvas posee ici (drawBoard / renderSceneToOffscreen)
//      qui projette les coords CSS sur le bitmap physique.
// getDevicePixelRatio est exporte pour main.js (sizing du bitmap) ;
// les helpers cssBoardW/H derivent la taille CSS du board depuis le
// bitmap physique (board.width = round(cssW x dpr)) et remplacent
// partout les lectures directes de state.board.width/height dans les
// bornes de dessin (grille, axes, reticle).
export const getDevicePixelRatio = () => (
    typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1
)

const applyDprTransform = (ctx) => {
    const dpr = getDevicePixelRatio()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

const cssBoardW = () => state.board.width / getDevicePixelRatio()
const cssBoardH = () => state.board.height / getDevicePixelRatio()

// Compteurs de charge de rendu effectif (cf. DESIGN.md §2.4). Pas de
// condition sur state.fpsVisible : l'incrementation est microscopique
// (deux entiers) etape partagee par tous les paths d'appel a
// drawBoard, visible ou pas. Le sampling (consumeDrawStats ci-dessous)
// n'est invoque que quand le HUD est actif, donc cout polling-only en
// idle = 0 (independamment des deux compteurs qui restent toujours
// presents dans draw.js).
let statsRedraws = 0
let statsOffscreen = 0

// Consomme les compteurs et les remet a zero : le sampling HUD lit
// toujours via ce helper (snapshot atomique + reset), jamais en
// lecture directe, pour eviter une race entre incrementation dans
// drawBoard et lecture dans la boucle d'echantillonnage.
export const consumeDrawStats = () => {
    const res = { redraws: statsRedraws, offscreen: statsOffscreen }
    statsRedraws = 0
    statsOffscreen = 0
    return res
}

export const invalidateScene = () => {
    sceneDirty = true
}

export const isSceneDirty = () => sceneDirty

export const requestDraw = () => {
    sceneDirty = true
    if (frameScheduled) return
    frameScheduled = true
    requestAnimationFrame(() => {
        frameScheduled = false
        drawBoard()
    })
}

const ensureOffscreen = () => {
    if (offscreen) return
    offscreen = document.createElement('canvas')
    offCtx = offscreen.getContext('2d')
    sceneDirty = true
}

const syncOffscreenSize = () => {
    if (!offscreen) return
    const w = state.board.width
    const h = state.board.height
    if (offscreen.width !== w || offscreen.height !== h) {
        offscreen.width = w
        offscreen.height = h
        sceneDirty = true
    }
}

// renderSceneToOffscreen : repeint la scene stable dans l'offscreen.
// Les draw* helpers lisent/ecrivent `state._ctx`, donc on swappe
// temporairement vers offCtx le temps du rendu puis on restaure via
// try/finally (defense : un helper qui throw ne casserait pas le
// pipeline global).
const renderSceneToOffscreen = () => {
    // (feature/performance opt #1) — instrumentation dev pour comparer
    // le cout offscreen avant/apres batching dans Chrome devtools
    // (console.time agrege min/max/avg/x). Label stable 'renderScene' :
    // juxtaposeable avec #fpsDisplay (redraws/s, offscreen/s), qui doit
    // montrer la MEME charge de travail (memes triggers d'invalidation,
    // meme nombre de cycles) — seule la duree par cycle devrait
    // chuter. Mesure volontaire sur CE path seul (vs renderTransient),
    // car c'est lui que le batching affecte : renderTransient n'a pas
    // de drawPoint dans son scope.
    //
    // Gatee par `state.debugRenderTime` (cf. state.js) — desactivee
    // par defaut pour eviter la pollution devtools en prod. Activation
    // runtime depuis la console navigateur : `state.debugRenderTime = true`.
    // Cout du check (typeof === 'undefined' = falsy) : 1 comparaison par
    // drawScene, negligible. try/finally garantit que timeEnd n'est pas
    // appele sans timeStart (defense, ne devrait pas arriver dans le
    // pipeline normal).
    if (state.debugRenderTime) console.time('renderScene')
    const visibleCtx = state._ctx
    state._ctx = offCtx
    try {
        // Transform dpr : le rendu offscreen est exprime en pixels CSS
        // (modelToScreen / bornes cssBoardW-H) ; la transform le projette
        // sur le bitmap physique (offscreen.width = round(cssW x dpr)).
        applyDprTransform(offCtx)
        offCtx.fillStyle = CANVAS_BACKGROUND
        offCtx.fillRect(0, 0, cssBoardW(), cssBoardH())
        // Preview (mode visualisation seule) : la scene stable est
        // reduite a la geometrie — pas de grille, pas d'axes, pas de
        // points selectionnes. Les points de controle (vertex dots)
        // sont sautes dans drawShape (pass vertex). L'invalidation du
        // cache offscreen est garantie par applyPreviewMode (requestDraw).
        // Rationale : voir DESIGN.md §2.6
        if (!state.previewMode) {
            if (state.activeGrid) drawGrid()
            drawAxis()
        }
        drawShapes()
        if (!state.previewMode) drawSelectedPoints()
    } finally {
        state._ctx = visibleCtx
    }
    if (state.debugRenderTime) console.timeEnd('renderScene')
}

// renderTransient : dessine SUR le visible les calques transitoires
// qui dependent du runtime (et non du modele). Toujours repeint a
// chaque drawBoard parce que reticule / selectionBox peuvent bouger
// entre deux frames meme si la scene stable est inchangee.
const renderTransient = () => {
    // Preview : aucun calque transitoire — le reticule et la box de
    // selection sont des aides d'edition, pas de la geometrie.
    // Rationale : voir DESIGN.md §2.6
    if (state.previewMode) return
    if (typeof state.reticleMode !== 'undefined' && state.reticleMode > 0) drawReticle()
    if (
        typeof state.isSelectingBox !== 'undefined' &&
        state.isSelectingBox &&
        state.selectionBoxStart &&
        state.selectionBoxCurrent
    ) {
        drawSelectionBox(state.selectionBoxStart, state.selectionBoxCurrent)
    }
    // Mode cercle : previsualisation du cercle en cours de tracé. Le
    // geste est transitoire (ne depend que du curseur + de l'etat
    // circleCenterModel/circleRadiusModel), pas du modele — il vit ici
    // et non dans l'offscreen de la scene stable.
    if (state.circleMode && state.circleCenterModel) drawCirclePreview()
    // Forme predéfinie armee (panneau #shapes) : meme principe —
    // previsualisation transitoire du geste en cours.
    if (state.shapeKind !== undefined && state.shapeAnchorModel) drawShapeToolPreview()
}

// ===== Previews transitoires de creation (cercle + formes) =====

// Socle radial partage (cercle + formes radiales) : cercle vrai en
// pointilles (frontiere du disque approxime) + ligne de rayon +
// marqueur de centre, en pixels ecran.
const drawRadialBase = (center, radius) => {
    const sp = modelToScreen(center)
    const zoom = state.ctx.zoomLevel
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, radius * zoom, 0, TAU)
    state._ctx.stroke()
    state._ctx.setLineDash([])
    state._ctx.beginPath()
    state._ctx.moveTo(sp.x, sp.y)
    state._ctx.lineTo(sp.x + radius * zoom, sp.y)
    state._ctx.stroke()
    state._ctx.beginPath()
    state._ctx.arc(sp.x, sp.y, 3, 0, TAU)
    state._ctx.stroke()
}

// Polyline fermee a travers des points SCREEN (outline du polygone
// genere) — les sommets sont calcules en model coords avec la MEME
// formule que la creation puis projetés (Y inverse gere par
// modelToScreen) : WYSIWYG strict entre la preview et le commit.
const strokeScreenPolyline = (pts) => {
    if (!pts || pts.length === 0) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
    state._ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
        if (i === 0) state._ctx.moveTo(pts[i].x, pts[i].y)
        else state._ctx.lineTo(pts[i].x, pts[i].y)
    }
    state._ctx.closePath()
    state._ctx.stroke()
}

// Previsualisation du cercle en cours de tracé (mode cercle) :
// dessinee dans le calque transitoire pour suivre le curseur a chaque
// repaint sans invalider le cache offscreen. Montre ce qui SERA
// genere : le cercle vrai (arc en pointilles) + le polygone des N
// cotes (la frontiere de l'eventail de triangles) + la ligne de rayon
// + le marqueur de centre.
const drawCirclePreview = () => {
    const center = state.circleCenterModel
    const r = state.circleRadiusModel
    if (!center || r <= 0) return
    const n = Math.max(3, Math.round(state.circleSegments) || 24)
    const rim = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        rim.push(modelToScreen({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }))
    }
    drawRadialBase(center, r)
    strokeScreenPolyline(rim)
}

// Previsualisation de la forme predéfinie armee (panneau #shapes) :
// WYSIWYG strict avec la creation — rectangle/carre = contour des 2
// coins (le carre applique la meme regle max(|dx|,|dy|) que la
// creation), polygones reguliers = socle radial du n-cote, etoile =
// contour des sommets alternes exterieur/interieur.
const drawShapeToolPreview = () => {
    const kind = state.shapeKind
    const anchor = state.shapeAnchorModel
    const current = state.shapeCurrentModel
    const radius = state.shapeRadiusModel
    if (!kind || !anchor || !current || radius <= 0) return
    if (kind === 'rect' || kind === 'square') {
        let c2 = current
        if (kind === 'square') {
            const dx = current.x - anchor.x
            const dy = current.y - anchor.y
            const side = Math.max(Math.abs(dx), Math.abs(dy))
            c2 = { x: anchor.x + (dx < 0 ? -side : side), y: anchor.y + (dy < 0 ? -side : side) }
        }
        const s1 = modelToScreen(anchor)
        const s2 = modelToScreen(c2)
        state._ctx.setLineDash([4, 4])
        state._ctx.strokeStyle = COLOR_CIRCLE_PREVIEW
        state._ctx.beginPath()
        state._ctx.rect(
            Math.min(s1.x, s2.x),
            Math.min(s1.y, s2.y),
            Math.abs(s2.x - s1.x),
            Math.abs(s2.y - s1.y),
        )
        state._ctx.stroke()
        return
    }
    if (kind === 'star') {
        const n = SHAPE_STAR_POINTS
        const rInner = SHAPE_STAR_INNER_RATIO * radius
        const pts = []
        for (let i = 0; i < n; i++) {
            const aOuter = (i / n) * TAU - Math.PI / 2
            const aInner = ((i + 0.5) / n) * TAU - Math.PI / 2
            pts.push(modelToScreen({ x: anchor.x + radius * Math.cos(aOuter), y: anchor.y + radius * Math.sin(aOuter) }))
            pts.push(modelToScreen({ x: anchor.x + rInner * Math.cos(aInner), y: anchor.y + rInner * Math.sin(aInner) }))
        }
        drawRadialBase(anchor, radius)
        strokeScreenPolyline(pts)
        return
    }
    // Polygones reguliers (triangle, pentagone, hexagone) : meme
    // preview que le cercle avec N fixe.
    const n = { tri: 3, penta: 5, hexa: 6 }[kind]
    const rim = []
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        rim.push(modelToScreen({ x: anchor.x + radius * Math.cos(a), y: anchor.y + radius * Math.sin(a) }))
    }
    drawRadialBase(anchor, radius)
    strokeScreenPolyline(rim)
}

export const drawBoard = () => {
    // Increments inconditionnels des compteurs de charge de rendu
    // effectif (cf. DESIGN.md §2.4). Cout negligeable (deux `++`) ;
    // ne pas conditionner sur state.fpsVisible pour eviter une
    // branche dans le chemin chaud de rendu.
    statsRedraws++
    // Transform dpr sur le visible (invariant) : toutes les coords
    // internes sont en pixels CSS ; la transform les projette sur le
    // bitmap physique. Posee ici et JAMAIS retiree — les overlays de
    // editor.js (hover, drawMouse) dessinent sur state._ctx APRES
    // drawBoard et s'appuient sur cette transform active.
    applyDprTransform(state._ctx)
    ensureOffscreen()
    syncOffscreenSize()
    if (sceneDirty) {
        statsOffscreen++
        renderSceneToOffscreen()
        sceneDirty = false
    }
    // Blit offscreen → visible en une seule operation. Le cache
    // offscreen est en pixels PHYSIQUES (offscreen.width = board.width) ;
    // on le dessine dans une boite de destination CSS px (cssBoardW-H) :
    // la transform dpr le retablit en 1:1 physique — aucun upscale ni
    // downscale du cache.
    state._ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, cssBoardW(), cssBoardH())
    renderTransient()
}

// (modifyShapeModel-spec §3.7) : avec state.selectedPoints
// = indices dans activeShape().pointList (Q1c), chaque entree du
// tableau est un nombre, pas une ref JS. On resout via
// pointList[idx] avant de deleguer au drawPoint. Indices non-
// integer ou hors range sont ignores (defense — ne devrait pas
// arriver dans le pipeline normal post-spec-merge-compact).
export const drawSelectedPoints = () => {
    if (typeof state.selectedPoints === 'undefined' || !state.selectedPoints || state.selectedPoints.length === 0) return
    let isDimmed = typeof state.isSelectionDimmed !== 'undefined' && state.isSelectionDimmed
    let color = isDimmed ? COLOR_SELECTED_POINT_DIMMED : COLOR_SELECTED_POINT
    const pointList = state.shapes[state.activeShapeIndex]?.pointList || []
    // (feature/performance opt #1) — meme batching que drawShape : on
    // resout les indices selectedPoints vers coords (defenses
    // Number.isInteger et !p preservees) puis on delegue a
    // drawPointsBatch pour 1 seul beginPath/stroke au lieu de N.
    const resolved = []
    state.selectedPoints.forEach((idx) => {
        if (!Number.isInteger(idx)) return
        const p = pointList[idx]
        if (!p) return
        resolved.push(p)
    })
    drawPointsBatch(resolved, 6, color)
}

export const drawSelectionBox = (p1, p2) => {
    if (!p1 || !p2) return
    let x = Math.min(p1.x, p2.x)
    let y = Math.min(p1.y, p2.y)
    let w = Math.abs(p2.x - p1.x)
    let h = Math.abs(p2.y - p1.y)
    state._ctx.fillStyle = COLOR_SELECTION_BOX_FILL
    state._ctx.fillRect(x, y, w, h)
    state._ctx.strokeStyle = COLOR_SELECTION_BOX_STROKE
    state._ctx.setLineDash([4, 4])
    state._ctx.strokeRect(x, y, w, h)
    state._ctx.setLineDash([])
}

export const drawAxis = () => {
    let originScreenX = state.ctx.center.x + (0 - state.ctx.viewCenter.x) * state.ctx.zoomLevel
    let originScreenY = state.ctx.center.y - (0 - state.ctx.viewCenter.y) * state.ctx.zoomLevel
    // Bornes en pixels CSS (cf. §2.7) : le bitmap est en pixels
    // physiques, mais le dessin est exprime en CSS px sous transform dpr.
    let w = cssBoardW()
    let h = cssBoardH()
    state._ctx.setLineDash(PATTERN_AXIS)
    state._ctx.strokeStyle = COLOR_AXIS
    if (originScreenY >= 0 && originScreenY <= h) {
        state._ctx.beginPath()
        state._ctx.moveTo(0, originScreenY)
        state._ctx.lineTo(w, originScreenY)
        state._ctx.stroke()
    }
    if (originScreenX >= 0 && originScreenX <= w) {
        state._ctx.beginPath()
        state._ctx.moveTo(originScreenX, 0)
        state._ctx.lineTo(originScreenX, h)
        state._ctx.stroke()
    }
}

// Calcule le centroide (moyenne des coords deduped par index) des
// points engages dans le grab en cours. Sert d'ancre au reticule
// mode 2 (projection symetrique) pendant la drag : reflete en
// temps reel la position de l'entite manipulee (cf. spec
// « pendant le clic-droit en position down, le reticule se
// positionne automatiquement sur le point manipule »).
// Retourne null si grabbedGroup vide (cas idle / post-endGrabbing)
// ou si tous les indices resolvent vers undefined (defense contre
// formes corrompues post-rebase).
const grabbedReticleAnchor = () => {
    if (!Array.isArray(state.grabbedGroup) || state.grabbedGroup.length === 0) return null
    if (state.moveAllActive) return null
    const seen = new Set()
    let sumX = 0, sumY = 0, count = 0
    state.grabbedGroup.forEach((item) => {
        const key = item.shapeIndex + ':' + item.pointIndex
        if (seen.has(key)) return
        seen.add(key)
        const pt = state.shapes[item.shapeIndex] && state.shapes[item.shapeIndex].pointList && state.shapes[item.shapeIndex].pointList[item.pointIndex]
        if (!pt) return
        sumX += pt.x
        sumY += pt.y
        count++
    })
    if (count === 0) return null
    return { x: sumX / count, y: sumY / count }
}

export const drawReticle = () => {
    if (typeof state.reticleMode === 'undefined' || state.reticleMode === 0) return
    // Selection de l'ancre : mode 2 (« projection symétrique »)
    // gagne le comportement spec clic-droit « pendant la drag, le
    // reticule se positionne sur le point manipule ». Resolution :
    //   1. Mode 2 + grabbedGroup non-vide + !moveAllActive : ancre =
    //      centroide deduped des indices grabbedGroup (calcule depuis
    //      state.shapes[item.shapeIndex].pointList[item.pointIndex] =
    //      position live, donc reflette la drag en temps reel).
    //   2. Sinon : ancre = curseur (comportement historique).
    //
    // Cas d'usage AltGr : `state.moveAllActive` court-circuite la
    // branche 1 (la « point manipule » est ambigu : tout les points
    // bougent, le pivot de rotation suit le curseur cf. §6.2 ;
    // laisser le reticule sur le curseur preserve la coherence avec
    // la rotation AltGr).
    //
    // Cas release : `endGrabbing` vide grabbedGroup -> branche 2
    // reprend la main, reticule retourne au curseur (spec « le
    // reticule ensuite à la position du curseur quand on relache »).
    let m = null
    if (state.reticleMode === 2) {
        m = grabbedReticleAnchor()
    }
    if (!m) {
        if (typeof state.lastMousePos === 'undefined' || !state.lastMousePos) return
        m = screenToModel(state.lastMousePos)
        if (!m) return
    }
    let positions = [{ x: m.x, y: m.y }]
    if (state.reticleMode === 2) {
        positions.push({ x: -m.x, y: m.y })
        positions.push({ x: m.x, y: -m.y })
        positions.push({ x: -m.x, y: -m.y })
    }
    state._ctx.setLineDash(PATTERN_AXIS)
    state._ctx.strokeStyle = COLOR_RETICLE
    positions.forEach((pos) => {
        let sp = modelToScreen(pos)
        // Bornes en pixels CSS (cf. §2.7) : le bitmap est en pixels
        // physiques, le dessin en CSS px sous transform dpr.
        if (sp.y >= 0 && sp.y <= cssBoardH()) {
            state._ctx.beginPath()
            state._ctx.moveTo(0, sp.y)
            state._ctx.lineTo(cssBoardW(), sp.y)
            state._ctx.stroke()
        }
        if (sp.x >= 0 && sp.x <= cssBoardW()) {
            state._ctx.beginPath()
            state._ctx.moveTo(sp.x, 0)
            state._ctx.lineTo(sp.x, cssBoardH())
            state._ctx.stroke()
        }
    })
}

export const drawShapes = () => {
    if (
        typeof state.shapes === 'undefined' ||
        !Array.isArray(state.shapes) ||
        state.shapes.length === 0
    ) return
    for (let i = 0; i < state.shapes.length; i++) {
        if (i === state.activeShapeIndex) continue
        drawShape(state.shapes[i], false)
    }
    drawShape(state.shapes[state.activeShapeIndex], true)
}

// (modifyShapeModel-spec §3.7) : le tableau est `tris` ,
// les slots p1/p2/p3 sont des indices dans shape.pointList. On resout
// les coordonnees via pointList[t.pX] avant de deleguer a drawTriangle /
// drawPoint. Les slots `undefined` (Q1b triangles partiels) sont
// correctement filtres — drawTriangle gere deja le cas p1 absent / p2
// absent / p3 absent, et drawPoint ignore les coords absents (guard
// `if (!p) return`).
export const drawShape = (shape, isActive) => {
    if (!shape || !Array.isArray(shape.tris) || shape.tris.length === 0) return
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    let lineColor = isActive ? COLOR_LINES : COLOR_LINES_INACTIVE
    let linePattern = isActive ? PATTERN_LINES : PATTERN_LINES_INACTIVE
    let pointColor = isActive ? POINT_COLOR_ACTIVE : POINT_COLOR_INACTIVE

    // (feature/performance opt #3) — decomposition en 3 passes au lieu
    // d'appeler drawTriangle par tri (= N beginPath + N stroke + N fill).
    // Avant : pour N tris, on cumulait jusqu'a 3N beginPath/stroke cycles
    // API canvas (1 drawTriangle = 1 beginPath, parfois 1 fill, 1 stroke ;
    // sommation sur N = 3N path-state transitions sur le hot path machine).
    // Apres : 3 passes par shape :
    //   1. fill pass  (active shape seulement) : regroupe les tris par
    //      couleur de fill (key = t.fill ou COLOR_TRIANGLE_FILL_ACTIVE
    //      par defaut) et trace 1 beginPath + sub-paths moveTo/lineTo/closePath
    //      + 1 fill() par groupe de couleur (= K groupements, K = nombre
    //      de couleurs distinctes sur la forme ; 1 en pratique si tous
    //      default, 2-5 max en multi-coloration manuelle).
    //   2. stroke pass (tous les tris, completes et partiels) : 1 beginPath
    //      couvrant TOUS les tris de la shape, sub-paths moveTo/lineTo/
    //      closePath empiles dans l'ordre source, 1 stroke() final. Le
    //      setLineDash + setStrokeStyle sont fixes une seule fois pour
    //      la shape (= meme pattern + meme couleur par shape).
    //   3. vertex pass : drawPointsBatch sur tous les vertex collectes,
    //      delivre de opt #1. Preserved tel quel.
    //
    // resolvedTris : single source of truth — on resout une seule fois
    // les indices pointList en coords (defenses Number.isInteger + !p
    // preservees ; fill = isActive ? (t.fill !== undefined ? t.fill :
    // COLOR_TRIANGLE_FILL_ACTIVE) : undefined) et chaque passe itere
    // ce pre-calcule. Evite la double resolution (2 iterations de
    // shape.tris entraineraient 2 lookups pointList[t.pX] par tri).
    const vertexPoints = []
    const resolvedTris = []
    shape.tris.forEach((t) => {
        const p1 = Number.isInteger(t.p1) ? pointList[t.p1] : undefined
        const p2 = Number.isInteger(t.p2) ? pointList[t.p2] : undefined
        const p3 = Number.isInteger(t.p3) ? pointList[t.p3] : undefined
        const fill = isActive ? (t.fill !== undefined ? t.fill : COLOR_TRIANGLE_FILL_ACTIVE) : undefined
        if (p1) vertexPoints.push(p1)
        if (p2) vertexPoints.push(p2)
        if (p3) vertexPoints.push(p3)
        resolvedTris.push({ p1, p2, p3, fill })
    })

    // === Fill pass (active shape uniquement, tris completes uniquement) ===
    // Spec Canvas 2D : fill() applique le fillStyle courant a TOUS les
    // sub-paths formes depuis le dernier beginPath(). Si on mettait
    // plusieurs fillStyles dans un meme beginPath, le dernier fill()
    // repeindrait la totalite avec la derniere couleur (et les
    // precedents seraient perdus). On DOIT donc un beginPath par groupe
    // de couleur distincte. Groupage via Map<string, Array<r>> : K entries,
    // K = nombre de couleurs distinctes. Pour les formes avec tous les
    // tris en default fill (= cas typique mesh-wail), K = 1 = fill(x36)
    // -> fill(x1) (~36x de gain sur la sous-operation fill).
    if (isActive) {
        const fillGroups = new Map()
        for (let i = 0; i < resolvedTris.length; i++) {
            const r = resolvedTris[i]
            if (!r.fill || !r.p3) continue
            const arr = fillGroups.get(r.fill) || []
            arr.push(r)
            fillGroups.set(r.fill, arr)
        }
        for (const [color, tris] of fillGroups.entries()) {
            // SAFE-BELT (feature/performance opt #3 follow-up) :
            // detecter les windings inconsistantes en screen-space (apres
            // modelToScreen, qui flippe Y et inverse les cross-products
            // math). Si les tris d'un meme groupe de fill ont des signes
            // de winding heterogenes ou si l'un est degenere (cross = 0),
            // le fill batched sous fillRule=nonzero peut creer un trou
            // par annulation des winding counts (verifie empiriquement
            // par test manuel sur assets/mesh-overlap-test.json, forme 3
            // fan CCW autour d'un centre commun). Fallback : per-tri fill,
            // qui preserve le comportement de l'ancien drawTriangle
            // (chaque tri path-independant = pas d'interaction de winding).
            // Cout : N beginPath/fill au lieu d'1 pour ce groupe ; sur mesh
            // typique (windings uniformes en screen space, mesh-wail par
            // exemple) le chemin batched est preserve.
            const screenTris = tris.map((r) => {
                const s1 = modelToScreen(r.p1)
                const s2 = modelToScreen(r.p2)
                const s3 = modelToScreen(r.p3)
                return { r, s1, s2, s3 }
            })
            let uniformSign = true
            let firstSign = null
            let hasDegenerate = false
            for (let i = 0; i < screenTris.length; i++) {
                const t = screenTris[i]
                const cp = (t.s2.x - t.s1.x) * (t.s3.y - t.s1.y) - (t.s2.y - t.s1.y) * (t.s3.x - t.s1.x)
                if (cp === 0) { hasDegenerate = true; continue }
                const sign = cp > 0
                if (firstSign === null) firstSign = sign
                else if (sign !== firstSign) { uniformSign = false; break }
            }
            uniformSign = uniformSign && !hasDegenerate
            state._ctx.fillStyle = color
            if (uniformSign) {
                // BATCHED : 1 beginPath + sub-paths empiles + 1 fill. Gain
                // opt #3 preserve pour les groupes safe (mesh typique).
                state._ctx.beginPath()
                for (let i = 0; i < screenTris.length; i++) {
                    const t = screenTris[i]
                    state._ctx.moveTo(t.s1.x, t.s1.y)
                    state._ctx.lineTo(t.s2.x, t.s2.y)
                    state._ctx.lineTo(t.s3.x, t.s3.y)
                    state._ctx.closePath()
                }
                state._ctx.fill()
            } else {
                // PER-TRI (fallback) : un path par tri, fill sur chaque.
                // Aucune interaction de winding entre sub-paths = rendu
                // identique a l'ancien drawTriangle. Cout : N beginPath +
                // N fill cycles. Pas de batching fill pour ce groupe mais
                // le reste (stroke, vertex) reste batched.
                for (let i = 0; i < screenTris.length; i++) {
                    const t = screenTris[i]
                    state._ctx.beginPath()
                    state._ctx.moveTo(t.s1.x, t.s1.y)
                    state._ctx.lineTo(t.s2.x, t.s2.y)
                    state._ctx.lineTo(t.s3.x, t.s3.y)
                    state._ctx.closePath()
                    state._ctx.fill()
                }
            }
        }
    }

    // === Stroke pass (tous les tris, completes et partiels) ===
    // setLineDash + setStrokeStyle fixes une fois pour toute la shape :
    // les deux sont homogenees par shape (meme pattern/color par drawShape),
    // donc setter N fois dans la boucle etait un gaspillage. 1 beginPath
    // couvre tous les tris ; chaque tri ajoute moveTo + (lineTo si p2) +
    // (lineTo+closePath si p3). Le stroke() final trace toutes les
    // sub-paths en un seul appel GPU. Les tris partiels (p3 absent = en
    // cours de construction) ne ferment pas leur sub-path mais participent
    // au stroke global avec leur unique segment.
    state._ctx.setLineDash(linePattern)
    state._ctx.strokeStyle = lineColor
    state._ctx.beginPath()
    for (let i = 0; i < resolvedTris.length; i++) {
        const r = resolvedTris[i]
        if (!r.p1) continue
        const s1 = modelToScreen(r.p1)
        state._ctx.moveTo(s1.x, s1.y)
        if (r.p2) {
            const s2 = modelToScreen(r.p2)
            state._ctx.lineTo(s2.x, s2.y)
            if (r.p3) {
                const s3 = modelToScreen(r.p3)
                state._ctx.lineTo(s3.x, s3.y)
                state._ctx.closePath()
            }
        }
    }
    state._ctx.stroke()

    // Pass vertex = points de controle de l'edition (petits disques
    // sur chaque sommet). Sautes en preview : seule la geometrie
    // (lignes / fills) doit rester visible.
    // Rationale : voir DESIGN.md §2.6
    if (!state.previewMode) drawPointsBatch(vertexPoints, 2, pointColor)
}

export const drawTriangle = (p1, p2, p3, pattern, color, fill) => {
    if (!p1) return
    let s1 = modelToScreen(p1)
    state._ctx.setLineDash(pattern !== undefined ? pattern : PATTERN_LINES)
    state._ctx.strokeStyle = color !== undefined ? color : COLOR_LINES
    state._ctx.beginPath()
    state._ctx.moveTo(s1.x, s1.y)
    if (p2 !== undefined) {
        let s2 = modelToScreen(p2)
        state._ctx.lineTo(s2.x, s2.y)
        if (p3 !== undefined) {
            let s3 = modelToScreen(p3)
            state._ctx.lineTo(s3.x, s3.y)
            state._ctx.closePath()
            if (fill !== undefined) {
                state._ctx.fillStyle = fill
                state._ctx.fill()
            }
        }
    }
    state._ctx.stroke()
}

export const drawLine = (p1, p2, pattern, color) => {
    if (!p1 || !p2) return
    let s1 = modelToScreen(p1)
    let s2 = modelToScreen(p2)
    state._ctx.setLineDash(pattern)
    state._ctx.strokeStyle = color
    state._ctx.beginPath()
    state._ctx.moveTo(s1.x, s1.y)
    state._ctx.lineTo(s2.x, s2.y)
    state._ctx.stroke()
}

// ===== LOD grille (feature/performance opt #2) =====
// Seuil minimum d'espacement utile entre 2 lignes de grille voisines en
// pixels-ecran. En dessous, les lignes fusionnent en un bloc gris
// (aliasing per pixel) et le cout API canvas devient explosif pour rien :
// a zoom 0.1 / GRID_STEP 32, step_px = 3.2 ; le deuxieme for genere
// alors ~6000 moveTo+lineTo sur un canvas 1920px de large sans le moindre
// pixel distinct. Constante module-level (pas dans drawGrid) pour eviter
// une re-definition par appel (= V8 inline cache-friendly).
//
// Borne basse seulement : a zoom eleve (step > 100 px), la grille reste
// utile (8-15 lignes par viewport = grille lisible). Pas de borne haute,
// le loop n_min..n_max est deja borne par le viewport et trace au pire
// 2-3 lignes, sans risque quadratique.
const MIN_GRID_STEP_PX = 4

export const drawGrid = () => {
    const baseStep = typeof state.GRID_STEP !== 'undefined' ? state.GRID_STEP : 32
    if (!baseStep || baseStep <= 0) return
    const step = baseStep * state.ctx.zoomLevel
    if (step <= 0) return
    // (feature/performance opt #2) — elimine la grille quand l'espacement
    // est trop serre (< MIN_GRID_STEP_PX) pour eviter le cout quadratique
    // sur zoom-out extreme. Garde les defenses existantes (step <= 0,
    // baseStep <= 0) intactes. Pas d'invalidation de cache : si GRID_STEP
    // ou zoomLevel reviennent dans la plage visible, la prochaine
    // renderSceneToOffscreen repeint la grille normalement.
    if (step < MIN_GRID_STEP_PX) return
    state._ctx.setLineDash([])
    state._ctx.strokeStyle = COLOR_GRID
    state._ctx.beginPath()
    let originScreenX = state.ctx.center.x - state.ctx.viewCenter.x * state.ctx.zoomLevel
    let originScreenY = state.ctx.center.y + state.ctx.viewCenter.y * state.ctx.zoomLevel
    let n_min_x = Math.ceil(-originScreenX / step)
    // Bornes en pixels CSS (cf. §2.7) : le bitmap est en pixels
    // physiques, le dessin en CSS px sous transform dpr.
    let n_max_x = Math.floor((cssBoardW() - originScreenX) / step)
    for (let n = n_min_x; n <= n_max_x; n++) {
        let x_screen = originScreenX + n * step
        state._ctx.moveTo(x_screen, 0)
        state._ctx.lineTo(x_screen, cssBoardH())
    }
    let n_min_y = Math.ceil((originScreenY - cssBoardH()) / step)
    let n_max_y = Math.floor(originScreenY / step)
    for (let n = n_min_y; n <= n_max_y; n++) {
        let y_screen = originScreenY - n * step
        state._ctx.moveTo(0, y_screen)
        state._ctx.lineTo(cssBoardW(), y_screen)
    }
    state._ctx.stroke()
}
