import { state } from './state.js'
import { getSavedSceneNames } from './io.js'

// ===== Help modal =====

const helpModal = () => document.querySelector('#helpModal')

export const showHelp = () => {
    const m = helpModal()
    if (!m) return
    state.lastFocusedElement = document.activeElement
    m.hidden = false
    m.setAttribute('aria-hidden', 'false')
    const closeBtn = document.querySelector('#helpClose')
    if (closeBtn) closeBtn.focus()
}

export const hideHelp = () => {
    const m = helpModal()
    if (!m) return
    m.hidden = true
    m.setAttribute('aria-hidden', 'true')
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
    state.lastFocusedElement = undefined
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
    state.lastFocusedElement = document.activeElement
    m.hidden = false
    m.setAttribute('aria-hidden', 'false')
    const cancelBtn = document.querySelector('#resetModalCancel')
    if (cancelBtn) cancelBtn.focus()
}

export const hideResetModal = () => {
    const m = resetModal()
    if (!m) return
    m.hidden = true
    m.setAttribute('aria-hidden', 'true')
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
    state.lastFocusedElement = undefined
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

// ===== Fenêtre d'enregistrement de la scène =====
// Liste des emplacements deja sauvegardes (io.js) avec renommage,
// positionnee sur l'emplacement precedent. Le nom choisi devient le
// nom de scene (HUD + wire format) et le fichier « <nom>.json ».


const saveModal = () => document.querySelector('#saveModal')

// Garde anti-réentrance : un second Ctrl+S / clic sur #export pendant
// que la fenêtre est ouverte ne doit pas la reconstruire (le focus
// resterait piégé).
let saveModalShown = false
let saveValidateHandler = null

// Rangée « courante » sur l'emplacement correspondant au texte du champ.
const syncCurrentSaveSlot = () => {
    const slots = document.querySelector('#saveSlots')
    const nameInput = document.querySelector('#saveName')
    if (!slots || !nameInput) return
    const value = nameInput.value.trim()
    slots.querySelectorAll('.save-slot').forEach(row => {
        row.classList.toggle('current', row.dataset.name === value)
    })
}

const validateSave = () => {
    // Anti-reentrance : Enter maintenu ou double-clic ne doit pas
    // declencher deux telechargements.
    if (!saveModalShown) return
    const nameInput = document.querySelector('#saveName')
    if (!nameInput) return
    const name = nameInput.value.trim()
    if (name.length === 0) {
        // Nom vide : rien à enregistrer — on reste sur la fenêtre, le
        // champ reprend le focus pour corriger.
        nameInput.focus()
        return
    }
    hideSaveModal()
    if (typeof saveValidateHandler === 'function') saveValidateHandler(name)
}

export const showSaveModal = () => {
    const m = saveModal()
    if (!m || saveModalShown) return
    saveModalShown = true
    state.lastFocusedElement = document.activeElement

    // « Emplacement precedent » = le plus recent (tete de liste).
    const names = getSavedSceneNames()
    const previous = names.length > 0 ? names[0] : null
    const currentName = (typeof state.sceneName === 'string' && state.sceneName.trim().length > 0)
        ? state.sceneName.trim()
        : 'nouvelleScene'
    // Positionnement sur l'emplacement précédent ; sans historique,
    // on propose le nom courant de la scène (importé ou par défaut).
    const defaultName = previous || currentName

    const info = document.querySelector('#saveModalInfo')
    if (info) {
        info.textContent = 'Scène actuelle : ' + currentName + (state.sceneDirty ? ' (modifiée)' : '')
    }

    const slots = document.querySelector('#saveSlots')
    if (slots) {
        slots.textContent = ''
        if (names.length === 0) {
            const hint = document.createElement('div')
            hint.className = 'save-slots-empty'
            hint.textContent = 'Aucun enregistrement précédent.'
            slots.appendChild(hint)
        } else {
            names.forEach((name, i) => {
                const row = document.createElement('button')
                row.type = 'button'
                row.className = 'save-slot'
                row.dataset.name = name
                row.setAttribute('aria-label', 'Enregistrer sous « ' + name + ' »')
                const nameSpan = document.createElement('span')
                nameSpan.className = 'save-slot-name'
                nameSpan.textContent = name
                const rankSpan = document.createElement('span')
                rankSpan.className = 'save-slot-rank'
                rankSpan.textContent = i === 0 ? 'précédent' : ''
                row.appendChild(nameSpan)
                row.appendChild(rankSpan)
                row.addEventListener('click', () => {
                    const nameInput = document.querySelector('#saveName')
                    if (nameInput) {
                        nameInput.value = name
                        nameInput.focus()
                        nameInput.select()
                    }
                    syncCurrentSaveSlot()
                })
                slots.appendChild(row)
            })
        }
    }

    const nameInput = document.querySelector('#saveName')
    if (nameInput) nameInput.value = defaultName
    syncCurrentSaveSlot()

    m.hidden = false
    m.setAttribute('aria-hidden', 'false')
    // Focus + select apres l'affichage (no-op sur un container display:none).
    if (nameInput) {
        nameInput.focus()
        nameInput.select()
    }
}

export const hideSaveModal = () => {
    const m = saveModal()
    if (!m) return
    m.hidden = true
    m.setAttribute('aria-hidden', 'true')
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus()
    state.lastFocusedElement = undefined
    saveModalShown = false
}

export const wireSaveModal = (onValidate) => {
    saveValidateHandler = onValidate
    const m = saveModal()
    if (!m) return
    const cancelBtn = document.querySelector('#saveModalCancel')
    const validateBtn = document.querySelector('#saveModalValidate')
    const nameInput = document.querySelector('#saveName')
    if (cancelBtn) cancelBtn.addEventListener('click', () => hideSaveModal())
    if (validateBtn) validateBtn.addEventListener('click', () => validateSave())
    if (nameInput) {
        // Entrée dans le champ valide l'enregistrement.
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                validateSave()
            }
        })
        // La rangée « courante » suit le texte du champ pendant la frappe.
        nameInput.addEventListener('input', syncCurrentSaveSlot)
    }
    m.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.saveClose !== undefined) hideSaveModal()
    })
}
