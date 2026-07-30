import { state } from './state.js'

// ===== Help modal =====

const helpModal = () => document.querySelector('#helpModal')

export const showHelp = () => {
    const m = helpModal()
    if (!m) return
    m.hidden = false
}

export const hideHelp = () => {
    const m = helpModal()
    if (!m) return
    m.hidden = true
}

export const wireHelpModal = () => {
    const m = helpModal()
    if (!m) return
    const closeBtn = document.querySelector('#helpClose')
    if (closeBtn) closeBtn.addEventListener('click', () => hideHelp())
    m.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.helpClose !== undefined) hideHelp()
    })
}

// ===== Reset modal =====

const resetModal = () => document.querySelector('#resetModal')

export const showResetModal = () => {
    const m = resetModal()
    if (!m) return
    m.hidden = false
}

export const hideResetModal = () => {
    const m = resetModal()
    if (!m) return
    m.hidden = true
}

export const wireResetModal = (onValidate) => {
    const m = resetModal()
    if (!m) return
    const cancelBtn = document.querySelector('#resetModalCancel')
    const validateBtn = document.querySelector('#resetModalValidate')
    if (cancelBtn) cancelBtn.addEventListener('click', () => hideResetModal())
    if (validateBtn) validateBtn.addEventListener('click', () => {
        hideResetModal()
        onValidate()
    })
    m.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.resetClose !== undefined) hideResetModal()
    })
}
