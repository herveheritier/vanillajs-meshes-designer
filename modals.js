// ---------------------------------------------------------------
// modals.js
//
// Show / hide des modales Help et Reset, plus le reset complet de
// la scene. La modale d'import (replace vs merge) vit dans
// import_export.js car elle est couplee au pipeline d'import.
//
// Les boutons "Fermer" / "Annuler" / "Valider" sont cables dans
// main.js (le module init, qui est charge en dernier).
// ---------------------------------------------------------------

// ---- Help modal : simple show/hide ----
showHelp = () => {
    if (!helpModal) return
    helpModal.hidden = false
}
hideHelp = () => {
    if (!helpModal) return
    helpModal.hidden = true
}

// ---- Reset modal : simple show/hide ----
showResetModal = () => {
    if (!resetModal) return
    resetModal.hidden = false
}
hideResetModal = () => {
    if (!resetModal) return
    resetModal.hidden = true
}

// Reset complet de la scene : vide shapes, history, selection,
// viewport (zoom/pan/rotation). Affiche dans la console.
resetAll = () => {
    shapes = [{ triangles: [] }]
    activeShapeIndex = 0
    selectedPoints = []
    historyStack = []
    redoStack = []
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
    // Reset complet du viewport (zoom + pan). La rotation de
    // scene n'a plus d'etat propre : les vertices des formes
    // (qui sont vides apres ce reset) portent zero orientation
    // cumulee.
    ctx.zoomLevel = 1
    ctx.viewCenter.x = 0
    ctx.viewCenter.y = 0
    // Compteur de rotation : reset avec la scene vide.
    ctx.rotationTracking = 0
    persistState()
    drawBoard()
    updateZoomDisplay()
    updateShapeHud()
    log('Reset OK')
}

// ---- Helpers de stockage pour le mode d'import memorise ----

// Lit la preference. Renvoie 'replace' ou 'merge' ou null si absente/invalide.
getStoredImportMode = () => {
    try {
        let v = localStorage.getItem(IMPORT_MODE_STORAGE_KEY)
        return v === 'replace' || v === 'merge' ? v : null
    } catch (e) {
        return null
    }
}

// Persiste la preference. Les erreurs (quota, etc) sont ignorees pour
// ne JAMAIS bloquer l'import.
saveStoredImportMode = (mode) => {
    try {
        if (mode === 'replace' || mode === 'merge') {
            localStorage.setItem(IMPORT_MODE_STORAGE_KEY, mode)
        }
    } catch (e) {}
}
