// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    SCENE_STORAGE_KEY, GRID_STEP_STORAGE_KEY, ACTIVE_GRID_STORAGE_KEY,
    ZOOM_STORAGE_KEY, VIEW_CENTER_STORAGE_KEY,
    MIN_GRID_STEP, MAX_GRID_STEP, MIN_ZOOM, MAX_ZOOM,
    IMPORT_MODE_STORAGE_KEY, TAU,
    SCENE_FORMAT, SCENE_FORMAT_VERSION,
    MAX_HISTORY, UNDO_STORAGE_KEY,
    SAVED_SCENES_STORAGE_KEY, MAX_SAVED_SCENES,
} from './constants.js'
import { drawBoard, requestDraw } from './draw.js'
// Cycle io <-> viewport autorise : imports lus au call-time, jamais a l'evaluation.
import { updateZoomDisplay } from './viewport.js'
import { updateGridButtonText, updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateSceneStatus, showActionComment } from './hud.js'
import { log } from './log.js'
import { isSceneEmpty, adjacentPoints } from './geometry.js'

// ===== Serialisation (state -> JSON) =====

export const shapeToMesh = (shape) => {
    const pointList = []
    const tris = []
    if (!shape || typeof shape !== 'object') {
        log('shapeToMesh FALLBACK: shape absent ou invalide (' + (shape === undefined ? 'undefined' : typeof shape) + '). Serialisation videe pour cette forme, le reste de la scene est persiste normalement. Capture ce message pour identifier la mutation fautive.')
        return { pointList, tris }
    }
    // Runtime indexe ({ pointList, tris }) : validation des bornes puis passage tel quel.
    if (Array.isArray(shape.pointList) && Array.isArray(shape.tris)) {
        shape.pointList.forEach((p) => {
            if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
                pointList.push({ x: Number(p.x), y: Number(p.y) })
            }
        })
        shape.tris.forEach((t) => {
            if (!t || typeof t !== 'object' || Array.isArray(t)) return
            // Anti-leak (DESIGN §4.4) : un triangle partiel ne franchit pas
            // la frontiere io (jumelage avec buildShapesFromPayload).
            if (t.p1 === undefined || t.p2 === undefined || t.p3 === undefined) return
            const nt = {}
            if (Number.isInteger(t.p1) && t.p1 >= 0 && t.p1 < pointList.length) nt.p1 = t.p1
            if (Number.isInteger(t.p2) && t.p2 >= 0 && t.p2 < pointList.length) nt.p2 = t.p2
            if (Number.isInteger(t.p3) && t.p3 >= 0 && t.p3 < pointList.length) nt.p3 = t.p3
            if (typeof t.fill === 'string' && t.fill.length > 0) nt.fill = t.fill
            if (nt.p1 !== undefined && nt.p2 !== undefined && nt.p3 !== undefined) tris.push(nt)
        })
        return { pointList, tris }
    }
    // Legacy : shape.triangles = refs point inline -> collapse indexe (Q3b back-compat).
    if (!Array.isArray(shape.triangles)) {
        log('shapeToMesh FALLBACK: shape=' + JSON.stringify(shape) + ' (.triangles absent ou non-Array) => serialisation videe pour cette forme, le reste de la scene est persiste normalement. Capture ce message pour identifier la mutation fautive.')
        return { pointList, tris }
    }
    // Detecteur legacy : log une seule fois par session, incite au
    // re-save (la back-compat Q3b reste silencieuse).
    if (!legacyShapeDetected && shape.triangles.length > 0) {
        legacyShapeDetected = true
        log('shapeToMesh: fichier legacy detecte (shape.triangles inline-coord, pointList absent). Back-compat silencieux actif (spec §B Q3b). Re-sauvegardez ce mesh dans le nouveau format {pointList, tris} pour migrer.')
    }
    const pointMap = new Map()
    shape.triangles.forEach(t => {
        if (!t.p1 || !t.p2 || !t.p3) return
        const indices = { p1: undefined, p2: undefined, p3: undefined }
        const pidArray = ['p1', 'p2', 'p3']
        pidArray.forEach(pid => {
            const p = t[pid]
            if (!p) return
            const key = p.x + ',' + p.y
            if (!pointMap.has(key)) {
                pointMap.set(key, pointList.length)
                pointList.push({ x: p.x, y: p.y })
            }
            indices[pid] = pointMap.get(key)
        })
        const tri = { p1: indices.p1, p2: indices.p2, p3: indices.p3 }
            if (typeof t.fill === 'string' && t.fill.length > 0) tri.fill = t.fill
            tris.push(tri)
    })
    return { pointList, tris }
}

// Rationale : voir DESIGN.md §3.5
export const snapZoom = (z) => Math.round(z * 10) / 10

// Basename sans extension : le nom de scene adopte le nom du fichier
// source (l'utilisateur nomme ses fichiers avant import).
const stripFileExtension = (fileName) => {
    if (typeof fileName !== 'string') return ''
    return fileName.replace(/\.[^.]+$/, '')
}

// ===== Scene dirty baseline =====
// sceneDirty = la scene a diverge du dernier evenement clean (save /
// load / import / reset), materialise comme fingerprint JSON de
// state.shapes ; recalcul par comparaison apres undo/redo.

// Capture la baseline courante (fingerprint string, pas de clone :
// partage entre plusieurs call sites qui ne consomment pas le shape)
// et force sceneDirty = false. Idempotent.
export const captureSceneBaseline = () => {
    state.sceneBaselineFingerprint = JSON.stringify(state.shapes)
    state.sceneDirty = false
    updateSceneStatus()
}

// dirty = comparaison au baseline (apres undo/redo) ; baseline vide =
// dirty=true (cas defensif, inatteignable des le boot).
export const recomputeSceneDirty = () => {
    if (!state.sceneBaselineFingerprint) {
        state.sceneDirty = true
    } else {
        state.sceneDirty = JSON.stringify(state.shapes) !== state.sceneBaselineFingerprint
    }
    updateSceneStatus()
}

export const serializeState = () => {
    return JSON.stringify({
        format: SCENE_FORMAT,
        version: SCENE_FORMAT_VERSION,
        name: state.sceneName,
        activeGrid: state.activeGrid,
        GRID_STEP: state.GRID_STEP,
        shapes: state.shapes.map(shapeToMesh),
        activeShapeIndex: state.activeShapeIndex,
        zoomLevel: state.ctx.zoomLevel,
        viewCenter: { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y },
    })
}

// ===== Persistance undo/redo =====
// L'historique est persiste dans UNDO_STORAGE_KEY, ecrit dans le MEME
// appel synchrone que la scene (cles coherentes). Garde-fous :
//   - flag `undoPersistDirty` : l'ecriture n'a lieu que quand les
//     piles changent (les zoom/pan en continu ne re-serialisent pas) ;
//   - fingerprint `scene` compare au boot : si la scene restauree
//     differe, les entries sont ignorees (cf. DESIGN.md §5.4).
// Flag module-scope (donnee de persistance interne, pas d'etat applicatif).
let undoPersistDirty = false

// Pose le flag « les piles ont change » (history.js saveState/undo/redo,
// import MERGE — qui conserve les piles mais rafraichit le fingerprint).
export const markUndoPersistDirty = () => {
    undoPersistDirty = true
}

// Efface l'historique persiste (reset / import REPLACE) et neutralise
// le flag (la persistState suivante ne doit pas re-ecrire la cle).
const clearPersistedUndo = () => {
    undoPersistDirty = false
    try { localStorage.removeItem(UNDO_STORAGE_KEY) } catch (e) { /* ignore */ }
}

export const persistState = () => {
    try {
        state.shapes.forEach((shape, i) => {
            const v = validateShape(shape)
            if (!v.ok) log('persistState: shape #' + i + ' — ' + v.errors.length + ' erreur(s): ' + JSON.stringify(v.errors))
        })
        const sceneJson = serializeState()
        localStorage.setItem(SCENE_STORAGE_KEY, sceneJson)
        state.ctx.workIsSaved = 1
        updateSceneStatus()
        // `sceneJson` reutilise tel quel pour le fingerprint (meme
        // string, meme instant -> restore fiable).
        if (undoPersistDirty) {
            try {
                localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify({
                    scene: sceneJson,
                    historyStack: state.historyStack,
                    redoStack: state.redoStack,
                }))
                undoPersistDirty = false
            } catch (e) {
                // Quota depasse typiquement : degradation silencieuse,
                // flag neutralise pour ne pas re-tenter a chaque zoom.
                undoPersistDirty = false
                log('Undo persist fail: ' + e.message)
            }
        }
    } catch (e) {
        log('Persist fail: ' + e.message)
    }
}

// ===== Restore (read from localStorage) =====

// Valide les indices tris ∈ [0, pointList.length), drop les tris invalides.
const resolveTrisToIndices = (trisArray, ptsLength) => {
    const ts = []
    if (!Array.isArray(trisArray)) return ts
    trisArray.forEach(t => {
        // Anti-leak (DESIGN §4.4) : triangle incomplet = fantome partiel, drop.
        const nt = {}
        if (Number.isInteger(t.p1) && t.p1 >= 0 && t.p1 < ptsLength) nt.p1 = t.p1
        if (Number.isInteger(t.p2) && t.p2 >= 0 && t.p2 < ptsLength) nt.p2 = t.p2
        if (Number.isInteger(t.p3) && t.p3 >= 0 && t.p3 < ptsLength) nt.p3 = t.p3
        if (typeof t.fill === 'string' && t.fill.length > 0) nt.fill = t.fill
        if (nt.p1 !== undefined && nt.p2 !== undefined && nt.p3 !== undefined) ts.push(nt)
    })
    return ts
}

const validateLegacyTriangle = (triangle, context) => {
    if (!triangle || typeof triangle !== 'object' || Array.isArray(triangle)) return `${context}: triangle invalide`
    for (const pid of ['p1', 'p2', 'p3']) {
        if (triangle[pid] === undefined) continue
        const point = triangle[pid]
        if (!point || typeof point !== 'object' || Array.isArray(point) || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
            return `${context}: sommet ${pid} invalide`
        }
    }
    return null
}

export const validateScenePayload = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'la racine JSON doit être un objet'
    if (data.format !== undefined && data.format !== SCENE_FORMAT) return 'format JSON inconnu'
    if (data.version !== undefined && (!Number.isInteger(data.version) || data.version > SCENE_FORMAT_VERSION)) return 'version JSON non supportée'
    if (Array.isArray(data.shapes)) {
        for (let i = 0; i < data.shapes.length; i++) {
            const shape = data.shapes[i]
            if (!shape || typeof shape !== 'object') return `forme ${i + 1} invalide`
            if (shape.pointList !== undefined && !Array.isArray(shape.pointList)) return `forme ${i + 1}: pointList invalide`
            if (shape.tris !== undefined && !Array.isArray(shape.tris)) return `forme ${i + 1}: tris invalide`
            if (shape.triangles !== undefined && !Array.isArray(shape.triangles)) return `forme ${i + 1}: triangles invalide`
            if (Array.isArray(shape.triangles)) {
                for (let j = 0; j < shape.triangles.length; j++) {
                    const legacyError = validateLegacyTriangle(shape.triangles[j], `forme ${i + 1}, triangle ${j + 1}`)
                    if (legacyError) return legacyError
                }
            }
            if (Array.isArray(shape.pointList)) {
                for (const p of shape.pointList) {
                    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return `forme ${i + 1}: sommet invalide`
                }
                if (Array.isArray(shape.tris)) {
                    for (const t of shape.tris) {
                        if (!t || ['p1', 'p2', 'p3'].some(pid => t[pid] !== undefined && (!Number.isInteger(t[pid]) || t[pid] < 0 || t[pid] >= shape.pointList.length))) return `forme ${i + 1}: indice de triangle invalide`
                    }
                }
            }
        }
    } else {
        if (data.pointList !== undefined && !Array.isArray(data.pointList)) return 'pointList invalide'
        if (data.tris !== undefined && !Array.isArray(data.tris)) return 'tris invalide'
        if (Array.isArray(data.pointList)) {
            for (const p of data.pointList) {
                if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return 'sommet invalide'
            }
            if (Array.isArray(data.tris)) {
                for (const t of data.tris) {
                    if (!t || ['p1', 'p2', 'p3'].some(pid => t[pid] !== undefined && (!Number.isInteger(t[pid]) || t[pid] < 0 || t[pid] >= data.pointList.length))) return 'indice de triangle invalide'
                }
            }
        }
    }
    return null
}

// Validation dev-only (invariants I1/I2/I3/I5 + fill string-only) ;
// O(N²) sur la duplication, acceptable < 1000 vertices. Ne throw
// jamais : { ok } ou { ok: false, errors } — loggue, jamais bloquant.
export const validateShape = (shape) => {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
        return { ok: false, errors: [{ kind: 'shape_missing' }] }
    }
    const errors = []
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    if (!Array.isArray(shape.pointList)) errors.push({ kind: 'pointList_missing' })
    if (!Array.isArray(shape.tris)) errors.push({ kind: 'tris_missing' })
    // I1 : out_of_bounds (slots pX non-entier ou hors range)
    tris.forEach((t, ti) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
            errors.push({ kind: 'tri_invalid', triIndex: ti })
            return
        }
        ;['p1', 'p2', 'p3'].forEach((pid) => {
            const idx = t[pid]
            if (idx === undefined) return
            if (!Number.isInteger(idx) || idx < 0 || idx >= pointList.length) {
                errors.push({ kind: 'out_of_bounds', triIndex: ti, slotId: pid, index: idx, size: pointList.length })
            }
        })
        // I5 : partial tri inverted (p1 absent avec p2/p3 presents,
        // ou p2 absent avec p3 present) — geometriquement impossible.
        if (t.p1 === undefined && (t.p2 !== undefined || t.p3 !== undefined)) {
            errors.push({
                kind: 'partial_inverted',
                triIndex: ti,
                missing: 'p1',
                present: ['p1', 'p2', 'p3'].filter(pid => t[pid] !== undefined)
            })
        }
        if (t.p2 === undefined && t.p3 !== undefined) {
            errors.push({
                kind: 'partial_inverted',
                triIndex: ti,
                missing: 'p2',
                present: ['p1', 'p2', 'p3'].filter(pid => t[pid] !== undefined)
            })
        }
        if (t.fill !== undefined && typeof t.fill !== 'string') {
            errors.push({ kind: 'fill_not_string', triIndex: ti, type: typeof t.fill })
        }
    })
    // I2 : orphelin — pointList non reference par aucun tri slot
    const refs = new Set()
    tris.forEach((t) => {
        if (!t || typeof t !== 'object') return
        ;['p1', 'p2', 'p3'].forEach((pid) => {
            if (Number.isInteger(t[pid]) && t[pid] >= 0 && t[pid] < pointList.length) refs.add(t[pid])
        })
    })
    pointList.forEach((_, idx) => {
        if (!refs.has(idx)) errors.push({ kind: 'orphan', pointIndex: idx })
    })
    // I3 : duplication (O(N²), bornee par la taille raisonnable des scenes)
    for (let i = 0; i < pointList.length; i++) {
        for (let j = i + 1; j < pointList.length; j++) {
            if (pointList[i] && pointList[j] && adjacentPoints(pointList[i], pointList[j], 0.01)) {
                errors.push({ kind: 'duplication', pointIndexA: i, pointIndexB: j })
            }
        }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

// Rehydrate le payload en { pointList, tris } ; le chemin legacy
// `shape.triangles` reste accepte (Q3b back-compat via shapeToMesh).
export const buildShapesFromPayload = (data) => {
    if (!data || typeof data !== 'object') return null
    const result = []
    if (Array.isArray(data.shapes)) {
        data.shapes.forEach(shape => {
            let pts = []
            let trisSource = undefined
            if (Array.isArray(shape.pointList)) {
                pts = shape.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = shape.tris
            } else if (Array.isArray(shape.triangles)) {
                const mesh = shapeToMesh(shape)
                pts = (mesh.pointList || []).map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = mesh.tris
            }
            result.push({ pointList: pts, tris: resolveTrisToIndices(trisSource, pts.length) })
        })
    } else {
        let pts = []
        if (Array.isArray(data.pointList)) {
            pts = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        result.push({ pointList: pts, tris: resolveTrisToIndices(data.tris, pts.length) })
    }
    if (result.length === 0) result = [{ pointList: [], tris: [] }]
    return result
}

// Rotation appliquee sur pointList (liste canonique, couvre deja les
// sommets partages) — pas besoin d'enumerer les slots triangulaires.
const applyPendingRotationToShapes = (shapeArray) => {
    if (!state.pendingRotation || !shapeArray || shapeArray.length === 0) return
    const angle = state.pendingRotation.angle
    const pivot = state.pendingRotation.pivot
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    shapeArray.forEach((shape) => {
        const pts = Array.isArray(shape.pointList) ? shape.pointList : []
        pts.forEach((p) => {
            if (!p) return
            const dx = p.x - pivot.x
            const dy = p.y - pivot.y
            p.x = pivot.x + dx * cos - dy * sin
            p.y = pivot.y + dx * sin + dy * cos
        })
    })
    state.pendingRotation = undefined
}

// Restaure la scene + prefs depuis localStorage (validation log-only :
// les guards Number.isInteger absorbent les invalides).
export const loadState = () => {
    const saved = localStorage.getItem(SCENE_STORAGE_KEY)
    if (!saved) {
        // Pas de sauvegarde : baseline = scene vide par defaut (capturee a la fin).
    } else {
        try {
            state.pendingRotation = undefined
            const data = JSON.parse(saved)
            const validationError = validateScenePayload(data)
            if (validationError) {
                log('Load fail: ' + validationError)
                // baseline = scene par defaut, capturee a la fin.
            } else {
                // Back-compat : anciens fichiers sans `name` -> default.
                if (typeof data.name === 'string' && data.name.length > 0) {
                    state.sceneName = data.name
                } else {
                    state.sceneName = 'nouvelleScene'
                }
                if (data.activeGrid !== undefined) state.activeGrid = !!data.activeGrid
                if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') {
                    state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
                }
                if (typeof data.zoomLevel === 'number' && data.zoomLevel > 0) {
                    state.ctx.zoomLevel = snapZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, data.zoomLevel)))
                }
                if (data.viewCenter && typeof data.viewCenter.x === 'number' && typeof data.viewCenter.y === 'number') {
                    state.ctx.viewCenter.x = data.viewCenter.x
                    state.ctx.viewCenter.y = data.viewCenter.y
                }
                if (typeof data.rotation === 'number' && Number.isFinite(data.rotation) && data.rotation !== 0) {
                    let r = data.rotation % TAU
                    if (r < 0) r += TAU
                    const pivot = { x: 0, y: 0 }
                    if (data.rotationPivot && typeof data.rotationPivot.x === 'number' && typeof data.rotationPivot.y === 'number' && Number.isFinite(data.rotationPivot.x) && Number.isFinite(data.rotationPivot.y)) {
                        if (data.rotationPivot.kind === 'model') {
                            pivot.x = data.rotationPivot.x
                            pivot.y = data.rotationPivot.y
                        } else {
                            pivot.x = state.ctx.viewCenter.x + (data.rotationPivot.x - state.ctx.center.x) / state.ctx.zoomLevel
                            pivot.y = state.ctx.viewCenter.y - (data.rotationPivot.y - state.ctx.center.y) / state.ctx.zoomLevel
                        }
                    }
                    state.pendingRotation = { angle: r, pivot }
                } else {
                    state.pendingRotation = undefined
                }
                const loaded = buildShapesFromPayload(data)
                if (loaded) {
                    state.activeConstructionTriangle = undefined
                    state.shapes = loaded
                    // Detection post-hydratation (log-only)
                    state.shapes.forEach((shape, i) => {
                        const v = validateShape(shape)
                        if (!v.ok) log('loadState: shape #' + i + ' — ' + v.errors.length + ' erreur(s): ' + JSON.stringify(v.errors))
                    })
                    if (typeof data.activeShapeIndex === 'number' && data.activeShapeIndex >= 0 && data.activeShapeIndex < state.shapes.length) {
                        state.activeShapeIndex = data.activeShapeIndex
                    } else {
                        state.activeShapeIndex = 0
                    }
                    applyPendingRotationToShapes(state.shapes)
                }
                state.ctx.workIsSaved = 1
                updateGridButtonText()
                updateShapeHud()
                // NB : captureSceneBaseline() est invoquee en bas de la fonction.
            }
        } catch (e) {
            state.pendingRotation = undefined
            log('Load fail: ' + e.message)
            // baseline = scene par defaut, capturee a la fin.
        }
    }
    // Historique restaure AVANT la baseline (serializeState du
    // fingerprint doit voir les shapes rehydrates).
    restoreUndoHistory()
    // Baseline inconditionnelle sur l'etat courant (restaure ou defaut).
    captureSceneBaseline()
    updateUndoRedoHud()
}

// Restaure l'historique au boot. Garde-fous : cle absente/corrompue =
// abandon silencieux ; fingerprint `scene` != scene rehydratee =
// abandon (des indices d'entries pointeraient faux) ; piles recoupees
// a MAX_HISTORY.
const restoreUndoHistory = () => {
    try {
        const raw = localStorage.getItem(UNDO_STORAGE_KEY)
        if (!raw) return
        const data = JSON.parse(raw)
        if (!data || typeof data !== 'object' || typeof data.scene !== 'string') return
        if (data.scene !== serializeState()) {
            log('Undo restore: historique ignore (scene differente du dernier undo enregistre)')
            return
        }
        if (!Array.isArray(data.historyStack) || !Array.isArray(data.redoStack)) return
        state.historyStack = data.historyStack.slice(0, MAX_HISTORY)
        state.redoStack = data.redoStack.slice(0, MAX_HISTORY)
        if (state.historyStack.length > 0 || state.redoStack.length > 0) {
            log('Undo restore: ' + state.historyStack.length + ' undo / ' + state.redoStack.length + ' redo')
        }
    } catch (e) {
        log('Undo restore fail: ' + e.message)
    }
}

const onBeforeUnload = () => {
    clearTimeout(state.persistTimer)
    try {
        const sceneJson = serializeState()
        localStorage.setItem(SCENE_STORAGE_KEY, sceneJson)
        // Miroir de persistState : flush des deux cles si flag en attente.
        if (undoPersistDirty) {
            localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify({
                scene: sceneJson,
                historyStack: state.historyStack,
                redoStack: state.redoStack,
            }))
            undoPersistDirty = false
        }
    } catch (e) { /* ignore */ }
}

export const wireBeforeUnload = () => {
    window.addEventListener('beforeunload', onBeforeUnload)
}

// ===== Emplacements d'enregistrement =====
// Noms de scenes deja sauvegardes (preference persistee, plus recent
// en premier, dedupliquee, bornee a MAX_SAVED_SCENES), hors du wire
// format ; la modale #saveModal se positionne sur le precedent.

export const getSavedSceneNames = () => {
    try {
        const raw = localStorage.getItem(SAVED_SCENES_STORAGE_KEY)
        const arr = raw ? JSON.parse(raw) : []
        if (!Array.isArray(arr)) return []
        return arr
            .filter(n => typeof n === 'string' && n.trim().length > 0)
            .slice(0, MAX_SAVED_SCENES)
    } catch (e) {
        return []
    }
}

const persistSavedSceneNames = (names) => {
    try {
        localStorage.setItem(SAVED_SCENES_STORAGE_KEY, JSON.stringify(names))
    } catch (e) {
        // Quota depasse typiquement : degradation silencieuse.
    }
}

// Enregistre un emplacement après une sauvegarde réussie : le nom passe
// en tête de liste (plus récent), les doublons sont retirés, la liste
// est bornée.
export const recordSavedSceneName = (name) => {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return
    const names = getSavedSceneNames().filter(n => n !== trimmed)
    names.unshift(trimmed)
    persistSavedSceneNames(names.slice(0, MAX_SAVED_SCENES))
}

// Assainit le nom de fichier telecharge (caracteres interdits -> « - ») ;
// le nom de scene « propre » reste inchange (HUD + wire format).
const sanitizeFileName = (name) => {
    const cleaned = String(name == null ? '' : name)
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    return cleaned.length > 0 ? cleaned : 'scene'
}

// ===== Save (export fichier) =====
// `name` (optionnel) = emplacement choisi : devient le nom de scene
// (wire format + fichier « <nom>.json ») ; sans argument, nom courant.
export const saveMesh = (name) => {
    try {
        const trimmed = typeof name === 'string' ? name.trim() : ''
        const current = (typeof state.sceneName === 'string' && state.sceneName.trim().length > 0)
            ? state.sceneName.trim()
            : 'nouvelleScene'
        const baseName = trimmed.length > 0 ? trimmed : current
        // Le nom de scene adopte l'emplacement avant la serialisation
        // (wire format) ; la scene locale est re-ecrite avec le nouveau
        // nom pour qu'un reload immediat le restaure.
        state.sceneName = baseName
        persistState()
        const fileName = sanitizeFileName(baseName)
        const blob = new Blob([serializeState()], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName + '.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        recordSavedSceneName(baseName)
        // Baseline = scene exportee (dirty = false) ; le HUD affiche le nouveau nom.
        captureSceneBaseline()
        log('Export OK: ' + a.download)
        showActionComment(`Ctrl+S pour ré-enregistrer sous « ${baseName} »`)
    } catch (e) {
        log('Export fail: ' + e.message)
    }
}

// ===== Import modal helpers =====

export const getStoredImportMode = () => {
    try {
        const v = localStorage.getItem(IMPORT_MODE_STORAGE_KEY)
        return v === 'replace' || v === 'merge' ? v : null
    } catch (e) {
        return null
    }
}

// Rationale : voir DESIGN.md §1.1
export const saveStoredImportMode = (mode) => {
    try {
        if (mode === 'replace' || mode === 'merge') {
            localStorage.setItem(IMPORT_MODE_STORAGE_KEY, mode)
        }
    } catch (e) { /* ignore */ }
}

let importModalShown = false

// Detecteur legacy (une fois par session, closure scope) : incite a
// re-sauvegarder en nouveau format {pointList, tris}.
let legacyShapeDetected = false

// Rationale : voir DESIGN.md §7.4
const showImportModal = (opts, callback) => {
    if (importModalShown) {
        callback(null)
        return
    }
    const modal = document.querySelector('#importModal')
    if (!modal) {
        log('Import modal absent, replace par defaut')
        callback({ mode: 'replace', remember: false })
        return
    }
    importModalShown = true
    state.lastFocusedElement = document.activeElement

    const info = document.querySelector('#importModalInfo')
    if (info) {
        info.textContent = 'Scene en cours : ' + opts.currentInfo + '\nScene a charger : ' + opts.importedInfo
    }

    const previousMode = getStoredImportMode()
    const defaultMode = (previousMode === 'replace' || previousMode === 'merge') ? previousMode : 'replace'
    const radios = modal.querySelectorAll('input[name="importMode"]')
    radios.forEach(r => { r.checked = (r.value === defaultMode) })

    const validateBtn = document.querySelector('#importModalValidate')
    const cancelBtn = document.querySelector('#importModalCancel')

    const cleanup = () => {
        modal.hidden = true
        modal.setAttribute('aria-hidden', 'true')
        if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
        state.lastFocusedElement = undefined
        document.removeEventListener('keydown', onKey)
        modal.removeEventListener('click', onBackdrop)
        if (validateBtn) validateBtn.removeEventListener('click', onValidate)
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel)
        importModalShown = false
    }
    const onValidate = () => {
        const radio = modal.querySelector('input[name="importMode"]:checked')
        const mode = (radio && radio.value === 'merge') ? 'merge' : 'replace'
        cleanup()
        callback({ mode })
    }
    const onCancel = () => {
        cleanup()
        callback(null)
    }
    const onKey = (e) => {
        if (e.key === 'Escape') onCancel()
    }
    const onBackdrop = (e) => {
        // Fermeture sur clic exterieur (backdrop ou modal elle-meme).
        if (e.target && (e.target === modal || (e.target.classList && e.target.classList.contains('modal-backdrop')))) {
            onCancel()
        }
    }

    if (validateBtn) validateBtn.addEventListener('click', onValidate)
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey)
    modal.addEventListener('click', onBackdrop)
    modal.hidden = false
    modal.setAttribute('aria-hidden', 'false')
    if (validateBtn) validateBtn.focus()
}

// ===== Import (text et file) =====

// Nom de scene a l'import : fichier source > nom du wire format >
// 'nouvelleScene'. Source unique (importMeshFromText + applyImport).
const resolveImportSceneName = (sourceName, parsed) => {
    if (typeof sourceName === 'string' && sourceName.length > 0) return sourceName
    if (parsed && typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name
    return 'nouvelleScene'
}

export const importMeshFromText = (text, sourceName) => {
    let parsed = null
    let loaded = null
    try {
        const data = JSON.parse(text)
        const validationError = validateScenePayload(data)
        if (validationError) {
            log('Import fail: ' + validationError)
            return false
        }
        parsed = data
        loaded = buildShapesFromPayload(data)
    } catch (e) {
        log('Import fail: ' + e.message)
        return false
    }

    const resolvedName = resolveImportSceneName(sourceName, parsed)

    if (isSceneEmpty()) {
        applyImport(parsed, loaded, 'replace', resolvedName)
        return true
    }

    const currentTriCount = state.shapes.reduce((a, s) => a + (s && s.tris ? s.tris.length : 0), 0)
    const importedTriCount = loaded.reduce((a, s) => a + (s && s.tris ? s.tris.length : 0), 0)
    const currentInfo = state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + currentTriCount + ' triangle' + (currentTriCount > 1 ? 's' : '')
    const importedInfo = loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + importedTriCount + ' triangle' + (importedTriCount > 1 ? 's' : '')
    showImportModal({ currentInfo, importedInfo }, (result) => {
        if (!result) {
            log('Import cancelled')
            return
        }
        saveStoredImportMode(result.mode)
        applyImport(parsed, loaded, result.mode, resolvedName)
    })
    return true
}

// clearHistory=false (import MERGE) : l'historique est CONSERVE (les
// entries referencent des indices < beforeCount, valides apres append) ;
// true (default) pour REPLACE / reset, qui reinitialisent tout.
const resetEphemeralState = (clearHistory = true) => {
    if (clearHistory) {
        state.historyStack = []
        state.redoStack = []
        // Presse-papiers = capture de la scene : vide au REPLACE (scene
        // remplacee = contenu perime), conserve au MERGE (scene presente).
        state.clipboard = undefined
    }
    state.selectedPoints = []
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    state.grabbedGroup = []
    state.currentAction = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    updateUndoRedoHud()
    updateSelectionHud()
}

export const applyImport = (parsed, loaded, mode, sourceName) => {
    if (mode === 'merge') {
        const beforeCount = state.shapes.length
        if (parsed.activeGrid !== undefined) state.activeGrid = !!parsed.activeGrid
        if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
        }
        loaded.forEach(s => state.shapes.push(s))
        // MERGE conserve le nom existant (on etend, on ne remplace pas)
        // et pose la baseline sur le resultat merge (dirty = false).
        applyPendingRotationToShapes(loaded)
        state.activeShapeIndex = beforeCount
        if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
            state.activeShapeIndex = Math.max(0, state.shapes.length - 1)
        }
        // MERGE conserve l'historique ; le flag force la re-ecriture de
        // la cle undo avec le NOUVEAU fingerprint (append de formes).
        resetEphemeralState(false)
        markUndoPersistDirty()
        persistState()
        captureSceneBaseline()
        updateGridButtonText()
        updateShapeHud()
        requestDraw()
        const totalTris = state.shapes.reduce((acc, s) => acc + (s && s.tris ? s.tris.length : 0), 0)
        log('Import merge OK: +' + loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + state.shapes.length + ' au total, ' + totalTris + ' triangles')
        showActionComment(
            `Ctrl+Z pour annuler l'import — les formes importées sont actives`
        )
        return true
    }

    state.shapes = loaded
    // REPLACE adopte le nom résolu (filename > wire-format name > default).
    state.sceneName = resolveImportSceneName(sourceName, parsed)
    applyPendingRotationToShapes(state.shapes)
    if (typeof parsed.activeShapeIndex === 'number' && parsed.activeShapeIndex >= 0 && parsed.activeShapeIndex < state.shapes.length) {
        state.activeShapeIndex = parsed.activeShapeIndex
    } else {
        state.activeShapeIndex = 0
    }
    if (parsed.activeGrid !== undefined) state.activeGrid = !!parsed.activeGrid
    if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
        state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
    }
    // REPLACE reinitialise l'undo (memoire + persiste) : un reload ne
    // doit pas ressusciter l'undo de l'ancienne scene.
    resetEphemeralState(true)
    clearPersistedUndo()
    persistState()
    // Baseline sur l'etat importe (dirty = false jusqu'a la prochaine mutation).
    captureSceneBaseline()
    updateGridButtonText()
    updateShapeHud()
    requestDraw()
    const totalTris = state.shapes.reduce((acc, s) => acc + (s && s.tris ? s.tris.length : 0), 0)
    log('Import OK: ' + state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + totalTris + ' triangle' + (totalTris > 1 ? 's' : ''))
    showActionComment(
        `La scène importée est active — cliquez sur un point pour le sélectionner`
    )
    return true
}

export const importMeshFromFile = (file) => {
    if (!file) return
    if (file.type !== 'application/json' && !file.name.match(/\.json$/i)) {
        log('Import fail: not a JSON file')
        return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
        // sourceName = basename sans extension (precedence filename vs wire-format).
        const sourceName = stripFileExtension(file.name)
        importMeshFromText(String(e.target.result), sourceName)
    }
    reader.onerror = () => log('Import fail: read error')
    reader.readAsText(file)
}

// ===== Reset =====

export const resetAll = () => {
    state.shapes = [{ pointList: [], tris: [] }]
    state.activeShapeIndex = 0
    state.selectedPoints = []
    state.selectedTriangles = []
    state.historyStack = []
    state.redoStack = []
    // Presse-papiers interne vide (capture de l'ancienne scene, perimee).
    state.clipboard = undefined
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.activeConstructionTriangle = undefined
    state.grabbedGroup = []
    state.currentAction = undefined
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    state.ctx.zoomLevel = 1
    state.ctx.viewCenter.x = 0
    state.ctx.viewCenter.y = 0
    state.ctx.rotationTracking = 0
    state.sceneName = 'nouvelleScene'
    // Reinit de l'undo en memoire ET persiste (un reload apres reset ne
    // doit pas ressusciter l'historique de l'ancienne scene).
    clearPersistedUndo()
    persistState()
    // Baseline = scene vide (dirty = false tant que rien n'est modifie).
    captureSceneBaseline()
    requestDraw()
    updateZoomDisplay()
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    log('Reset OK')
    showActionComment('Cliquez pour poser le 1er point de votre nouvelle scène')
}
