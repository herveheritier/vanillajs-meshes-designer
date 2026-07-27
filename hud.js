// ---------------------------------------------------------------
// hud.js
//
// Affichages HUD : console overlay (#messageBoard), grille
// (#grid), coordonnees curseur (#coords), niveau de zoom +
// viewCenter + rotation cumulee (#zoomDisplay), et le hover
// in-canvas (point le plus proche, segment le plus proche).
//
// Tout ici ne mute PAS la scene : soit il affiche, soit il
// prepare un etat ephemere utilise ensuite par interaction.js.
// ---------------------------------------------------------------

// Append au journal en haut a gauche (#messageBoard). Une ligne
// par appel. innerText force un reflow (volontaire cote console
// : pas critique cote perfs).
log = (message) => {
    messageBoard.innerText += '\n'+message
}

// Toggle la grille (utilise par le clic sur le bouton et par le
// raccourci clavier 'g'). Centralise la logique pour eviter la
// divergence entre les deux points d'entree.
toggleGrid = () => {
    activeGrid = !activeGrid
    updateGridButtonText()
    drawBoard()
    persistState()
}

// Met a jour le bouton #grid : pastille "{GRID_STEP}px" et la
// classe .grid-active.
updateGridButtonText = () => {
    let gridText = document.querySelector('#gridText')
    let gridBtn = document.querySelector('#grid')
    if (!gridText || !gridBtn) return
    // Cible uniquement le <span> dedie : ne PAS toucher au bouton
    // entier avec innerText, sinon l'icone SVG est detruite.
    gridText.textContent = `${GRID_STEP}px`
    gridBtn.classList.toggle('grid-active', !!activeGrid)
}

// Toggle la console in-canvas (utilise par le clic sur le bouton et
// par le raccourci clavier 'c'). Centralise la logique pour eviter
// la divergence entre les deux points d'entree.
toggleConsole = () => {
    consoleVisible = !consoleVisible
    updateConsoleButtonText()
    persistState()
}

// Met a jour le bouton #console ET le display de #messageBoard : la
// classe .console-active donne l'accent vert, et le display:none
// cache l'overlay.
updateConsoleButtonText = () => {
    let btn = document.querySelector('#console')
    if (btn) btn.classList.toggle('console-active', !!consoleVisible)
    if (messageBoard) messageBoard.style.display = consoleVisible ? '' : 'none'
}

// Met a jour le hover (point le plus proche, dim de la selection, etc).
// Le curseur est dessine en screen. Le calcul du nearestPoint/Line
// se fait en coords model (Y inverse), restreint a la forme active.
updateMouseHover = (cursorScreen) => {
    updateCoordsDisplay(cursorScreen)
    if (!cursorScreen) return
    let actionModel = screenToModel(cursorScreen)
    let target = activeGrid ? snapToGrid(actionModel) : actionModel
    nearestPoint = findNearestPoint(target)

    if (selectedPoints.length > 0 && nearestPoint && nearestPoint.point && !isPointSelected(nearestPoint.point)) {
        isSelectionDimmed = true
    } else {
        isSelectionDimmed = false
    }

    drawBoard()
    drawMouse(cursorScreen)

    if (nearestPoint && nearestPoint.point) {
        drawPoint(nearestPoint.point, 5, '#00FF00')
    }
    nearestLine = findSelectedLine(target)
    if (nearestLine && nearestLine.firstPoint && nearestLine.secondPoint) {
        drawLine(nearestLine.firstPoint, nearestLine.secondPoint, [], COLOR_LINES_INACTIVE)
    }
}

// Affiche la position du curseur et du point le plus proche dans le
// HUD en bas de l'ecran, en coords model (Y inverse, origine au centre).
// Vide le HUD si pas de curseur. Utilise textContent (pas innerText) pour
// eviter un reflow a chaque mousemove.
updateCoordsDisplay = (cursorScreen) => {
    let div = document.querySelector('#coords')
    if (!div) return
    if (!cursorScreen) {
        div.textContent = ''
        return
    }
    let m = screenToModel(cursorScreen)
    let np = (nearestPoint && nearestPoint.point) ? nearestPoint.point : null
    let cursorTxt = `(${Math.round(m.x)}, ${Math.round(m.y)})`
    let nearestTxt = np ? `(${Math.round(np.x)}, ${Math.round(np.y)})` : '\u2014'
    div.textContent = `curseur ${cursorTxt}  plus proche ${nearestTxt}`
}

// Affiche le niveau de zoom + la position du viewCenter + la rotation
// de la scene dans le HUD bas-gauche (#zoomDisplay). Format compact :
// "1.2x pos(45, -30)" ; quand la scene est pivotee, on ajoute
// "  rot 45°" pour donner un feedback visuel immediat.
updateZoomDisplay = () => {
    let div = document.querySelector('#zoomDisplay')
    if (!div) return
    let vc = ctx.viewCenter
    let text = ctx.zoomLevel.toFixed(1) + 'x  pos(' +
        Math.round(vc.x) + ', ' + Math.round(vc.y) + ')'
    // Compteur de rotation cumulee (HUD-only). Affiche en
    // degres plutot qu'en radians (les utilisateurs pensent en
    // degres). Le caractere degre est U+00B0, distinct du 'o'.
    // Tour complet (= 360) ramene a 0 grace au modulo 2*PI
    // dans rotateEachShapeAroundPivot.
    if (ctx.rotationTracking !== 0) {
        let deg = Math.round(ctx.rotationTracking * 180 / Math.PI)
        text += '  rot ' + deg + '\u00b0'
    }
    div.textContent = text
}
