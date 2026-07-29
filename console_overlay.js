// Module console_overlay.js : gestion de l'overlay console.
//
// Domaine :
//   - Position + taille de la frame draggable/resizable
//     (bandeau titre = drag handle, poignee SE = resize).
//   - persistence localStorage (cle separee de la scene JSON).
//   - Bouton "clear" a l'interieur du bandeau.
//
// Dependances :
//   - state.js : state.messageBoard, state.messageLog
//   - constants.js : MIN/MAX frame dims, KEY localStorage
//   - log.js : pas importe directement ici
//
// Pas de dep sur hud/draw/io : la console est un overlay
// isole du canvas. main.js branche les listeners DOM en co-
// localisation (cf. wireConsoleOverlay()).

import { state } from './state.js'
import {
    CONSOLE_MIN_WIDTH, CONSOLE_MIN_HEIGHT, CONSOLE_FRAME_STORAGE_KEY,
} from './constants.js'

// ===== Frame (position/taille) =====

// Applique le frame precedemment sauvegarde. Validation :
// valeurs >= min, types corrects. Drop silently sur
// valeurs invalides (garde les defaults CSS de #messageBoard).
export const applyConsoleFrame = () => {
    if (!state.messageBoard) return
    try {
        const stored = localStorage.getItem(CONSOLE_FRAME_STORAGE_KEY)
        if (!stored) return
        const f = JSON.parse(stored)
        if (!f || typeof f !== 'object') return
        if (typeof f.left === 'number' && f.left >= 0) state.messageBoard.style.left = f.left + 'px'
        if (typeof f.top === 'number' && f.top >= 0) state.messageBoard.style.top = f.top + 'px'
        if (typeof f.width === 'number' && f.width >= 80) state.messageBoard.style.width = f.width + 'px'
        if (typeof f.height === 'number' && f.height >= 30) state.messageBoard.style.height = f.height + 'px'
    } catch (e) { /* ignore */ }
}

// Ecrit la position / taille en px (parseInt extrait le
// nombre, ignore 'px' ; 0 si absent/auto). IMPORTANT : on
// ecrit MEME si l'utilisateur n'a pas bouge, pour que le
// CSS default '1vw' soit converti en px exact (plus stable
// au reload quelle que soit la largeur viewport).
export const persistConsoleFrame = () => {
    if (!state.messageBoard) return
    try {
        const f = {
            left: parseInt(state.messageBoard.style.left) || 0,
            top: parseInt(state.messageBoard.style.top) || 0,
            width: parseInt(state.messageBoard.style.width) || 0,
            height: parseInt(state.messageBoard.style.height) || 0,
        }
        localStorage.setItem(CONSOLE_FRAME_STORAGE_KEY, JSON.stringify(f))
    } catch (e) { /* ignore */ }
}

// ===== Drag/resize wiring =====

// Mousedown sur le bandeau titre -> capture rect + position
// initiale. delta en mousemove = (current - initial),
// applique a mbLeft/mbTop.
// La classe body.dragging-console set le cursor OS en
// !important (le canvas a cursor: 'none' inline).
//
// Note : `document.body` (et non `document.state.body`). Le
// bulk rename du refactor ES6 avait transforme en
// `document.state.body` (10 sites) ; pattern qui n'a aucun
// sens car `document.state` est undefined.
const onConsoleTitleMousedown = (e) => {
    if (e.button !== 0) return
    if (!state.messageBoard) return
    e.preventDefault()
    state.consoleMoving = true
    const rect = state.messageBoard.getBoundingClientRect()
    state.consoleDragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        mbLeft: rect.left,
        mbTop: rect.top,
    }
    document.body.classList.add('dragging-console')
}

// Mousedown sur la poignee SE -> capture rect. delta en
// mousemove applique a mbWidth/mbHeight, ancre top-left
// fixe (le coin haut-gauche ne bouge pas).
const onConsoleResizeMousedown = (e) => {
    if (e.button !== 0) return
    if (!state.messageBoard) return
    e.preventDefault()
    state.consoleResizing = true
    const rect = state.messageBoard.getBoundingClientRect()
    state.consoleDragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        mbWidth: rect.width,
        mbHeight: rect.height,
    }
    document.body.classList.add('resizing-console')
}

// Mousemove document-level : dispatch selon le flag. Pas de
// transition CSS sinon le drag est lent/laggy.
const onConsoleMousemove = (e) => {
    if (!state.consoleMoving && !state.consoleResizing) return
    if (!state.messageBoard) return
    if (!state.consoleDragStart) return
    const dx = e.clientX - state.consoleDragStart.mouseX
    const dy = e.clientY - state.consoleDragStart.mouseY
    if (state.consoleMoving) {
        state.messageBoard.style.left = (state.consoleDragStart.mbLeft + dx) + 'px'
        state.messageBoard.style.top = (state.consoleDragStart.mbTop + dy) + 'px'
    } else if (state.consoleResizing) {
        // Math aux minimums (80x30) pour eviter que
        // l'utilisateur ecrase le cadre a 0x0.
        const w = Math.max(CONSOLE_MIN_WIDTH, state.consoleDragStart.mbWidth + dx)
        const h = Math.max(CONSOLE_MIN_HEIGHT, state.consoleDragStart.mbHeight + dy)
        state.messageBoard.style.width = w + 'px'
        state.messageBoard.style.height = h + 'px'
    }
}

// Mouseup document-level : reset flags + persist. Persist
// uniquement a la fin du drag (pas pendant le mousemove) car
// localStorage n'est pas concu pour du haut debit.
const onConsoleMouseup = (e) => {
    if (e.button !== 0) return
    if (!state.consoleMoving && !state.consoleResizing) return
    state.consoleMoving = false
    state.consoleResizing = false
    state.consoleDragStart = null
    document.body.classList.remove('dragging-console')
    document.body.classList.remove('resizing-console')
    persistConsoleFrame()
}

// Edge case : si l'utilisateur commence un drag, puis change
// de fenetre/alt-tab pendant le drag, le mouseup peut etre
// rate. Sans ce handler, les flags restent a true
// indefiniment et le prochain mousemove reprendrait le drag
// en utilisant un ancien dragStart — comportement bizarre.
// Reset propre au blur.
const onWindowBlur = () => {
    if (!state.consoleMoving && !state.consoleResizing) return
    state.consoleMoving = false
    state.consoleResizing = false
    state.consoleDragStart = null
    document.body.classList.remove('dragging-console')
    document.body.classList.remove('resizing-console')
    persistConsoleFrame()
}

export const wireConsoleOverlay = () => {
    const titleBar = document.querySelector('#consoleTitleBar')
    const resizeHandle = document.querySelector('#consoleResizeHandle')
    if (titleBar) titleBar.addEventListener('mousedown', onConsoleTitleMousedown)
    if (resizeHandle) resizeHandle.addEventListener('mousedown', onConsoleResizeMousedown)
    document.addEventListener('mousemove', onConsoleMousemove)
    document.addEventListener('mouseup', onConsoleMouseup)
    window.addEventListener('blur', onWindowBlur)
}

// ===== Clear =====

// Efface le contenu de la console. Le bouton #clearConsole
// est rendu inoperant quand la console est cachee par
// toggleConsole (display:none sur #messageBoard cache aussi
// son contenu). Pas de confirmation : les logs sont
// ephemeres, pas un etat irreversible.
export const clearConsole = () => {
    if (!state.messageLog) return
    state.messageLog.innerText = ''
}

// stopPropagation sur mousedown : empeche le drag du bandeau
// parent de se declencher quand l'utilisateur veut juste
// effacer la console.
export const wireClearConsole = () => {
    const btn = document.querySelector('#clearConsole')
    if (!btn) return
    btn.addEventListener('mousedown', (e) => e.stopPropagation())
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        clearConsole()
    })
}
