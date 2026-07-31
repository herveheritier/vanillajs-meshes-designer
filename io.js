// Rationale : voir DESIGN.md §4.1

import { state } from './state.js'
import {
    SCENE_STORAGE_KEY, GRID_STEP_STORAGE_KEY, ACTIVE_GRID_STORAGE_KEY,
    ZOOM_STORAGE_KEY, VIEW_CENTER_STORAGE_KEY,
    MIN_GRID_STEP, MAX_GRID_STEP, MIN_ZOOM, MAX_ZOOM,
    IMPORT_MODE_STORAGE_KEY, TAU,
    SCENE_FORMAT, SCENE_FORMAT_VERSION,
} from './constants.js'
import { drawBoard } from './draw.js'
import { updateGridButtonText, updateShapeHud, updateUndoRedoHud, updateSelectionHud, updateSceneStatus } from './hud.js'
import { log } from './log.js'
import { isSceneEmpty } from './geometry.js'

// ===== Serialisation (state -> JSON) =====

export const shapeToMesh = (shape) => {
    const pointMap = new Map()
    const pointList = []
    const tris = []
    if (!shape || !Array.isArray(shape.triangles)) {
        log('shapeToMesh FALLBACK: shape=' + (shape ? JSON.stringify(shape) : 'undefined') + ' (.triangles absent ou non-Array) => serialisation videe pour cette forme, le reste de la scene est persiste normalement. Capture ce message pour identifier la mutation fautive.')
        return { pointList, tris }
    }
    shape.triangles.forEach(t => {
        // Anti-leak symétrique à resolveTrisToTriangles (cf. DESIGN §4.4) :
        // un triangle partiel ne franchit pas non plus la frontière io
        // côté serialize. Sans ça, un triangle en cours de dessin occupe
        // des slots vides dans localStorage (pollution + faux espoirs
        // d'inspection via DevTools), même si sa matérialisation au load
        // est bloquée par le filtre jumeau. Defense in depth.
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
        if (t.fill !== undefined) tri.fill = t.fill
        tris.push(tri)
    })
    return { pointList, tris }
}

// Rationale : voir DESIGN.md §3.5
export const snapZoom = (z) => Math.round(z * 10) / 10

export const serializeState = () => {
    return JSON.stringify({
        format: SCENE_FORMAT,
        version: SCENE_FORMAT_VERSION,
        activeGrid: state.activeGrid,
        GRID_STEP: state.GRID_STEP,
        shapes: state.shapes.map(shapeToMesh),
        activeShapeIndex: state.activeShapeIndex,
        zoomLevel: state.ctx.zoomLevel,
        viewCenter: { x: state.ctx.viewCenter.x, y: state.ctx.viewCenter.y },
    })
}

// ===== Persistance (write to localStorage) =====

export const persistState = () => {
    try {
        localStorage.setItem(SCENE_STORAGE_KEY, serializeState())
        state.ctx.workIsSaved = 1
        updateSceneStatus()
    } catch (e) {
        log('Persist fail: ' + e.message)
    }
}

// ===== Restore (read from localStorage) =====

const resolveTrisToTriangles = (trisArray, pts) => {
    const ts = []
    if (!Array.isArray(trisArray)) return ts
    trisArray.forEach(t => {
        // Anti-leak restart : un triangle partiel (sans p3, ou sans l'un des
        // p1/p2/p3) ne doit pas traverser la frontière io. Sinon, après
        // reload, sa p1-p2 attend un clic pour compléter via la branche
        // addPoint 'else if (triangle.p3 === undefined) triangle.p3 = point',
        // qui bypasse entièrement le recalcul de state.nearestLine — la
        // première arête devient donc le segment p1-p2 laissé en plan avant
        // restart, perçu comme « le dernier segment utilisé avant redémarrage »
        // (cf. DESIGN.md §4.4 : règle anti-leak triangles partiels).
        const nt = {}
        if (t.p1 !== undefined && pts[t.p1]) nt.p1 = pts[t.p1]
        if (t.p2 !== undefined && pts[t.p2]) nt.p2 = pts[t.p2]
        if (t.p3 !== undefined && pts[t.p3]) nt.p3 = pts[t.p3]
        if (typeof t.fill === 'string' && t.fill.length > 0) nt.fill = t.fill
        if (nt.p1 && nt.p2 && nt.p3) ts.push(nt)
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
                const mesh = shapeToMesh(shape)
                pts = (mesh.pointList || []).map(p => ({ x: Number(p.x), y: Number(p.y) }))
                trisSource = mesh.tris
            }
            result.push({ triangles: resolveTrisToTriangles(trisSource, pts) })
        })
    } else {
        let pts = []
        if (Array.isArray(data.pointList)) {
            pts = data.pointList.map(p => ({ x: Number(p.x), y: Number(p.y) }))
        }
        result.push({ triangles: resolveTrisToTriangles(data.tris, pts) })
    }
    if (result.length === 0) result = [{ triangles: [] }]
    return result
}

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
        state.pendingRotation = undefined
        const data = JSON.parse(saved)
        const validationError = validateScenePayload(data)
        if (validationError) {
            log('Load fail: ' + validationError)
            return
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
            state.shapes = loaded
            if (typeof data.activeShapeIndex === 'number' && data.activeShapeIndex >= 0 && data.activeShapeIndex < state.shapes.length) {
                state.activeShapeIndex = data.activeShapeIndex
            } else {
                state.activeShapeIndex = 0
            }
            applyPendingRotationToShapes(state.shapes)
        }
        state.ctx.workIsSaved = 1
        state.sceneDirty = false
        updateGridButtonText()
        updateShapeHud()
    } catch (e) {
        state.pendingRotation = undefined
        log('Load fail: ' + e.message)
    }
    updateUndoRedoHud()
}

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
        state.sceneDirty = false
        updateSceneStatus()
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

let importModalShown = false

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
        if (e.target && (e.target === modal || e.target.classList && e.target.classList.contains('modal-backdrop'))) {
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

export const importMeshFromText = (text) => {
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

const resetEphemeralState = () => {
    state.historyStack = []
    state.redoStack = []
    state.selectedPoints = []
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
        state.sceneDirty = true
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

    state.shapes = loaded
    state.sceneDirty = true
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
    state.sceneDirty = true
    updateSceneStatus()
    log('Reset OK')
}
