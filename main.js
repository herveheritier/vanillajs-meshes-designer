// ---------------------------------------------------------------
// main.js
//
// Point d'entree. Tout le code applicatif est reparti entre les
// modules charges en amont dans main.html (draw.js, convert.js,
// constants.js, state.js, geometry.js, history.js, shapes.js,
// scene_ops.js, hud.js, modals.js, import_export.js, events.js).
//
// Ce fichier ne contient qu'un appel `doit()` execute en inline
// depuis main.html. Sa raison d'etre : definir le boot dans un
// fichier dedie (tests / debug / profiling le trouvent ici) et
// laisser main.html tres court.
// ---------------------------------------------------------------

// Boot : restauration depuis localStorage, premier render, HUD.
// Les fonctions referencees ici sont definies dans les modules
// precedents (loadState dans import_export.js, drawBoard dans
// draw.js, updateShapeHud dans shapes.js, updateZoomDisplay
// dans hud.js).
doit = () => {
    loadState()
    drawBoard()
    updateShapeHud()
    updateZoomDisplay()
    // Console : applique l'etat persiste (consoleVisible restaure
    // par loadState). On l'appelle apres les autres updates HUD
    // pour que le DOM (#console queryable) soit pret.
    updateConsoleButtonText()
}
