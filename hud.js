// Rationale : voir DESIGN.md §1.2

import { state } from './state.js'
import { SHAPE_DEFS } from './constants.js'

export const updateShapeHud = () => {
    const label = document.querySelector('#shapeLabel')
    if (!label) return
    label.textContent = `${state.activeShapeIndex + 1}/${state.shapes.length}`
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
    // (fusion par déplacement, cf. DESIGN.md §7.11) la 2e fonction du
    // bouton Fusionner n'est utilisable que si exactement 1 point est
    // sélectionné ; toute autre taille de sélection la désarme
    // immédiatement. Garde locale à hud.js (pas d'import de merge.js,
    // qui importerait hud.js en retour — cycle interdit, cf. §1.1).
    if (state.mergeOnDropActive && state.selectedPoints.length !== 1) {
        state.mergeOnDropActive = false
        state.mergeDropCandidate = undefined
        updateMergeButtonState()
    }
}

// (fusion par déplacement, cf. DESIGN.md §7.11) — état visuel du
// bouton #mergePoints : accent vert (même langage que #fps.fps-active /
// #preview.preview-active) quand le mode est armé + libellé du rayon
// (#mergeDropText, « 20px » — même langage que #gridText) + title qui
// décrit le geste à effectuer. state.mergeOnDropActive / state.mergeDropRadius
// sont les sources de vérité ; classes/attributs/textes ne font que les
// refléter.
export const updateMergeButtonState = () => {
    const btn = document.querySelector('#mergePoints')
    if (!btn) return
    const armed = !!state.mergeOnDropActive
    btn.classList.toggle('merge-armed', armed)
    btn.setAttribute('aria-pressed', armed ? 'true' : 'false')
    btn.setAttribute('title', armed
        ? `Fusion par déplacement armée : glissez le point sélectionné puis relâchez-le près d'un autre point ` +
          `(rayon ${state.mergeDropRadius} px à l'écran, indépendant du zoom — molette sur ce bouton pour le régler) ` +
          `pour le fusionner avec lui. Re-cliquez pour désarmer.`
        : 'Fusionner les points sélectionnés vers une position commune (le centroid). ' +
          'Avec un seul point sélectionné : arme la fusion par déplacement ' +
          '(glisser le point puis le relâcher près d\'un autre le fusionne avec lui ; ' +
          `la molette sur ce bouton règle le rayon, actuellement ${state.mergeDropRadius} px à l'écran).`)
    // Libellé du rayon, vide hors mode armé (même comportement que
    // #shapesText qui n'affiche « cercle N » que quand le mode est actif).
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

// Marqueur visuel de non-sauvegarde : caractère bullet (U+2022)
// accolé au nom quand la scène a été mutée depuis le dernier
// save persistant. Le choix du bullet (vs asterisk ou +) tient en
// qu'il reste lisible même en petite taille (11px monospace)
// tout en étant sémantiquement neutre (pas un operateur de
// modification publique comme `*` qui pourrait évoquer un éditeur
// de texte WISIWYG). Le leading space isole le bullet du nom pour
// qu'il soit clairement perçu comme une annotation.
// Cf. spec utilisateur : « si la scène est modifiée alors mettre
// un indicateur de non sauvegarde à côté de son nom ».
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
    // Title (tooltip) reflete l'etat courant en francais.
    // Approfondit l'info aria pour les lecteurs d'ecran ET le
    // survol souris : « nouvelleScene non sauvegardée » /
    // « mesh-wail sauvegardée ».
    status.setAttribute('title', ariaLabel)
}

export const updateShapesButton = () => {
    const btn = document.querySelector('#shapes')
    const text = document.querySelector('#shapesText')
    if (btn) {
        // Quatre etats : panneau ouvert (bordure inset, comme
        // #triangleColor.color-panel-open), outil forme arme ou mode
        // cercle / étoile / anneau actif (accent vert + libellé).
        btn.classList.toggle('shapes-panel-open', !!state.shapesPanelOpen)
        btn.classList.toggle('shapes-armed', state.shapeKind !== undefined || !!state.circleMode || !!state.starMode || !!state.annulusMode)
        btn.setAttribute('aria-pressed', state.shapesPanelOpen ? 'true' : 'false')
    }
    // Libellé a cote de l'icone : nom de la forme armee, ou
    // « cercle N » / « anneau N » quand le mode cercle / anneau est
    // actif (N = nombre de cotes — meme langage que #gridText pour le
    // pas de grille), ou « étoile » quand le mode étoile (3 clics)
    // est actif ; vide quand rien n'est arme. textContent (pas
    // innerHTML) : chaine statique / entier.
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

// (evolution peinture) l'unique action du bouton #triangleColor est
// d'ouvrir/fermer la palette de couleurs, independamment du mode de
// selection et du contenu de la selection. L'ancien contrat
// (desactive hors mode triangle OU selection vide) est obsolete : le
// pinceau peut peindre des triangles en un clic, sans qu'aucun tri
// ne soit pre-selectionne.
// Trois etats visuels distincts (cf. classes CSS dans main.html) :
//   - etat neutre : bouton gris comme les autres (rien n'est ouvert, le
//     pinceau n'est pas armé).
//   - .color-panel-open : la palette est deployee (meme langage visuel
//     que #triangleColor.color-panel-open historique : ring inset vert).
//   - .color-active : la palette est deployee ET brushMode est vrai
//     (le curseur est en mode pinceau, un clic gauche peindra). Sur
//     cet etat, on ajoute en plus un accent vert fort (couleur,
//     bordure) pour distinguer "palette ouverte mais pinceau
//     desarme" (apres un clic sur Reset) de "palette ouverte avec
//     pinceau arme".
//
// Pas de raccourci pour basculer (la touche du bouton reste celle
// implicitement documentee par le title HTML). Meme API (juste
// updater les classes CSS), pas besoin de readapter les call sites
// (applyColorToSelectedTriangles reste exporte pour les tests et le
// panel historique).
export const updateColorButtonState = () => {
    const btn = document.querySelector('#triangleColor')
    if (!btn) return
    btn.disabled = false
    const panelOpen = !!state.isTriangleColorPanelOpen
    btn.classList.toggle('color-panel-open', panelOpen)
    btn.classList.toggle('color-active', panelOpen && !!state.brushMode)
}
