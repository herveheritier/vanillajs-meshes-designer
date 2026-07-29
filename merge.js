// Module merge.js : fusion des points selectionnes d'une forme.
//
// Regle de la fusion (cf. demande utilisateur) : elle n'est
// effectuee que si AUCUN triangle de la forme active ne
// contient 2 sommets (ou plus) parmi state.selectedPoints.
// Sinon, fusionner deux sommets d'un meme triangle le
// rendrait degenere (deux sommets superposes = aire nulle).
//
// Strategie :
//   1. Validation "cote triangle" : pour chaque triangle de
//      activeTriangles(), compter le nombre de slots (p1, p2,
//      p3) dont le contenu est dans selectedPoints au sens
//      POSITION (on utilise isPointSelected, qui dedup par
//      adjacentPoints 0.01). Si count >= 2 sur un triangle,
//      CONFIT -> modal. Compter cote triangle (et non cote
//      selection) evite le double-comptage d'un cluster de
//      refs identiques dans selected.
//   2. Calcul du "centre de la fusion" : moyenne x/y sur les
//      POSITIONS UNIQUES (dedup par adjacentPoints 0.01). Si
//      4 refs identiques au meme endroit sont selectionnees,
//      elles comptent comme 1 seule position, sinon la
//      moyenne serait biaisee par le cluster.
//   3. Cible : state.selectedPoints[0] (premiere ref). Toutes
//      les autres refs selectionnees seront redirigees vers
//      celle-ci via les slots des triangles. Utiliser
//      isPointSelected (pas indexOf) pour le test de
//      position couvre les clusters de refs distinctes au
//      meme endroit.
//   4. Selection videe apres la fusion (input consomme).
//   5. saveState (undo) + persistState (localStorage) +
//      drawBoard + updateMouseHover + updateSelectionHud.
//
// Dependances : state, geometry, draw, hud, history, io,
// editor, log. Pas de cycle : merge.js est importe par
// main.js uniquement.

import { state } from './state.js'
import { activeTriangles, adjacentPoints, isPointSelected } from './geometry.js'
import { ACTION_NONE } from './constants.js'
import { drawBoard } from './draw.js'
import { updateSelectionHud } from './hud.js'
import { saveState } from './history.js'
import { persistState } from './io.js'
import { updateMouseHover } from './editor.js'
import { log } from './log.js'

// ===== Modal helpers =====
// Meme charte que #deleteShapeModal / #resetModal (helper de
// query defensif, classe .modal + .modal-box partagees en CSS).
const mergeErrorModal = () => document.querySelector('#mergeErrorModal')
const mergeErrorModalInfo = () => document.querySelector('#mergeErrorModalInfo')

export const showMergeErrorModal = (info) => {
    const m = mergeErrorModal()
    const infoEl = mergeErrorModalInfo()
    if (!m || !infoEl) return
    infoEl.textContent = info
    m.hidden = false
}

export const hideMergeErrorModal = () => {
    const m = mergeErrorModal()
    if (m) m.hidden = true
}

export const wireMergeErrorModal = () => {
    const m = mergeErrorModal()
    const closeBtn = document.querySelector('#mergeErrorModalClose')
    if (closeBtn) closeBtn.addEventListener('click', () => hideMergeErrorModal())
    if (m) m.addEventListener('click', (e) => {
        const target = e.target
        if (target && target.dataset && target.dataset.mergeErrorClose !== undefined) hideMergeErrorModal()
    })
}

// ===== Validation =====

// Compte les REFS DISTINCTES de points selectionnes dans un
// triangle. Le dedup se fait par IDENTITE de reference (Set),
// pas par position toleree : si un triangle porte p1 === p2
// (cas degenere : meme ref sur 2 slots), une seule ref doit
// compter, conformement a la regle utilisateur ("un ou
// plusieurs AUTRES points selectionnes"). Cela laisse passer
// un triangle degenere deja present dans la scene (topologie
// imposee par l'utilisateur). On utilise isPointSelected
// (tol 0.01) pour savoir si le slot est selectionne, mais on
// COMPTE par identite, pas par position tolerante.
const countSelectedSlots = (tri) => {
    const seen = new Set()
    let count = 0
    if (tri.p1 && isPointSelected(tri.p1) && !seen.has(tri.p1)) {
        count++
        seen.add(tri.p1)
    }
    if (tri.p2 && isPointSelected(tri.p2) && !seen.has(tri.p2)) {
        count++
        seen.add(tri.p2)
    }
    if (tri.p3 && isPointSelected(tri.p3) && !seen.has(tri.p3)) {
        count++
        seen.add(tri.p3)
    }
    return count
}

// Renvoie la liste (1-based) des triangles de la forme
// active qui ont >= 2 sommets selectionnes. Renvoie []
// si la contrainte est OK.
const findMergeConflicts = () => {
    const tris = activeTriangles()
    const conflicting = []
    tris.forEach((t, i) => {
        if (countSelectedSlots(t) >= 2) conflicting.push(i + 1)
    })
    return conflicting
}

// ===== Centroid =====

// Moyenne x/y sur les POSITIONS UNIQUES (dedup par
// adjacentPoints 0.01) parmi state.selectedPoints. Evite le
// biais des clusters : si 4 refs identiques sont
// selectionnees, elles comptent comme 1 seule position.
// Renvoie {x, y} (defaut 0, 0 si rien — ne devrait pas
// arriver car la fusion requiert >= 2 points).
const computeMergeCentroid = () => {
    const selected = state.selectedPoints
    const uniquePositions = []
    selected.forEach((sp) => {
        if (!uniquePositions.some((up) => adjacentPoints(up, sp, 0.01))) {
            uniquePositions.push(sp)
        }
    })
    if (uniquePositions.length === 0) return { x: 0, y: 0 }
    const sum = uniquePositions.reduce(
        (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
        { x: 0, y: 0 }
    )
    return {
        x: sum.x / uniquePositions.length,
        y: sum.y / uniquePositions.length,
    }
}

// ===== Merge =====

// Effectue la fusion ou affiche la modale d'erreur.
// Renvoie true si la fusion a ete effectuee, false sinon.
export const mergeSelectedPoints = () => {
    const selected = state.selectedPoints

    // Cas 1 : pas assez de points.
    if (selected.length < 2) {
        showMergeErrorModal(
            `Sélection insuffisante : la fusion nécessite au moins 2 points.\n` +
            `Sélection actuelle : ${selected.length}.`
        )
        return false
    }

    // Cas 2 : conflit topologique (au moins un triangle
    // partage 2 sommets selectionnes). Affiche la liste
    // des indices de triangles concernes (tronquee au
    // dela de 6 pour rester lisible).
    const conflicting = findMergeConflicts()
    if (conflicting.length > 0) {
        const idxList = conflicting.length <= 6
            ? conflicting.join(', ')
            : conflicting.slice(0, 6).join(', ') + ` (+${conflicting.length - 6})`
        showMergeErrorModal(
            `Fusion impossible : ${conflicting.length} triangle(s) contiennent plusieurs points ` +
            `sélectionnés (indices : ${idxList}).\n` +
            `Chaque triangle ne peut avoir qu'un seul sommet sélectionné pour pouvoir ` +
            `être fusionné sans devenir dégénéré.`
        )
        return false
    }

    // Cas OK : on y va.
    const centroid = computeMergeCentroid()
    const target = selected[0]

    // Redirection : pour chaque triangle de la forme
    // active, tout slot dont le POINT est selectionne (au
    // sens position, via isPointSelected) ET n'est pas la
    // cible est redirige vers cette cible. Cela couvre
    // les clusters de refs distinctes : si une ref
    // distincte A' partage la position de la cible A,
    // isPointSelected(A') === true et A' !== target =>
    // redirection.
    const tris = activeTriangles()
    tris.forEach((t) => {
        ['p1', 'p2', 'p3'].forEach((pid) => {
            const p = t[pid]
            if (!p) return
            if (p !== target && isPointSelected(p)) {
                t[pid] = target
            }
        })
    })

    // La cible absorbe toutes les autres positions et
    // s'installe au centroid.
    target.x = centroid.x
    target.y = centroid.y

    // Cleanup complet : consommation de la selection,
    // reset des actions en cours, vidage du hover/grab,
    // mise a jour HUD/persistance.
    saveState()
    state.selectedPoints = []
    state.nearestPoint = undefined
    state.nearestLine = undefined
    state.grabbedGroup = []
    state.currentAction = ACTION_NONE
    state.isSelectingBox = false
    state.selectionBoxStart = undefined
    state.selectionBoxCurrent = undefined
    clearTimeout(state.wheelRotateTimer)
    state.wheelRotateTimer = undefined
    state.isWheelRotating = false
    clearTimeout(state.eachShapeRotateTimer)
    state.eachShapeRotateTimer = undefined
    state.isEachShapeRotating = false
    drawBoard()
    if (state.lastMousePos) updateMouseHover(state.lastMousePos)
    updateSelectionHud()
    persistState()
    log(
        `Fusion : ${selected.length} ref(s) -> 1 point cible au centroid ` +
        `(${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)})`
    )
    return true
}
