// Smoke test du commentaire contextuel dans le HUD (évolution « message
// prospectif ») — playwright.
//
// Logique du toast #actionComment : message PROSPECTIF piloté par le
// SURVOL — quand un élément est en surbrillance sous le pointeur, le
// toast dit ce que le geste permet de faire (« Clic gauche pour créer
// un nouveau triangle à partir de ce segment »). Hiérarchie
// (cf. DESIGN.md §7.15) : construction en cours > modes de construction
// (cercle/étoile/anneau/forme) > pinceau > survol d'élément (mode-aware)
// > zone vide (post-action qui finit ses 3 s, puis message générique).
//
// Parcours :
//   A. Boot : #actionComment existe, vide et invisible (aucun survol du
//      board avant le 1er mouvement).
//   B0. Survol d'une zone vide (scène vide) → message générique
//       « poser le 1er point ».
//   B1. Clic 1 → « Cliquez pour poser le 2e sommet… » (guide de
//       construction, PROSPECTIF — pas de compte-rendu « Point posé »).
//   B2. Clic 2 → « Cliquez pour poser le 3e sommet… ».
//   B3. Clic 3 → triangle fermé : post-action « brancher un nouveau
//       triangle ».
//   C. Survol du MILIEU du segment supérieur (l'élément est mis en
//       surbrillance) → « Clic gauche pour créer un nouveau triangle à
//       partir de ce segment » — l'exemple utilisateur.
//   C2-C4. Bascule de mode pendant le survol du même segment : le
//       message suit le mode (segment → « sélectionner ce segment »,
//       triangle → « sélectionner ce triangle », retour vertex →
//       « créer un nouveau triangle ») — la signature de survol inclut
//       selectionMode.
//   D. Survol du sommet 3 → « Clic gauche pour sélectionner ce sommet —
//       clic droit pour le déplacer ».
//   E. Survol d'une zone vide (forme fermée) → message générique
//       « survolez un segment pour y brancher… ».
//   F. Post-action + auto-disparition : Ctrl+Z (undo) → « rétablir »
//       (prospectif, pas « Annulé ») ; après ~3 s le toast redevient
//       invisible ; un petit mouvement le ré-affiche (générique).
//   G. Ctrl+Y (redo) → « Ctrl+Z pour annuler à nouveau ».
//   H. Preview : en preview (P) le toast est masqué (display none) ; à
//       la sortie (Échap) + un mouvement, il redevient visible.
//   I. Aucune erreur JS sur tout le parcours.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-comment.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Positions écran (viewport 1280×800) : triangle non dégénéré, loin de
// la toolbar et de la console (cf. smoke-edit). Les coords sont toutes
// divisibles par 10/20 (pas de grille par défaut) pour rester sur les
// sommets même après snapToGrid.
const CLICKS = [
    { x: 520, y: 300 },
    { x: 800, y: 300 },
    { x: 660, y: 520 },
]
// Milieu du segment supérieur (520,300)-(800,300) : survol « segment ».
const SEGMENT_MID = { x: 660, y: 300 }
// Le 3e sommet (position exacte du clic 3) : survol « point ».
const VERTEX3 = { x: 660, y: 520 }
// Zone vide : loin du triangle (x 520-800, y 300-520) et du HUD.
const EMPTY_ZONE = { x: 1100, y: 680 }

const { check, finish } = createHarness()

const browser = await launchBrowser()

// Erreurs JS collectées sur TOUTES les pages (pageerror + console.error,
// même pattern que smoke-align / smoke-clipboard) : attachErrorCollector
// retourne le tableau référencé par les listeners (rempli de façon
// asynchrone), on en garde la référence et on le déroule à la fin.
const pageErrors = []

// Ouvre une page avec la scène JSON seedée en localStorage AVANT le
// boot (addInitScript s'exécute sur le document avant les modules).
const openSeededPage = async (sceneJson) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = attachErrorCollector(page)
    pageErrors.push(errors)
    await page.addInitScript(({ key, value }) => {
        localStorage.setItem(key, value)
    }, { key: SCENE_STORAGE_KEY, value: sceneJson })
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    return page
}

// Déroule les erreurs de toutes les pages en une liste plate.
const allErrors = () => pageErrors.flat()

// Lecture directe du toast : texte + visibilité (classe CSS). L'état
// visible est porté par la classe .action-comment-visible (opacity 1
// via CSS) — c'est cette classe que showHoverComment / showActionComment
// posent et que le timer du post-action retire.
const commentState = (page) => page.evaluate(() => {
    const el = document.querySelector('#actionComment')
    if (!el) return { text: null, visible: false, exists: false }
    return {
        exists: true,
        text: el.textContent,
        visible: el.classList.contains('action-comment-visible'),
    }
})

// Scène vide seedée : évite toute dépendance au localStorage résiduel
// de la session précédente (pattern addInitScript des autres suites).
const EMPTY_SCENE = JSON.stringify({
    format: 'meshes-designer',
    version: 1,
    name: 'comment-test',
    shapes: [{ pointList: [], tris: [] }],
    activeShapeIndex: 0,
})

try {
    // ===== Phase A — boot : toast présent, vide et invisible =====
    let page = await openSeededPage(EMPTY_SCENE)
    let cs = await commentState(page)
    check('A : #actionComment existe au boot', cs.exists)
    check('A : toast vide au boot', cs.text === '')
    check('A : toast invisible au boot (aucun survol du board)', !cs.visible)

    // ===== Phase B0 — survol zone vide (scène vide) → générique =====
    await page.mouse.move(CLICKS[0].x, CLICKS[0].y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('B0 : survol zone vide (scène vide) → « poser le 1er point »', cs.visible && cs.text.includes('poser le 1er point'))

    // ===== Phase B — 3 clics : le guide de construction suit le geste =====
    await page.mouse.click(CLICKS[0].x, CLICKS[0].y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('B1 : clic 1 → « poser le 2e sommet » (prospectif)', cs.visible && cs.text.includes('poser le 2e sommet'))
    check('B1 : pas de compte-rendu (« Point posé » absent)', !cs.text.includes('Point posé'))

    await page.mouse.click(CLICKS[1].x, CLICKS[1].y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('B2 : clic 2 → « poser le 3e sommet » (prospectif)', cs.visible && cs.text.includes('poser le 3e sommet'))
    check('B2 : le 2e message remplace le 1er (pas « 2e sommet »)', !cs.text.includes('poser le 2e sommet'))

    await page.mouse.click(CLICKS[2].x, CLICKS[2].y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('B3 : clic 3 → « brancher un nouveau triangle » (prospectif)', cs.visible && cs.text.includes('brancher un nouveau triangle'))

    // ===== Phase C — survol d'un segment en surbrillance =====
    // L'exemple fondateur de l'utilisateur : le pointeur approché d'un
    // côté de triangle (mis en surbrillance) dit ce que le geste permet.
    await page.mouse.move(SEGMENT_MID.x, SEGMENT_MID.y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('C : survol segment → « créer un nouveau triangle à partir de ce segment »', cs.visible && cs.text.includes('créer un nouveau triangle à partir de ce segment'))
    check('C : le geste annoncé est le clic GAUCHE (geste réel)', cs.text.includes('Clic gauche'))

    // ===== Phase C2-C4 — bascule de mode pendant le survol du même
    // segment : le message doit suivre le mode (le bouton #selectionMode
    // cycle vertex → segment → triangle → vertex et appelle
    // updateMouseHover ; selectionMode fait partie de la signature de
    // survol). =====
    await page.click('#selectionMode')
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('C2 : mode segment → « sélectionner ce segment »', cs.visible && cs.text.includes('sélectionner ce segment'))

    await page.click('#selectionMode')
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('C3 : mode triangle → « sélectionner ce triangle »', cs.visible && cs.text.includes('sélectionner ce triangle'))

    await page.click('#selectionMode')
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('C4 : retour mode vertex → « créer un nouveau triangle »', cs.visible && cs.text.includes('créer un nouveau triangle à partir de ce segment'))

    // ===== Phase D — survol d'un sommet =====
    await page.mouse.move(VERTEX3.x, VERTEX3.y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('D : survol sommet → « sélectionner ce sommet — clic droit pour le déplacer »', cs.visible && cs.text.includes('sélectionner ce sommet') && cs.text.includes('clic droit pour le déplacer'))

    // ===== Phase E — survol d'une zone vide (forme fermée) =====
    await page.mouse.move(EMPTY_ZONE.x, EMPTY_ZONE.y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('E : survol zone vide (forme fermée) → « survolez un segment… »', cs.visible && cs.text.includes('Survolez un segment pour y brancher un nouveau triangle'))

    // ===== Phase F — post-action + auto-disparition après ~3 s =====
    // Ctrl+Z déclenche d'abord le recalcul de survol (zone vide →
    // générique), puis le post-action « rétablir » le remplace (dernier
    // écrit, cf. history.js undo).
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('F : Ctrl+Z → « rétablir » (prospectif, pas « Annulé »)', cs.visible && cs.text.includes('rétablir') && !cs.text.includes('Annulé'))
    check('F : undo rappelle le raccourci rétablir', cs.text.includes('Ctrl+Shift+Z'))

    // Disparition automatique : le timer du post-action est de 3000 ms —
    // à 3,6 s la classe doit avoir été retirée (aucun mousemove entre
    // temps : le survol ne ré-affiche rien).
    await page.waitForTimeout(3600)
    cs = await commentState(page)
    check('F : toast invisible après ~3 s (disparition auto du post-action)', !cs.visible)

    // Un petit mouvement ré-affiche le message de survol (générique).
    await page.mouse.move(EMPTY_ZONE.x, EMPTY_ZONE.y - 20)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('F : un mouvement ré-affiche le message de survol', cs.visible && cs.text.includes('Survolez un segment'))

    // ===== Phase G — redo =====
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('G : Ctrl+Y → « Ctrl+Z pour annuler à nouveau »', cs.visible && cs.text.includes('Ctrl+Z pour annuler à nouveau'))

    // ===== Phase H — preview : toast masqué, revient à la sortie =====
    // On entre en preview (P) : le CSS body.preview-mode
    // #actionComment { display: none !important } doit le masquer.
    await page.keyboard.press('p')
    await page.waitForTimeout(200)
    const hiddenInPreview = await page.evaluate(() => {
        const el = document.querySelector('#actionComment')
        return el && getComputedStyle(el).display === 'none'
    })
    check('H : toast masqué en preview (display none)', hiddenInPreview)

    // Sortie (Échap) + un mouvement sur le board : le survol reprend la
    // main et ré-affiche le toast.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.mouse.move(EMPTY_ZONE.x, EMPTY_ZONE.y)
    await page.waitForTimeout(150)
    cs = await commentState(page)
    check('H : toast de nouveau visible à la sortie de preview', cs.visible)
    await page.close()

    const errors = allErrors()
    check('I : aucune erreur JS sur tout le parcours', errors.length === 0)
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    const errors = allErrors()
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
