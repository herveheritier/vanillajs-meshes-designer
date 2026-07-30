// Module modals.js : modales "generiques" (Help + Reset).
//
// La modale d'import reste dans io.js (couplee a la
// logique d'import : le callback declenche applyImport qui
// depend de io). La modale de suppression de forme reste
// dans shapes.js (couplee a performDeleteShape).
//
// Dependances :
//   - state.js : state.shapes (legacy), state.ctx (rotation HUD)
//   - log.js : import modal absent -> 'replace' par defaut
//
// Convention ES6 : tout en const.

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

// Bouton "Fermer" + clic sur le backdrop ferment l'aide.
// Voir modals associes (importModal, resetModal) pour le
// pattern data-help-close.
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
