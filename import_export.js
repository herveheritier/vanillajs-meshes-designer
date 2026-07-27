// ---------------------------------------------------------------
// import_export.js
//
// Pipeline complet d'import/export JSON + persistance
// localStorage : serializeState, persistState (debounced 400 ms),
// buildShapesFromPayload, loadState (avec migration legacy
// viewport-rotation -> vertices via pendingRotation), saveMesh,
// importMeshFromText, showImportModal, applyImport, importMeshFromFile.
//
// Le listener beforeunload (force-flush avant fermeture) vit dans
// main.js (le module init, charge en dernier).
// ---------------------------------------------------------------

// Serialize la scene courante vers un objet JSON.
// Format : { shapes:[{ triangles:[{p1:{x,y},p2,p3}] }],
//            activeShapeIndex, activeGrid, GRID_STEP, consoleVisible, ctx }
// (ctx = center + viewCenter + zoomLevel + rotationTracking).
serializeState = () => {
    return JSON.stringify({
        shapes: shapes,
        activeShapeIndex: activeShapeIndex,
        activeGrid: activeGrid,
        GRID_STEP: GRID_STEP,
        consoleVisible: consoleVisible,
        ctx: {
            center: ctx.center,
            viewCenter: ctx.viewCenter,
            zoomLevel: ctx.zoomLevel,
            rotationTracking: ctx.rotationTracking
        }
    })
}

// Persiste la scene dans localStorage avec debounce 400 ms.
// Le debounce evite une ecriture a chaque tick de molette / drag.
persistState = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, serializeState())
            ctx.workIsSaved = 1
        } catch (e) {
            log('Persist fail: ' + e.message)
        }
    }, 400)
}

// Reconstruit la liste `shapes` a partir du payload JSON.
// Accepte deux formats de triangles :
//   (a) {p1:{x,y}, p2:{x,y}, p3:{x,y}}  (objet point)
//   (b) {p1:<idx>, p2:<idx>, p3:<idx>}   (index dans pointList)
// Le format (b) est emis par convert.js ; le format (a) est le
// "vrai" format de sauvegarde interne du designer.
buildShapesFromPayload = (data) => {
    if (!data || !Array.isArray(data.shapes)) return undefined
    let result = []
    for (let i = 0; i < data.shapes.length; i++) {
        let src = data.shapes[i]
        let incomingTris = []
        let pointList = Array.isArray(src.pointList) ? src.pointList : null
        let tris = Array.isArray(src.tris) ? src.tris : []
        for (let j = 0; j < tris.length; j++) {
            let t = tris[j]
            let nt = {}
            if (t.p1 !== undefined) {
                if (pointList && typeof t.p1 === 'number') {
                    let p = pointList[t.p1]
                    nt.p1 = { x: p.x, y: p.y }
                } else if (typeof t.p1 === 'object' && t.p1 !== null) {
                    nt.p1 = { x: t.p1.x, y: t.p1.y }
                }
            }
            if (t.p2 !== undefined) {
                if (pointList && typeof t.p2 === 'number') {
                    let p = pointList[t.p2]
                    nt.p2 = { x: p.x, y: p.y }
                } else if (typeof t.p2 === 'object' && t.p2 !== null) {
                    nt.p2 = { x: t.p2.x, y: t.p2.y }
                }
            }
            if (t.p3 !== undefined) {
                if (pointList && typeof t.p3 === 'number') {
                    let p = pointList[t.p3]
                    nt.p3 = { x: p.x, y: p.y }
                } else if (typeof t.p3 === 'object' && t.p3 !== null) {
                    nt.p3 = { x: t.p3.x, y: t.p3.y }
                }
            }
            incomingTris.push(nt)
        }
        result.push({ triangles: incomingTris })
    }
    return result
}

// Charge l'etat depuis localStorage. Si le format ancien contient
// un data.rotation / data.rotationPivot (viewport-rotation), on
// stocke dans pendingRotation pour migration vers les vertices via
// applyPendingRotationToShapes (scene_ops.js).
loadState = () => {
    pendingRotation = undefined
    try {
        let raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        let data = JSON.parse(raw)
        // Migration LEGACY: si data contient un champ rotation
        // (ancien code viewport-rotation), on l'applique aux
        // vertices apres buildShapesFromPayload. Les fichiers
        // actuels n'ont plus ce champ, mais on garde la branche.
        if (typeof data.rotation === 'number' && Number.isFinite(data.rotation) && data.rotation !== 0) {
            let r = data.rotation % TAU
            if (r < 0) r += TAU
            let pivot = { x: 0, y: 0 }
            if (data.rotationPivot && typeof data.rotationPivot.x === 'number' && typeof data.rotationPivot.y === 'number' && Number.isFinite(data.rotationPivot.x) && Number.isFinite(data.rotationPivot.y)) {
                if (data.rotationPivot.kind === 'model') {
                    pivot.x = data.rotationPivot.x
                    pivot.y = data.rotationPivot.y
                } else {
                    pivot.x = ctx.viewCenter.x + (data.rotationPivot.x - ctx.center.x) / ctx.zoomLevel
                    pivot.y = ctx.viewCenter.y - (data.rotationPivot.y - ctx.center.y) / ctx.zoomLevel
                }
            }
            pendingRotation = { angle: r, pivot: pivot }
        }
        // Mise a jour du HUD zoom apres restauration (sinon l'indicateur
        // reste a la valeur par defaut affichee dans le HTML initial).
        updateZoomDisplay()
        let loaded = buildShapesFromPayload(data)
        if (loaded) {
            shapes = loaded
            if (typeof data.activeShapeIndex === 'number' && data.activeShapeIndex >= 0 && data.activeShapeIndex < shapes.length) {
                activeShapeIndex = data.activeShapeIndex
            } else {
                activeShapeIndex = 0
            }
            applyPendingRotationToShapes(shapes)
        }
        ctx.workIsSaved = 1
        if (typeof data.activeGrid === 'boolean') activeGrid = data.activeGrid
        if (typeof data.GRID_STEP === 'number' && Number.isFinite(data.GRID_STEP)) {
            GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, data.GRID_STEP))
        }
        // Console visible : default true si absent (champ optionnel
        // introduit tardivement ; les fichiers plus anciens
        // l'ignorent et restent avec la console affichee).
        if (typeof data.consoleVisible === 'boolean') consoleVisible = data.consoleVisible
        updateGridButtonText()
        updateShapeHud()
    } catch (e) {
        pendingRotation = undefined
        log('Load fail: ' + e.message)
    }
}

// Telecharge la scene courante en fichier .json (Ctrl+S ou bouton #export).
saveMesh = () => {
    try {
        let blob = new Blob([serializeState()], { type: 'application/json' })
        let url = URL.createObjectURL(blob)
        let a = document.createElement('a')
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

// Importe un texte JSON. Si la scene est vide, replace direct.
// Sinon, ouvre la modale d'import pour choisir replace vs merge.
importMeshFromText = (text) => {
    // 1) Parse + validation du payload d'abord, AVANT tout prompt.
    let parsed = null
    let loaded = null
    try {
        let data = JSON.parse(text)
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

    // 2) Strategie d'import selon l'etat de la scene.
    if (isSceneEmpty()) {
        applyImport(parsed, loaded, 'replace')
        return true
    }

    // Scene non vide : on ouvre TOUJOURS le modal. Le radio est
    // pre-selectionne sur le dernier choix memorise.
    let currentTriCount = shapes.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let importedTriCount = loaded.reduce((a, s) => a + (s && s.triangles ? s.triangles.length : 0), 0)
    let currentInfo = shapes.length + ' forme' + (shapes.length > 1 ? 's' : '') + ', ' + currentTriCount + ' triangle' + (currentTriCount > 1 ? 's' : '')
    let importedInfo = loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + importedTriCount + ' triangle' + (importedTriCount > 1 ? 's' : '')
    showImportModal({ currentInfo: currentInfo, importedInfo: importedInfo }, (result) => {
        if (!result) {
            log('Import cancelled')
            return
        }
        saveStoredImportMode(result.mode)
        applyImport(parsed, loaded, result.mode)
    })
    return true
}

// Modale HTML d'import : montre "X formes, Y triangles" pour la
// scene courante ET pour le fichier importe, puis demande replace
// vs merge. Le radio est pre-selectionne sur le dernier choix
// memorise, defaut 'replace'.
showImportModal = (opts, callback) => {
    if (importModalShown) return
    let modal = document.querySelector('#importModal')
    if (!modal) {
        // Tests headless, ancien HTML : on retombe sur replace silencieux.
        log('Import modal absent, replace par defaut')
        callback({ mode: 'replace', remember: false })
        return
    }
    importModalShown = true

    let info = document.querySelector('#importModalInfo')
    if (info) {
        info.textContent = 'Scene en cours : ' + opts.currentInfo + '\nScene a charger : ' + opts.importedInfo
    }

    let previousMode = getStoredImportMode()
    let defaultMode = (previousMode === 'replace' || previousMode === 'merge') ? previousMode : 'replace'
    let radios = modal.querySelectorAll('input[name="importMode"]')
    radios.forEach(r => { r.checked = (r.value === defaultMode) })

    let validateBtn = document.querySelector('#importModalValidate')
    let cancelBtn = document.querySelector('#importModalCancel')

    let cleanup = () => {
        modal.hidden = true
        document.removeEventListener('keydown', onKey)
        modal.removeEventListener('click', onBackdrop)
        if (validateBtn) validateBtn.removeEventListener('click', onValidate)
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel)
        importModalShown = false
    }
    let onValidate = () => {
        let radio = modal.querySelector('input[name="importMode"]:checked')
        let mode = (radio && radio.value === 'merge') ? 'merge' : 'replace'
        cleanup()
        callback({ mode: mode })
    }
    let onCancel = () => {
        cleanup()
        callback(null)
    }
    let onKey = (e) => {
        if (e.key === 'Escape') onCancel()
    }
    let onBackdrop = (e) => {
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

// Applique le payload importe selon le mode ('replace' ou 'merge').
// Reset d'etat ephemere, mutation de shapes, persist, redraw.
applyImport = (parsed, loaded, mode) => {
    let resetEphemeralState = () => {
        historyStack = []
        redoStack = []
        selectedPoints = []
        nearestPoint = undefined
        nearestLine = undefined
        grabbedGroup = []
        currentAction = undefined
        isSelectingBox = false
        selectionBoxStart = undefined
        selectionBoxCurrent = undefined
        clearTimeout(wheelRotateTimer)
        wheelRotateTimer = undefined
        isWheelRotating = false
    }

    if (mode === 'merge') {
        let beforeCount = shapes.length
        if (parsed.activeGrid !== undefined) activeGrid = !!parsed.activeGrid
        if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
            GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
        }
        loaded.forEach(s => shapes.push(s))
        applyPendingRotationToShapes(loaded)
        activeShapeIndex = beforeCount
        if (activeShapeIndex < 0 || activeShapeIndex >= shapes.length) {
            activeShapeIndex = Math.max(0, shapes.length - 1)
        }
        resetEphemeralState()
        persistState()
        updateGridButtonText()
        updateShapeHud()
        drawBoard()
        let totalTris = shapes.reduce((acc, s) => acc + s.triangles.length, 0)
        log('Import merge OK: +' + loaded.length + ' forme' + (loaded.length > 1 ? 's' : '') + ', ' + shapes.length + ' au total, ' + totalTris + ' triangles')
        return true
    }

    // Replace mode
    shapes = loaded
    applyPendingRotationToShapes(shapes)
    if (typeof parsed.activeShapeIndex === 'number' && parsed.activeShapeIndex >= 0 && parsed.activeShapeIndex < shapes.length) {
        activeShapeIndex = parsed.activeShapeIndex
    } else {
        activeShapeIndex = 0
    }
    if (parsed.activeGrid !== undefined) activeGrid = !!parsed.activeGrid
    if (parsed.GRID_STEP !== undefined && typeof parsed.GRID_STEP === 'number') {
        GRID_STEP = Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, parsed.GRID_STEP))
    }
    resetEphemeralState()
    persistState()
    updateGridButtonText()
    updateShapeHud()
    drawBoard()
    let totalTris = shapes.reduce((acc, s) => acc + s.triangles.length, 0)
    log('Import OK: ' + shapes.length + ' forme' + (shapes.length > 1 ? 's' : '') + ', ' + totalTris + ' triangle' + (totalTris > 1 ? 's' : ''))
    return true
}

// Charge un fichier en FileReader puis delegue a importMeshFromText.
// Accepte uniquement les .json (MIME ou extension) pour eviter
// d'avaler silencieusement des mesh-text (.json peut couvrir les
// deux formats : convert.js fait sa propre validation sur les
// fichiers "meshes" via importMeshFromFile SEPARE).
// Wait — la logique de original main.js validating .json here is
// pour empecher les .obj/.ply etc. d'etre silently avales.
importMeshFromFile = (file) => {
    if (!file) return
    if (file.type !== 'application/json' && !file.name.match(/\.json$/i)) {
        log('Import fail: not a JSON file')
        return
    }
    let reader = new FileReader()
    reader.onload = (e) => {
        importMeshFromText(String(e.target.result))
    }
    reader.onerror = () => log('Import fail: read error')
    reader.readAsText(file)
}
