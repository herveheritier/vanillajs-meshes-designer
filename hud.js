// Rationale : voir DESIGN.md §1.2

import { state } from './state.js'
import { SHAPE_DEFS } from './constants.js'

// ===== Commentaire d'action (HUD) =====
// Toast contextuel à deux sources (cf. DESIGN.md §7.15) :
//   - showHoverComment (SURVOL, prioritaire) : dit ce que le geste sur
//     l'élément sous le pointeur permet de faire ; reste affiché tant
//     que le survol dure (pas de timer).
//   - showActionComment (POST-ACTION, ~3 s) : rappel du geste suivant,
//     remplacé par le survol dès qu'un élément est survolé.
// Timers au niveau module (effets de bord UI transitoires, jamais
// persistés) ; hud.js ne lit que state (pas de cycle d'imports).
const ACTION_COMMENT_DURATION = 3000
// Vide le texte après le fondu d'opacité (pas de contenu fantôme invisible).
const ACTION_COMMENT_FADE = 350
let actionCommentTimer = null
// Token de génération : un post-action ne retire la classe que s'il est
// toujours le dernier appel (un survol intervenu entre-temps l'invalide).
let actionCommentToken = 0
// Source du message courant : 'action' | 'hover' | null.
let actionCommentSource = null

// Message de survol : aucun timer, invalide tout post-action en attente.
// Dédup : même texte + source 'hover' + classe visible = pas de
// ré-écriture DOM à chaque mousemove (mais ré-affichage si un
// post-action vient d'expirer entre-temps).
export const showHoverComment = (text) => {
    const el = document.querySelector('#actionComment')
    if (!el) return
    if (actionCommentSource === 'hover'
        && el.classList.contains('action-comment-visible')
        && el.textContent === text) {
        return
    }
    actionCommentToken++
    actionCommentSource = 'hover'
    clearTimeout(actionCommentTimer)
    el.textContent = text
    el.classList.add('action-comment-visible')
}

// Message post-action : ~3 s puis fondu, sauf si un survol a pris la
// main entre-temps (token changé).
export const showActionComment = (text) => {
    const el = document.querySelector('#actionComment')
    if (!el) return
    const myToken = ++actionCommentToken
    actionCommentSource = 'action'
    clearTimeout(actionCommentTimer)
    el.textContent = text
    el.classList.add('action-comment-visible')
    actionCommentTimer = setTimeout(() => {
        // Un survol (ou une autre action) est passé entre-temps : ne pas effacer son message.
        if (actionCommentToken !== myToken) return
        actionCommentSource = null
        el.classList.remove('action-comment-visible')
        // Vide le texte APRÈS le fondu (pas de contenu fantôme invisible).
        setTimeout(() => {
            if (actionCommentToken === myToken) {
                el.textContent = ''
            }
        }, ACTION_COMMENT_FADE)
    }, ACTION_COMMENT_DURATION)
}

// Un post-action est affiché : la zone vide le laisse finir ses 3 s.
export const isActionCommentActive = () => actionCommentSource === 'action'

export const updateShapeHud = () => {
    const label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = `${state.activeShapeIndex + 1}/${state.shapes.length}`
    // Bornes de l'ordre : monter inutile si déjà dernière, descendre si déjà première.
    const upBtn = document.querySelector('#moveShapeUp')
    const downBtn = document.querySelector('#moveShapeDown')
    if (upBtn) upBtn.disabled = state.activeShapeIndex >= state.shapes.length - 1
    if (downBtn) downBtn.disabled = state.activeShapeIndex <= 0
}

export const updateUndoRedoHud = () => {
    const countEl = document.querySelector('#undoCount')
    const undoEl = document.querySelector('#undo')
    const redoEl = document.querySelector('#redo')
    if (countEl) countEl.textContent = `(${state.historyStack.length})`
    if (undoEl) undoEl.disabled = state.historyStack.length === 0
    if (redoEl) redoEl.disabled = state.redoStack.length === 0
}

export const updateSelectionHud = () => {
    const countEl = document.querySelector('#selectionCount')
    if (countEl) countEl.textContent = state.selectedPoints.length
    // Fusion par déplacement (cf. DESIGN.md §7.11) : désarmée dès que la
    // sélection n'est plus exactement 1 point. Garde locale à hud.js
    // (pas d'import de merge.js — cycle interdit).
    if (state.mergeOnDropActive && state.selectedPoints.length !== 1) {
        state.mergeOnDropActive = false
        state.mergeOnDropLocked = false
        state.mergeDropCandidate = undefined
        updateMergeButtonState()
    }
    // Boutons presse-papiers et panneau d'alignement : resynchronisés à
    // chaque mutation de sélection.
    updateClipboardButtons()
    updateAlignPanelButtons()
}

// État du bouton #align : classe .align-panel-open = panneau déployé
// (source de vérité : state.alignPanelOpen). Ne lit que state.
export const updateAlignButton = () => {
    const btn = document.querySelector('#align')
    if (!btn) return
    btn.classList.toggle('align-panel-open', !!state.alignPanelOpen)
    btn.setAttribute('aria-pressed', state.alignPanelOpen ? 'true' : 'false')
}

// Disabled des 4 actions du panneau #align : aligner >= 2 points,
// répartir >= 3 (deux extrêmes + un point intermédiaire).
export const updateAlignPanelButtons = () => {
    const n = state.selectedPoints.length
    const alignBtn = ['alignX', 'alignY']
    const distributeBtn = ['distributeX', 'distributeY']
    alignBtn.forEach((id) => {
        const btn = document.querySelector('#' + id)
        if (btn) btn.disabled = n < 2
    })
    distributeBtn.forEach((id) => {
        const btn = document.querySelector('#' + id)
        if (btn) btn.disabled = n < 3
    })
}

// Disabled de #copy/#cut (sélection non vide) et #paste (presse-papiers rempli).
export const updateClipboardButtons = () => {
    const copyBtn = document.querySelector('#copy')
    const cutBtn = document.querySelector('#cut')
    const pasteBtn = document.querySelector('#paste')
    const hasSelection = state.selectedPoints.length > 0
    if (copyBtn) copyBtn.disabled = !hasSelection
    if (cutBtn) cutBtn.disabled = !hasSelection
    const clip = state.clipboard
    const hasClipboard = !!clip && Array.isArray(clip.points) && clip.points.length > 0
    if (pasteBtn) pasteBtn.disabled = !hasClipboard
}

// État du bouton #mergePoints : accent vert quand armé + libellé du
// rayon (#mergeDropText) + title du geste ; classe .merge-locked
// quand verrouillé (icône cadenas). Sources de vérité : les champs
// merge* de state.
export const updateMergeButtonState = () => {
    const btn = document.querySelector('#mergePoints')
    if (!btn) return
    const armed = !!state.mergeOnDropActive
    const locked = armed && !!state.mergeOnDropLocked
    btn.classList.toggle('merge-armed', armed)
    btn.classList.toggle('merge-locked', locked)
    btn.setAttribute('aria-pressed', armed ? 'true' : 'false')
    btn.setAttribute('title', armed
        ? locked
            ? `Fusion par déplacement VERROUILLÉE : le mode reste armé après chaque fusion, enchaînez ` +
              `les fusions sans réarmer. Glissez le point sélectionné puis relâchez-le près d'un autre ` +
              `point (rayon ${state.mergeDropRadius} px à l'écran — molette sur ce bouton pour le régler). ` +
              `Re-cliquez pour désarmer.`
            : `Fusion par déplacement armée : glissez le point sélectionné puis relâchez-le près d'un autre point ` +
              `(rayon ${state.mergeDropRadius} px à l'écran, indépendant du zoom — molette sur ce bouton pour le régler) ` +
              `pour le fusionner avec lui. Re-cliquez pour verrouiller le mode (enchaînement de fusions), ` +
              `un autre clic le désarme.`
        : 'Fusionner les points sélectionnés vers une position commune (le centroid). ' +
          'Avec un seul point sélectionné : arme la fusion par déplacement ' +
          '(glisser le point puis le relâcher près d\'un autre le fusionne avec lui ; ' +
          `la molette sur ce bouton règle le rayon, actuellement ${state.mergeDropRadius} px à l'écran).`)
    // Libellé du rayon (vide hors mode armé) ; l'icône cadenas est
    // pilotée par la classe .merge-locked via CSS.
    const text = btn.querySelector('#mergeDropText')
    if (text) text.textContent = armed ? `${state.mergeDropRadius}px` : ''
}

export const updateGridButtonText = () => {
    const gridText = document.querySelector('#gridText')
    const gridBtn = document.querySelector('#grid')
    if (!gridText || !gridBtn) return
    gridText.textContent = `${state.GRID_STEP}px`
    gridBtn.classList.toggle('grid-active', !!state.activeGrid)
}

export const updateReticleButton = () => {
    const btn = document.querySelector('#reticle')
    const text = document.querySelector('#reticleText')
    if (btn) btn.classList.toggle('reticle-active', state.reticleMode >= 1)
    if (text) text.textContent = state.reticleMode === 0 ? '' : String(state.reticleMode)
}

export const updateSelectionModeButton = () => {
    const btn = document.querySelector('#selectionMode')
    const text = document.querySelector('#selectionModeText')
    // Libellé français aligné sur le title="sommet / segment / triangle" du bouton.
    const labels = { vertex: 'sommet', segment: 'segment', triangle: 'triangle' }
    const label = labels[state.selectionMode] || ''
    if (btn) btn.classList.toggle('selection-mode-active', state.selectionMode !== 'vertex')
    if (text) text.textContent = label
}

export const updateConsoleButton = () => {
    const btn = document.querySelector('#toggleConsole')
    if (!btn) return
    btn.classList.toggle('console-active', !!state.consoleVisible)
    btn.setAttribute('aria-pressed', state.consoleVisible ? 'true' : 'false')
    if (state.messageBoard) state.messageBoard.style.display = state.consoleVisible ? '' : 'none'
}

export const updateAccessibilityLabels = () => {
    document.querySelectorAll('#toolbar button, .modal button, #triangleColorPanel button').forEach((button) => {
        if (!button.getAttribute('aria-label')) {
            const label = button.getAttribute('title') || button.textContent.trim()
            if (label) button.setAttribute('aria-label', label)
        }
    })
}

// Indicateur de non-sauvegarde : bullet lisible en petite taille et
// sémantiquement neutre (vs `*`), isolé du nom par un leading space.
const SCENE_DIRTY_INDICATOR = ' •'
const SCENE_DIRTY_INDICATOR_FOR_ARIA = ' (non sauvegardée)'

export const updateSceneStatus = () => {
    const status = document.querySelector('#sceneStatus')
    if (!status) return
    const baseName = (typeof state.sceneName === 'string' && state.sceneName.length > 0)
        ? state.sceneName
        : 'nouvelleScene'
    const displayText = state.sceneDirty ? baseName + SCENE_DIRTY_INDICATOR : baseName
    status.textContent = displayText
    status.dataset.dirty = state.sceneDirty ? 'true' : 'false'
    const ariaLabel = state.sceneDirty ? baseName + SCENE_DIRTY_INDICATOR_FOR_ARIA : baseName
    status.setAttribute('aria-label', ariaLabel)
    // Tooltip miroir de l'aria-label (lecteurs d'écran + survol souris).
    status.setAttribute('title', ariaLabel)
}

export const updateShapesButton = () => {
    const btn = document.querySelector('#shapes')
    const text = document.querySelector('#shapesText')
    if (btn) {
        // Panneau ouvert ou outil arme (forme / cercle / etoile / anneau).
        btn.classList.toggle('shapes-panel-open', !!state.shapesPanelOpen)
        btn.classList.toggle('shapes-armed', state.shapeKind !== undefined || !!state.circleMode || !!state.starMode || !!state.annulusMode)
        btn.setAttribute('aria-pressed', state.shapesPanelOpen ? 'true' : 'false')
    }
    // Libellé : forme armée, « cercle N » / « anneau N » / « étoile », vide sinon.
    if (text) {
        if (state.circleMode) {
            text.textContent = 'cercle ' + state.circleSegments
        } else if (state.annulusMode) {
            text.textContent = 'anneau ' + state.circleSegments
        } else if (state.starMode) {
            const def = SHAPE_DEFS.star
            text.textContent = def ? def.label : 'étoile'
        } else {
            const def = state.shapeKind !== undefined ? SHAPE_DEFS[state.shapeKind] : undefined
            text.textContent = def ? def.label : ''
        }
    }
}

// Bouton #triangleColor : toujours actif (le pinceau peint sans
// pré-sélection). Trois états : neutre, .color-panel-open (palette
// déployée), .color-active (déployée ET brushMode armé).
export const updateColorButtonState = () => {
    const btn = document.querySelector('#triangleColor')
    if (!btn) return
    btn.disabled = false
    const panelOpen = !!state.isTriangleColorPanelOpen
    btn.classList.toggle('color-panel-open', panelOpen)
    btn.classList.toggle('color-active', panelOpen && !!state.brushMode)
}
