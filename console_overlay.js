import { state } from './state.js'
import {
    CONSOLE_MIN_WIDTH, CONSOLE_MIN_HEIGHT, CONSOLE_FRAME_STORAGE_KEY,
} from './constants.js'

// ===== Frame (position/taille) =====

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

// Rationale : voir DESIGN.md §6
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

// Rationale : voir DESIGN.md §3.1
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
        const w = Math.max(CONSOLE_MIN_WIDTH, state.consoleDragStart.mbWidth + dx)
        const h = Math.max(CONSOLE_MIN_HEIGHT, state.consoleDragStart.mbHeight + dy)
        state.messageBoard.style.width = w + 'px'
        state.messageBoard.style.height = h + 'px'
    }
}

// Rationale : voir DESIGN.md §1.1
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

export const clearConsole = () => {
    if (!state.messageLog) return
    state.messageLog.innerText = ''
}

export const wireClearConsole = () => {
    const btn = document.querySelector('#clearConsole')
    if (!btn) return
    btn.addEventListener('mousedown', (e) => e.stopPropagation())
    btn.addEventListener('click', (e) => {
        if (e.button !== 0) return
        clearConsole()
    })
}
