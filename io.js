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
// updateZoomDisplay est appele dans resetAll (rafraichit le HUD zoom
// apres le reset). Import explicite depuis viewport.js — cycle
// io <-> viewport autorise : les deux modules ne lisent les imports
// de l'autre qu'au call-time, jamais a l'evaluation du module.
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
    // Nouveau runtime (modifyShapeModel-spec §3.4) : shape deja
    // indexe ({ pointList, tris }). On valide les bornes et on laisse
    // passer tel quel — pas d'etape de collapse, le wire format est deja
    // aligne.
    if (Array.isArray(shape.pointList) && Array.isArray(shape.tris)) {
        shape.pointList.forEach((p) => {
            if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
                pointList.push({ x: Number(p.x), y: Number(p.y) })
            }
        })
        shape.tris.forEach((t) => {
            if (!t || typeof t !== 'object' || Array.isArray(t)) return
            // Anti-leak symetrique a resolveTrisToIndices (DESIGN §4.4) : un
            // triangle partiel (sans p1, p2 ou p3 — typique d'un triangle en
            // cours de dessin) ne franchit pas la frontiere io. Sinon,
            // localStorage contient des slots vides et DevTools laisse croire
            // a du contenu fantome. Defense in depth : jumelage avec
            // buildShapesFromPayload qui filtre a la rehydratation.
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
    // Runtime legacy (avant la migration {pointList, tris}) : shape.triangles tient des refs JS
    // point (coords inline). On collapse vers la forme indexee pour
    // serialiser. Cheminement reste ici en Q3b back-compat : si un
    // ancienne scene chargee en runtime persiste avant migration
    // complete, on ne casse pas la sortie.
    if (!Array.isArray(shape.triangles)) {
        log('shapeToMesh FALLBACK: shape=' + JSON.stringify(shape) + ' (.triangles absent ou non-Array) => serialisation videe pour cette forme, le reste de la scene est persiste normalement. Capture ce message pour identifier la mutation fautive.')
        return { pointList, tris }
    }
    // Phase 5 detecteur (spec §4 Phase 5 + §B Q3b) : shape legacy
    // detecte (shape.triangles inline-coord valide). Log une seule
    // fois par session — la decision Q3b preserve la back-compat
    // silencieusement pour ne pas casser les fichiers d_avant la migration {pointList, tris},
    // mais on previent l_utilisateur qu_un re-save migrera au nouveau
    // format {pointList, tris}.
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

// Filename -> basename sans extension. Le wire format JSON exporte
// `mesh-{timestamp}.json` (saveMesh) — sur reimport, le basename
// serait `mesh-1785093938339`, ce qui n'est PAS ce que veut
// l'utilisateur comme identifiant stable. On laisse le basename
// passer tel quel (cf. décision spec utilisateur « nomme d'apres le
// fichier dont elle provient ») ; l'utilisateur qui veut un nom
// stable doit nommer ses fichiers avant import.
const stripFileExtension = (fileName) => {
    if (typeof fileName !== 'string') return ''
    return fileName.replace(/\.[^.]+$/, '')
}

// ===== Scene dirty baseline =====
//
// `sceneDirty` reflete « la scene a diverge du dernier evenement
// clean (save / load / import / reset / undo-vers-clean) ». On
// materialise cet evenement clean comme un fingerprint JSON de
// `state.shapes` (= baseline). Toute mutation utilisateur passe
// par `saveState` (history.js) qui bascule dirty a `true`. Apres
// undo ou redo, dirty est recalcule par comparaison au baseline
// (gere aussi le cas partiel : save → modify → undo = matched
// baseline, dirty repasse a `false`).

// Capture la baseline courante et force sceneDirty = false.
// Idempotent : peut etre rappele apres n'importe quel evenement
// clean sans effet de bord.
// Cout : 1 JSON.stringify de state.shapes (proportionnel au nombre
// de points + tris, negligeable en pratique). Justification
// d'utiliser un string plutot qu'un cloneShape : la cle est
// partagee entre plusieurs call sites (persistState, undo, redo)
// dont la majorite ne consomme pas le shape — un fingerprint
// evite les N clones a chaque mutation triviale.
export const captureSceneBaseline = () => {
    state.sceneBaselineFingerprint = JSON.stringify(state.shapes)
    state.sceneDirty = false
    updateSceneStatus()
}

// Recompute sceneDirty via comparaison de l'etat courant au
// baseline. Utilise par history.undo / history.redo apres
// application d'une entry inverse / forward.
// Cas defensif : si la baseline n'a jamais ete capturee
// (= ''), on conserve dirty=true (un etat sans baseline n'est
// pas fiable comme « clean » — devrait etre inatteignable des
// le boot puisque loadState capture la baseline ou l'etat vide
// par defaut).
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

// ===== Persistance (write to localStorage) =====

// Phase 4 (modifyShapeModel-spec §A + §4 Phase 4 Q3c) : dev-only
// validation gate avant serialisation. Log-only — ne bloque jamais
// la persistance ; les downstream guards (shapeToMesh filtre les tris
// invalides, draw.js tolere les entrees corrompues via Number.isInteger)
// absorbent la corruption au prochain rendu.
// ===== Persistance undo/redo =====
// Rationale : voir DESIGN.md §5.4
//
// L'historique undo/redo est persiste dans une cle dediee
// (UNDO_STORAGE_KEY), ecrite dans le MEME appel synchrone que la
// scene : les deux cles restent coherentes (un crash ne peut pas
// s'intercaler entre les deux setItem). Deux garde-fous :
//   - le flag `undoPersistDirty` (pose par history.js saveState/
//     undo/redo et par l'import MERGE) limite l'ecriture aux moments
//     ou les piles changent — les zoom/pan, qui appellent
//     persistState en continu, ne re-serialisent jamais l'historique.
//   - le fingerprint `scene` (= le string serializeState ecrit dans
//     SCENE_STORAGE_KEY au meme instant) est compare au boot : si la
//     scene restauree differe (quota depasse sur l'ecriture undo,
//     onglets croises, ancien build), les entries sont ignorees plutot
//     que restaurees sur une scene qui ne leur correspond pas.
//
// Le flag est un `let` module-scope (et pas un champ de state) :
// c'est une donnee de persistance interne, pas un etat applicatif.
let undoPersistDirty = false

// Pose le flag « les piles ont change, la prochaine persistState
// doit re-ecrire UNDO_STORAGE_KEY ». Appele par history.js
// (saveState / undo / redo) et par l'import MERGE (qui conserve les
// piles mais doit rafraichir le fingerprint `scene` apres append).
export const markUndoPersistDirty = () => {
    undoPersistDirty = true
}

// Efface la copie persiste de l'historique (reset scene / import
// REPLACE). L'historique en memoire est gere par l'appelant
// (resetEphemeralState / resetAll). Le flag est aussi neutralise :
// la persistState suivante (ex. un zoom) ne doit pas re-ecrire une
// cle qu'on vient de retirer.
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
        // Historique undo/redo : ecrit uniquement si les piles ont
        // change depuis la derniere persistance (flag ci-dessus).
        // `sceneJson` est reutilise tel quel pour le fingerprint —
        // meme string, meme instant, donc restore fiable.
        if (undoPersistDirty) {
            try {
                localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify({
                    scene: sceneJson,
                    historyStack: state.historyStack,
                    redoStack: state.redoStack,
                }))
                undoPersistDirty = false
            } catch (e) {
                // Quota depasse typiquement : la scene est sauvee,
                // l'undo ne survivra pas au reload (degradation
                // silencieuse, loggee). Le flag est neutralise pour
                // eviter de re-tenter + re-logger a chaque zoom/pan.
                undoPersistDirty = false
                log('Undo persist fail: ' + e.message)
            }
        }
    } catch (e) {
        log('Persist fail: ' + e.message)
    }
}

// ===== Restore (read from localStorage) =====

// modifyShapeModel-spec §3.4 : les triangles runtime portent
// des INDICES dans le pointList de leur forme. resolveTrisToIndices
// valide chaque indice ∈ [0, pointList.length) et drop les tris
// invalides (defense contre payload malforme). Elle remplace
// resolveTrisToTriangles qui derefencait chaque indice vers un object
// point — plus pertinent depuis que le runtime est lui-meme indexe.
const resolveTrisToIndices = (trisArray, ptsLength) => {
    const ts = []
    if (!Array.isArray(trisArray)) return ts
    trisArray.forEach(t => {
        // Anti-leak triangles partiels (DESIGN §4.4) : un triangle sans
        // la totalite de ses 3 indices ne doit pas franchir la
        // frontiere io — sinon, la rehydratation laisse un fantome
        // partial pret a etre complete par le prochain addPoint,
        // bypassant le recalcul de state.nearestLine (cf. §4.3).
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

// Phase 4 (modifyShapeModel-spec §A + §4 Phase 4 Q3c) : dev-only
// validation helper. Categorie les erreurs selon les invariants I1
// (out_of_bounds), I2 (orphan), I3 (duplication), I5 (partial_inverted)
// et la grammaire du wire format (fill type string-only).
//
// Cout O(N²) pour la detection de duplication I3 — acceptable sur
// scenes de taille raisonable (< 1000 vertices : < 1M comparisons,
// < 100ms). Ne throw jamais : retourne { ok: true } ou
// { ok: false, errors }. Les wire sites (persistState + loadState)
// loggent les erreurs et laissent les downstream guards
// (Number.isInteger dans draw.js / editor.js, shapeToMesh filtre
// les tris invalides au prochain serialize) absorber la corruption.
//
// Spec §A categorie "shape_missing" : retourne directement cette
// erreur si shape absent / non-objet / array, sans scanner les
// autres invariants (qui seraient inexploitables sans shape valide).
export const validateShape = (shape) => {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
        return { ok: false, errors: [{ kind: 'shape_missing' }] }
    }
    const errors = []
    const pointList = Array.isArray(shape.pointList) ? shape.pointList : []
    const tris = Array.isArray(shape.tris) ? shape.tris : []
    if (!Array.isArray(shape.pointList)) errors.push({ kind: 'pointList_missing' })
    if (!Array.isArray(shape.tris)) errors.push({ kind: 'tris_missing' })
    // I1 : out_of_bounds (slots pX non-entier ou hors range [0, pointList.length))
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
        // I5 : partial tri inverted — p1 undefined mais p2/p3 presents,
        // ou p2 undefined mais p3 present. Geometriquement impossible
        // (invariant I5 : si p3 undefined, p1 et p2 sont forcement definis).
        // Spec §4.4 anti-leak bloque deja la persistence des partiels
        // donc cette erreur reste rare — protege contre les mutations
        // directes (devtools) ou les bugs actifs dans editor.js.
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
        // fill type : doit etre string ou undefined
        if (t.fill !== undefined && typeof t.fill !== 'string') {
            errors.push({ kind: 'fill_not_string', triIndex: ti, type: typeof t.fill })
        }
    })
    // I2 : orphelin — entry pointList non referencee par aucun tri slot
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
    // I3 : duplication (O(N²) — limitee a scenes < ~1000 vertices pour
    // eviter bottleneck sur les gros meshes).
    for (let i = 0; i < pointList.length; i++) {
        for (let j = i + 1; j < pointList.length; j++) {
            if (pointList[i] && pointList[j] && adjacentPoints(pointList[i], pointList[j], 0.01)) {
                errors.push({ kind: 'duplication', pointIndexA: i, pointIndexB: j })
            }
        }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

// (modifyShapeModel-spec §3.4) — le runtime produit directement
// { pointList, tris } (memes champs que le wire format), au lieu du
// collapse { triangles: [{p1,p2,p3 (point refs)}] } d'avant. Le chemin
// legacy `shape.triangles` reste accepte pour les fichiers anciens
// (decision Q3b silent back-compat) via une collapse via shapeToMesh.
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

// (modifyShapeModel-spec §3.4) — la rotation s'applique sur
// pointList (la liste canonique des sommets par forme), pas sur les
// refs des slots triangles. Meme resultat geometrique (chaque vertex
// tourne autour du pivot) mais sans enumeration des slots triangulaires
// puisque pointList[idx] couvre deja tous les sommets partages.
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

// Phase 4 (modifyShapeModel-spec §4 Phase 4) : detecte les scenes
// corrompues post-hydratation via validateShape. Log-only — ne
// modifie pas state.shapes (les downstream guards Number.isInteger
// dans draw.js / editor.js absorbent les invalides sans planter).
export const loadState = () => {
    const saved = localStorage.getItem(SCENE_STORAGE_KEY)
    if (!saved) {
        // Pas de sauvegarde en localStorage : la baseline sera
        // capturee a la fin = scene vide (l'etat par defaut de
        // state.js).
    } else {
        try {
            state.pendingRotation = undefined
            const data = JSON.parse(saved)
            const validationError = validateScenePayload(data)
            if (validationError) {
                log('Load fail: ' + validationError)
                // baseline = scene par defaut, capturee a la fin.
            } else {
                // restore du nom de scene (back-compat : anciens
                // fichiers sans `name` retombent sur le default).
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
                    // Phase 4 : detection post-hydratation
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
                // NB : captureSceneBaseline() est invoque en bas
                // de la fonction (= baseline = scene restauree ou,
                // en cas d'exceptions ci-dessus, scene par defaut).
            }
        } catch (e) {
            state.pendingRotation = undefined
            log('Load fail: ' + e.message)
            // baseline = scene par defaut, capturee a la fin.
        }
    }
    // Restauration de l'historique undo/redo persiste, AVANT la
    // capture de baseline : serializeState() (utilise par le
    // fingerprint) doit voir les shapes rehydrates. Le fingerprint
    // garantit que les entries restaurees correspondent bien a la
    // scene courante (cf. restoreUndoHistory).
    restoreUndoHistory()
    // Capture de baseline inconditionnelle : pose
    // sceneBaselineFingerprint sur l'etat courant (restaure ou
    // par defaut) et force sceneDirty = false. Garanti que la
    // baseline reste bien definie pour les recomputeSceneDirty
    // ulterieurs (cf. cas defensif dans recomputeSceneDirty si
    // fingerprint est vide).
    captureSceneBaseline()
    updateUndoRedoHud()
}

// Restaure l'historique undo/redo depuis UNDO_STORAGE_KEY au boot
// (appele uniquement par loadState). Garde-fous :
//   - cle absente / JSON corrompu / structure invalide → abandon
//     silencieux (l'etat par defaut state.js a deja vide les piles).
//   - fingerprint `scene` != serializeState() de la scene rehydratee
//     → les entries sont obsoletes (ecriture undo echouee sur quota,
//     onglets croises, scene remplacee par un autre onglet) →
//     abandon : on ne restaure jamais d'undo sur une scene qui ne
//     lui correspond pas (les indices d'entries pointeraient faux).
//   - les piles sont recoupees a MAX_HISTORY (defense in depth —
//     saveState plafonne deja a l'ecriture).
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
        // Miroir de persistState : si un flag est reste en attente
        // (fermeture avant le prochain persistState), on flushe les
        // deux cles ensemble pour garder le fingerprint coherent.
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
//
// Évolution « enregistrement scène » : l'enregistrement passe par une
// fenêtre de sélection de l'emplacement (modale #saveModal, modals.js)
// qui se positionne sur l'emplacement PRÉCÉDENT. Un emplacement est un
// nom de scène déjà sauvegardé ; la liste est persistée comme
// préférence (clé SAVED_SCENES_STORAGE_KEY, JSON array de strings,
// plus récent en premier, dédupliquée, bornée à MAX_SAVED_SCENES) et
// n'entre JAMAIS dans le wire format des fichiers exportés.

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
        // Quota dépassé typiquement : l'emplacement s'oublie, l'export
        // fichier (action principale) passe — dégradation silencieuse.
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

// Nom de fichier sûr pour le téléchargement : le nom de scène saisi
// peut contenir des caractères interdits dans les noms de fichiers
// (/, \, :, *, ?, ", <, >, | et les contrôles) — remplacés par « - ».
// Seul le nom du fichier téléchargé est assaini ; le nom « propre »
// (saisi dans la fenêtre) reste le nom de scène (HUD + wire format).
const sanitizeFileName = (name) => {
    const cleaned = String(name == null ? '' : name)
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    return cleaned.length > 0 ? cleaned : 'scene'
}

// ===== Save (export fichier) =====
//
// `name` (optionnel) est l'emplacement choisi dans la fenêtre
// d'enregistrement : il devient le nom de la scène (le wire format
// embarqué porte le même nom que le fichier téléchargé) et le fichier
// est téléchargé sous « <nom>.json ». Sans argument (back-compat,
// appels programmatiques), le nom courant de la scène est utilisé.
export const saveMesh = (name) => {
    try {
        const trimmed = typeof name === 'string' ? name.trim() : ''
        const current = (typeof state.sceneName === 'string' && state.sceneName.trim().length > 0)
            ? state.sceneName.trim()
            : 'nouvelleScene'
        const baseName = trimmed.length > 0 ? trimmed : current
        // Le nom de scène adopte l'emplacement AVANT la sérialisation :
        // serializeState embarque `name` dans le wire format — le
        // fichier écrit et la scène restaurée doivent porter le même
        // nom que l'emplacement choisi.
        state.sceneName = baseName
        // La scène locale (localStorage) est réécrite avec le nouveau
        // nom : un rechargement immédiat après la sauvegarde restaure
        // le nom choisi (cohérence avec l'emplacement enregistré).
        // Sans cette écriture, seul le prochain zoom/pan/édition
        // persisterait le nom — le reload retomberait sur l'ancien.
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
        // saveMesh pose la baseline sur la scene qui vient d'etre
        // exportee en fichier (dirty = false jusqu'à modification).
        // Equivaut a captureSceneBaseline() mais apres avoir
        // desactive la baseline precedente (= ce qui etait sur
        // disque n'est plus le baseline courant). On capture
        // directement pour eviter une race avec une mutation
        // pendante qui aurait pu modifier state.shapes entre
        // serializeState et updateSceneStatus. captureSceneBaseline
        // appelle updateSceneStatus : le HUD affiche le nouveau nom.
        captureSceneBaseline()
        log('Export OK: ' + a.download)
        // (évolution « commentaire dans le HUD ») — logique prospective :
        // le HUD #sceneStatus affiche déjà le nom + l'état « sauvegardée »
        // (captureSceneBaseline) ; le toast indique la suite possible
        // (ré-enregistrer avec le même raccourci).
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

// Phase 5 (modifyShapeModel-spec §4 Phase 5 observability + §B Q3b :
// detecteur de fichiers legacy charges via shapeToMesh fallback
// (.triangles inline-coord au lieu de .pointList). Decision Q3b
// preserve la back-compat silencieusement — ce flag signale
// l_evenement a l_utilisateur (une fois par session) pour l_inciter
// a re-sauvegarder en nouveau format {pointList, tris}. Closure
// scope — le refresh navigateur reset le flag.
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
        // Fix : `target` (undefined) → `e.target`. L'ancien code levait
        // un ReferenceError non catché à CHAQUE clic dans la modale
        // (donc aussi au clic de validation), même si onValidate
        // passait par ailleurs (ordre des listeners). Découvert par le
        // smoke test scripts/smoke-import.mjs (collecteur d'erreurs JS).
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

// Source unique de vérité pour la résolution du nom de scène à
// l'import. Séquence de priorité : nom du fichier source (sans
// extension, cf. stripFileExtension) > nom embarqué dans le wire
// format (cas auto-import URL sans filename, ou données
// programmatique) > default 'nouvelleScene'. Centralise la logique
// pour eviter la duplication entre importMeshFromText et
// applyImport, et pour garantir une seule sémantique de fallback.
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

// clearHistory = false pour l'import MERGE : l'historique undo/redo
// est CONSERVE (spec utilisateur — seuls le reset de scene et
// l'import REPLACE reinitialisent l'undo ; les entries existantes
// referencent des indices < beforeCount, toujours valides apres un
// append). true (default) pour REPLACE, qui reinitialise tout.
const resetEphemeralState = (clearHistory = true) => {
    if (clearHistory) {
        state.historyStack = []
        state.redoStack = []
        // (évolution « couper, copier, coller les éléments sélectionnés »)
        // Le presse-papiers interne est une capture de la scène courante :
        // un import REPLACE (nouvelle scène) le rend périmé — le vider
        // évite de coller de la géométrie fantôme d'une scène remplacée.
        // Le MERGE (clearHistory=false) le conserve (la scène courante
        // reste présente, coller dedans reste légitime).
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
        // MERGE preserve le nom existant — les formes ajoutees
        // ne renommment pas la scene (« mesh-wail » + 3 formes
        // mergées reste « mesh-wail »). Cohérent avec la sémantique
        // MERGE : on étend, on ne remplace pas.
        // Spec utilisateur : « après chargement du fichier ne pas
        // afficher l'indicateur de non sauvegarde ». Le MERGE est
        // une forme de chargement : la baseline devient le résultat
        // merge (dirty = false jusqu'à la prochaine modification).
        applyPendingRotationToShapes(loaded)
        state.activeShapeIndex = beforeCount
        if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
            state.activeShapeIndex = Math.max(0, state.shapes.length - 1)
        }
        // MERGE conserve l'historique undo/redo (spec utilisateur —
        // seuls reset scene et import REPLACE le reinitialisent). On
        // marque juste le flag : la persistState ci-dessous re-ecrit
        // la cle undo avec le NOUVEAU fingerprint de scene (append de
        // formes), pour que la restauration au prochain reload reste
        // coherente sans perdre les entries.
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
    // REPLACE adopte le nom résolu (helper centralisé cf.
    // resolveImportSceneName — single source of truth pour la
    // précédence filename > wire-format name > default).
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
    // REPLACE reinitialise l'historique undo/redo (spec utilisateur :
    // load replace d'une scene = reinit de l'undo), en memoire ET
    // persiste — un reload ne doit pas ressusciter l'undo de l'ancienne
    // scene remplacee.
    resetEphemeralState(true)
    clearPersistedUndo()
    persistState()
    // Spec utilisateur : « après chargement du fichier ne pas
    // afficher l'indicateur de non sauvegarde » — le REPLACE pose
    // la baseline sur l'etat importe (dirty = false jusqu'à la
    // prochaine mutation par l'utilisateur).
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
        // Passez stripFileExtension(file.name) comme sourceName —
        // le sceneName adopte le basename sans extension du fichier
        // (cf. importMeshFromText pour la précédence filename vs
        // wire-format name).
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
    // (évolution « couper, copier, coller les éléments sélectionnés »)
    // Le reset complet vide aussi le presse-papiers interne (capture de
    // l'ancienne scène, périmée) — même politique que l'historique.
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
    // Spec utilisateur : « si la scène a été réinitialisée alors
    // lui donner par défaut le nom de nouvelleScene ».
    state.sceneName = 'nouvelleScene'
    // Reinit de l'undo (spec utilisateur : reset scene = reinit de
    // l'undo) — en memoire (fait ci-dessus) ET persiste : un reload
    // apres reset ne doit pas ressusciter l'historique de l'ancienne
    // scene.
    clearPersistedUndo()
    persistState()
    // Spec utilisateur : « ne pas afficher l'indicateur de non
    // sauvegarde » apres reset (= baseline = scene vide indexe).
    // dirty = false tant que l'utilisateur n'a pas modifie.
    captureSceneBaseline()
    requestDraw()
    updateZoomDisplay()
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    log('Reset OK')
    showActionComment('Cliquez pour poser le 1er point de votre nouvelle scène')
}
