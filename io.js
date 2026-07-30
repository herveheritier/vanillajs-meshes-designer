// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    SCENE_STORAGE_KEY, GRID_STEP_STORAGE_KEY, ACTIVE_GRID_STORAGE_KEY,
    ZOOM_STORAGE_KEY, VIEW_CENTER_STORAGE_KEY,
    MIN_GRID_STEP, MAX_GRID_STEP, MIN_ZOOM, MAX_ZOOM,
    IMPORT_MODE_STORAGE_KEY, TAU,
} from './constants.js'
import { drawBoard } from './draw.js'
import { updateGridButtonText, updateShapeHud, updateUndoRedoHud, updateSelectionHud } from './hud.js'
import { log } from './log.js'
import { isSceneEmpty } from './geometry.js'

// ===== Serialisation (state -> JSON) =====

// Convertit une forme (triangles avec shared refs) en mesh
// dedup (pointList + indices). Necessaire pour que
// buildShapesFromPayload puisse reconstruire la scene au
// reload. Meme format utilise par le file-import, donc
// saveMesh produit un fichier coherent avec le format
// d'import.
//
// Persiste aussi les metadonnees par-triangle : `fill`
// (couleur optionnelle, voir draw.js). Persistance
// inverse dans buildShapesFromPayload. Aucun autre champ
// n'est serialise : le modele est minimaliste (p1, p2, p3,
// fill) ; ajouter un nouveau champ necessite de toucher
// les 3 endroits (draw, serialize, deserialize) +
// cloneTriArray (pour undo/redo).
//
// Defense en profondeur : si `shape.triangles` n'est pas un
// Array, on retombe sur une forme vide plutot que de jeter
// JSON.stringify (causerait la perte de TOUTE la scene
// alors qu'une seule forme est cassee).
export const shapeToMesh = (shape) => {
    const pointMap = new Map()
    const pointList = []
    const tris = []
    if (!shape || !Array.isArray(shape.triangles)) {
        log('shapeToMesh FALLBACK: shape=' + (shape ? JSON.stringify(shape) : 'undefined') + ' (.triangles absent ou non-Array) => serialisation videe pour cette forme, le reste de la scene est persiste normalement. Capture ce message pour identifier la mutation fautive.')
        return { pointList, tris }
    }
    shape.triangles.forEach(t => {
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
        if (t.fill !== undefined) tri.fill = t.fill
        tris.push(tri)
    })
    return { pointList, tris }
}

// Rationale : voir DESIGN.md §3.5
export const snapZoom = (z) => Math.round(z * 10) / 10

export const serializeState = () => {
    return JSON.stringify({
        activeGrid: state.activeGrid,
        GRID_STEP: state.GRID_STEP,
        shapes: state.shapes.map(shapeToMesh),
        activeShapeIndex: state.activeShapeIndex,
        zoomLevel: state.ctx.zoomLevel,
        viewCenter: { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y },
    })
}

// ===== Persistance (write to localStorage) =====

// Synchrone (pas de debounce) : le debounce 150ms d'origine
// rait avec les reloads rapides (Ctrl+R dans la fenetre du
// debounce). localStorage.setItem prend ~1ms sur des scenes
// de taille humaine, le write synchrone est acceptable cote
// perf. Meme pattern que la sauvegarde console-frame :
// uniquement au mouseup, pas de drag-time debounce.
export const persistState = () => {
    try {
        localStorage.setItem(SCENE_STORAGE_KEY, serializeState())
        state.ctx.workIsSaved = 1
    } catch (e) {
        log('Persist fail: ' + e.message)
    }
}

// ===== Restore (read from localStorage) =====

// Helper interne : convertit un tableau de tris en
// [{p1,p2,p3}] resolus contre pts. Utilise par les 3
// branches de buildShapesFromPayload (mesh format,
// migration state.shapes, legacy single-mesh) pour eviter
// la duplication du pattern "3 lignes de nt.pX conditionnel".
// Preserve aussi les metadonnees par-triangle (fill) si
// elles existent dans le payload (cf. shapeToMesh pour
// l'inverse). Champ string vide ou null ignore (= retombe
// sur fill default COLOR_TRIANGLE_FILL_ACTIVE en draw).
const resolveTrisToTriangles = (trisArray, pts) => {
    const ts = []
    if (!Array.isArray(trisArray)) return ts
    trisArray.forEach(t => {
        const nt = {}
        if (t.p1 !== undefined && pts[t.p1]) nt.p1 = pts[t.p1]
        if (t.p2 !== undefined && pts[t.p2]) nt.p2 = pts[t.p2]
        if (t.p3 !== undefined && pts[t.p3]) nt.p3 = pts[t.p3]
        if (typeof t.fill === 'string' && t.fill.length > 0) nt.fill = t.fill
        ts.push(nt)
    })
    return ts
}

// Reconstruit un tableau de formes a partir d'un payload
// JSON. Accepte plusieurs formats :
//   - nouveau : { shapes: [{ tris, pointList }, ...], activeShapeIndex }
//   - ancien (compat) : { tris, pointList, activeShapeIndex }
//   - state.shapes natif legacy (rare, via shapeToMesh)
export const buildShapesFromPayload = (data) => {
    if (!data || typeof data !== 'object') return null
    let result = []
    if (Array.isArray(data.shapes)) {
        data.shapes.forEach(shape => {
            let pts = []
            let trisSource = undefined
            if (Array.isArray(shape.pointList)) {
                pts = shape.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = shape.tris
            } else if (Array.isArray(shape.triangles)) {
                // Legacy state.shapes natif (ecrit par les versions
                // buggees d'avant le commit de fix serializeState) :
                // triangles[i].p1|p2|p3 etaient des REFERENCES
                // d'objets points. Sans cette branche, les
                // utilisateurs avec un localStorage en v1 voient
                // des formes vides au reload.
                const mesh = shapeToMesh(shape)
                pts = (mesh.pointList || []).map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = mesh.tris
            }
            result.push({ triangles: resolveTrisToTriangles(trisSource, pts) })
        })
    } else {
        // Legacy single-mesh (avant le split : la scene etait
        // un seul {pointList, tris}, pas un tableau de formes).
        const pts = []
        if (Array.isArray(data.pointList)) {
            pts = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        result.push({ triangles: resolveTrisToTriangles(data.tris, pts) })
    }
    if (result.length === 0) result = [{ triangles: [] }]
    return result
}

// Helper prive : applique la rotation "legacy viewport"
// stockee dans state.pendingRotation aux vertices de chaque
// forme passee en argument. Meme formule CCW standard que
// rotateEachShapeAroundPivot (editor.js), juste appelee une
// fois en bloc sur un tableau de formes au lieu d'un point
// a la fois. Utilisee par loadState ET applyImport pour
// migrer les scenes sauvegardees avec l'ancien format
// viewport-rotation.
const applyPendingRotationToShapes = (shapeArray) => {
    if (!state.pendingRotation || !shapeArray || shapeArray.length === 0) return
    const angle = state.pendingRotation.angle
    const pivot = state.pendingRotation.pivot
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    shapeArray.forEach((shape) => {
        shape.triangles.forEach((t) => {
            ['p1', 'p2', 'p3'].forEach((pid) => {
                const p = t[pid]
                if (!p) return
                const dx = p.x - pivot.x
                const dy = p.y - pivot.y
                p.x = pivot.x + dx * cos - dy * sin
                p.y = pivot.y + dx * sin + dy * cos
            })
        })
    })
    state.pendingRotation = undefined
}

export const loadState = () => {
    const saved = localStorage.getItem(SCENE_STORAGE_KEY)
    if (!saved) return
    try {
        // Reset de state.pendingRotation au demarrage du try,
        // avant parsing. Sans ca, si une exception survient
        // apres que pendingRotation ait ete set et que
        // buildShapesFromPayload jette, le state reste pollue
        // et un futur applyImport appliquerait la rotation
        // stale silencieusement.
        state.pendingRotation = undefined
        const data = JSON.parse(saved)
        if (data.activeGrid !== undefined) state.activeGrid = !!data.activeGrid
        if (data.GRID_STEP !== undefined && typeof data.GRID_STEP === 'number') {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        }
        if (typeof data.zoomLevel === 'number' && data.zoomLevel > 0) {
            // Snap a 0.1 pour normaliser les valeurs persistees
            // avant correction de ce bug (drift flottant
            // cumule par les multiplications repetees par
            // ZOOM_STEP_FACTOR). Cf. snapZoom dans viewport.js
            // pour la rationale complete (reel == persiste ==
            // affiche a 1 decimale).
            state.ctx.zoomLevel = snapZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, data.zoomLevel)))
        }
        if (data.viewCenter && typeof data.viewCenter.x === 'number' && typeof data.viewCenter.y === 'number') {
            state.ctx.viewCenter.x = data.viewCenter.x
            state.ctx.viewCenter.y = data.viewCenter.y
        }
        // Migration LEGACY : rotation viewport-rotation
        // integree aux vertices.
        if (typeof data.rotation === 'number' && Number.isFinite(data.rotation) && data.rotation !== 0) {
            let r = data.rotation % TAU
            if (r < 0) r += TAU
            const pivot = { x: 0, y: 0 }
            if (data.rotationPivot && typeof data.rotationPivot.x === 'number' && typeof data.rotationPivot.y === 'number' && Number.isFinite(data.rotationPivot.x) && Number.isFinite(data.rotationPivot.y)) {
                if (data.rotationPivot.kind === 'model') {
                    pivot.x = data.rotationPivot.x
                    pivot.y = data.rotationPivot.y
                } else {
                    // Ancien format screen : conversion via camera transform inverse.
                    pivot.x = state.ctx.viewCenter.x + (data.rotationPivot.x - state.ctx.center.x) / state.ctx.zoomLevel
                    pivot.y = state.ctx.viewCenter.y - (data.rotationPivot.y - state.ctx.center.y) / state.ctx.zoomLevel
                }
            }
            // Migration deferred : on ne peut pas tourner les
            // vertices ici car state.shapes n'est pas encore
            // charge. On flag et on applique apres
            // buildShapesFromPayload.
            state.pendingRotation = { angle: r, pivot }
        } else {
            state.pendingRotation = undefined
        }
        const loaded = buildShapesFromPayload(data)
        if (loaded) {
            state.shapes = loaded
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
    } catch (e) {
        state.pendingRotation = undefined
        log('Load fail: ' + e.message)
    }
    // Defense en profondeur : sync HUD meme en cas de
    // chemin non couvert (futur refactor). Idempotent avec
    // l'appel en fin de doit().
    updateUndoRedoHud()
}

// beforeunload : force un flush du state au cas ou une
// mutation inachevee trainerait. clearTimeout du persistTimer
// evite un flush en double (defensif meme si persistState ne
// debounce plus).
const onBeforeUnload = () => {
    clearTimeout(state.persistTimer)
    try {
        localStorage.setItem(SCENE_STORAGE_KEY, serializeState())
    } catch (e) { /* ignore */ }
}

export const wireBeforeUnload = () => {
    window.addEventListener('beforeunload', onBeforeUnload)
}

// ===== Save (export fichier) =====

// Telechargement d'un fichier JSON portant un nom
// timestamp (ex: mesh-1785323941.json). URL.createObjectURL +
// revokeObjectURL : pattern standard, propre au DOM.
export const saveMesh = () => {
    try {
        const blob = new Blob([serializeState()], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'mesh-' + Date.now() + '.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        log('Export OK: ' + a.download)
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

// Anti-double-modal : si la modale est deja ouverte, le
// second appel est ignore et le callback recoit null
// (= annule).
let importModalShown = false

// Rationale : voir DESIGN.md §7.4
const showImportModal = (opts, callback) => {
    if (importModalShown) {
        callback(null)
        return
    }
    const modal = document.querySelector('#importModal')
    if (!modal) {
        // Le DOM modal n'existe pas (tests headless, ancien
        // HTML). On ne fait pas crasher l'import : on retombe
        // sur replace silencieux comme avant l'introduction du
        // modal.
        log('Import modal absent, replace par defaut')
        callback({ mode: 'replace', remember: false })
        return
    }
    importModalShown = true

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
        // Le clic sur le fond (backdrop) doit annuler. Le DOM
        // modal contient <div class="modal-backdrop"> comme
        // premier enfant, donc e.target sur la zone sombre est
        // ce div, PAS #importModal. On accepte les deux cas
        // (clic direct sur le container ou sur le div
        // backdrop) ; les clics sur .modal-box ou ses enfants
        // ne correspondent pas et ne declenchent rien.
        if (e.target && (e.target === modal || e.target.classList && e.target.classList.contains('modal-backdrop'))) {
            onCancel()
        }
    }

    if (validateBtn) {
        validateBtn.addEventListener('click', onValidate)
        validateBtn.focus()
    }
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey)
    modal.addEventListener('click', onBackdrop)
    modal.hidden = false
}

// ===== Import (text et file) =====

// Parse + validation du payload d'abord, AVANT tout prompt.
// 1) Scene vide : pas de prompt, replace direct.
// 2) Scene non vide : affiche le modal HTML custom.
// Le radio est pre-selectionne sur le dernier choix memorise
// (defaut 'replace' si premiere fois).
export const importMeshFromText = (text) => {
    let parsed = null
    let loaded = null
    try {
        const data = JSON.parse(text)
        if (!data || typeof data !== 'object') {
            log('Import fail: not a JSON object')
            return false
        }
        parsed = data
        loaded = buildShapesFromPayload(data)
    } catch (e) {
        log('Import fail: ' + e.message)
        return false
    }

    if (isSceneEmpty()) {
        applyImport(parsed, loaded, 'replace')
        return true
    }

    const currentTriCount = state.shapes.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    const importedTriCount = loaded.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    const currentInfo = state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + currentTriCount + ' triangle' + (currentTriCount > 1 ? 's' : '')
    const importedInfo = loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + importedTriCount + ' triangle' + (importedTriCount > 1 ? 's' : '')
    showImportModal({ currentInfo, importedInfo }, (result) => {
        if (!result) {
            log('Import cancelled')
            return
        }
        saveStoredImportMode(result.mode)
        applyImport(parsed, loaded, result.mode)
    })
    return true
}

// Applique le payload importe selon le mode ('replace' ou
// 'merge'). Choix deja fait, ici on ne fait QUE
// l'application (reset d'etat ephemere, mutation de
// state.shapes, persist, redraw).
const resetEphemeralState = () => {
    state.historyStack = []
    state.redoStack = []
    state.selectedPoints = []
    // Clearing les indices de triangles : apres import (replace
    // ou merge post-reset), les indices referencent des
    // positions differentes dans la nouvelle scene, donc
    // invalides. Meme logique que history.clearEditingTransientState.
    state.selectedTriangles = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
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

export const applyImport = (parsed, loaded, mode) => {
    if (mode === 'merge') {
        const beforeCount = state.shapes.length
        if (parsed.activeGrid !== undefined) state.activeGrid = !!parsed.activeGrid
        if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
            state.GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
        }
        loaded.forEach(s => state.shapes.push(s))
        // Migration LEGACY : rotation viewport sauvegardee
        // appliquee aux nouvelles formes (loaded), pas aux
        // anciennes (shapes).
        applyPendingRotationToShapes(loaded)
        state.activeShapeIndex = beforeCount
        if (state.activeShapeIndex < 0 || state.activeShapeIndex >= state.shapes.length) {
            state.activeShapeIndex = Math.max(0, state.shapes.length - 1)
        }
        resetEphemeralState()
        persistState()
        updateGridButtonText()
        updateShapeHud()
        drawBoard()
        const totalTris = state.shapes.reduce((acc, s) => acc + s.triangles.length, 0)
        log('Import merge OK: +' + loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + state.shapes.length + ' au total, ' + totalTris + ' triangles')
        return true
    }

    // Replace mode
    state.shapes = loaded
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
    resetEphemeralState()
    persistState()
    updateGridButtonText()
    updateShapeHud()
    drawBoard()
    const totalTris = state.shapes.reduce((acc, s) => acc + s.triangles.length, 0)
    log('Import OK: ' + state.shapes.length + ' forme' + (state.shapes.length > 1 ? 's' : '') + ', ' + totalTris + ' triangle' + (totalTris > 1 ? 's' : ''))
    return true
}

// Lit un fichier JSON via FileReader (+ validation extension /
// MIME), delegue a importMeshFromText au onload.
export const importMeshFromFile = (file) => {
    if (!file) return
    if (file.type !== 'application/json' && !file.name.match(/\.json$/i)) {
        log('Import fail: not a JSON file')
        return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
        importMeshFromText(String(e.target.result))
    }
    reader.onerror = () => log('Import fail: read error')
    reader.readAsText(file)
}

// ===== Reset =====

// Wipe complet : scene vide + piles + selection + viewport
// par defaut. log explicite 'Reset OK' pour tracabilite
// dans la console in-app.
export const resetAll = () => {
    state.shapes = [{ triangles: [] }]
    state.activeShapeIndex = 0
    state.selectedPoints = []
    state.selectedTriangles = []
    state.historyStack = []
    state.redoStack = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
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
    persistState()
    drawBoard()
    updateZoomDisplay()
    updateShapeHud()
    updateUndoRedoHud()
    updateSelectionHud()
    log('Reset OK')
}
