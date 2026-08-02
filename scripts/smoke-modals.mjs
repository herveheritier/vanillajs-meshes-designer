// Smoke test des modales et de leurs raccourcis — playwright-core.
//
// Parcours : 4 modales de la charte commune (mêmes classes .modal,
// .modal-backdrop, .modal-box) :
//   • #resetModal        — bouton #reset ou Shift+Backspace ; Annuler
//     garde la scène, Escape ferme, Réinitialiser vide scène + historique.
//   • #mergeErrorModal   — déclenchée par #mergePoints quand la fusion
//     échoue (sélection insuffisante / conflit topologique) ; fermeture
//     par OK, Escape ou clic sur le backdrop. Contre-épreuve : une
//     fusion valide ne l'ouvre PAS.
//   • #helpModal         — bouton #helpBtn ou touche '?' (toggle) ;
//     fermeture par Escape ou clic backdrop ; focus sur #helpClose.
//   • #deleteShapeModal  — bouton #deleteShape ; Annuler garde la forme,
//     Supprimer remplace la dernière forme par une scène vide.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-modals.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Mêmes positions que smoke-edit / smoke-gestures (viewport 1280×800).
const TRIANGLE = [
    { x: 520, y: 300 },
    { x: 800, y: 300 },
    { x: 660, y: 520 },
]

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Info sommaire de la forme active depuis le localStorage.
const sceneInfo = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.length : 0,
        }
    } catch (e) {
        return { points: -1, tris: -1 }
    }
}, SCENE_STORAGE_KEY)

const { undoCount } = hudHelpers(page)
const undoDisabled = () => page.locator('#undo').isDisabled()
const selectionCount = () => page.locator('#selectionCount').textContent()

// Visibilité / focus de modale.
const modalVisible = (sel) => page.locator(sel).isVisible()
const modalHidden = (sel) => page.locator(sel).isHidden()
const activeId = () => page.evaluate(() => document.activeElement ? document.activeElement.id : null)

// Dessin : N clics gauche (chaque clic ajoute un point + une entrée undo).
const draw = async (points) => {
    for (const c of points) {
        await page.mouse.click(c.x, c.y)
        await page.waitForTimeout(120)
    }
}

// Lasso : drag gauche englobant une boîte écran (ne mute que la sélection).
const lasso = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
}

// Fermeture par clic sur le backdrop, à un coin (8,8) : le point doit
// tomber sur le backdrop plein-écran, pas sur la carte centrée.
const clickBackdrop = async (modalSel) => {
    await page.locator(modalSel + ' .modal-backdrop').click({ position: { x: 8, y: 8 } })
    await page.waitForTimeout(80)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // ===================== A. Modale de réinitialisation =====================
    await draw(TRIANGLE)
    let info = await sceneInfo()
    check('A : triangle 3 pts / 1 tri', info.points === 3 && info.tris === 1)
    check('A : undoCount (3)', (await undoCount()) === '(3)')

    await page.click('#reset')
    check('A : bouton #reset ouvre la modale', await modalVisible('#resetModal'))
    check('A : focus sur Annuler', (await activeId()) === 'resetModalCancel')

    await page.click('#resetModalCancel')
    check('A : Annuler ferme la modale', await modalHidden('#resetModal'))
    info = await sceneInfo()
    check('A : Annuler garde la scène (3 pts)', info.points === 3 && info.tris === 1)

    await page.keyboard.press('Shift+Backspace')
    check('A : Shift+Backspace ouvre la modale', await modalVisible('#resetModal'))
    await page.keyboard.press('Escape')
    check('A : Escape ferme la modale', await modalHidden('#resetModal'))
    info = await sceneInfo()
    check('A : scène intacte après Escape', info.points === 3 && info.tris === 1)

    await page.click('#reset')
    await page.click('#resetModalValidate')
    check('A : Réinitialiser ferme la modale', await modalHidden('#resetModal'))
    info = await sceneInfo()
    check('A : Réinitialiser vide la scène', info.points === 0 && info.tris === 0)
    check('A : undoCount (0) après reset', (await undoCount()) === '(0)')
    check('A : undo désactivé après reset', await undoDisabled())

    // ===================== B. Modale d'erreur de fusion =====================
    await draw(TRIANGLE)
    info = await sceneInfo()
    check('B : triangle redessiné', info.points === 3 && info.tris === 1)

    // B1. Sélection insuffisante (aucun point sélectionné).
    await page.click('#mergePoints')
    check('B : erreur visible (sélection vide)', await modalVisible('#mergeErrorModal'))
    let infoText = await page.locator('#mergeErrorModalInfo').textContent()
    check('B : message « Sélection insuffisante »', infoText.includes('Sélection insuffisante'))
    check('B : focus sur OK', (await activeId()) === 'mergeErrorModalClose')
    await page.click('#mergeErrorModalClose')
    check('B : OK ferme la modale', await modalHidden('#mergeErrorModal'))

    // B2. Conflit topologique (2 points du même triangle sélectionnés).
    await lasso(480, 260, 840, 330)
    check('B : 2 points sélectionnés', (await selectionCount()) === '2')
    await page.click('#mergePoints')
    check('B : erreur visible (conflit)', await modalVisible('#mergeErrorModal'))
    infoText = await page.locator('#mergeErrorModalInfo').textContent()
    check('B : message « Fusion impossible » + indice 1',
        infoText.includes('Fusion impossible') && infoText.includes('1'))
    await page.keyboard.press('Escape')
    check('B : Escape ferme la modale erreur', await modalHidden('#mergeErrorModal'))

    await page.click('#mergePoints')
    check('B : modale rouverte', await modalVisible('#mergeErrorModal'))
    await clickBackdrop('#mergeErrorModal')
    check('B : clic backdrop ferme', await modalHidden('#mergeErrorModal'))

    // B3. Contre-épreuve : une fusion VALIDE ne montre pas la modale.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('B : scène vidée (3 undos)', info.points === 0 && info.tris === 0)
    await draw(TRIANGLE)
    info = await sceneInfo()
    check('B : triangle redessiné', info.points === 3 && info.tris === 1)
    // 4e point : addPoint IGNORE un clic loin de tout segment quand le
    // dernier triangle est complet (« clic trop loin d'un segment »,
    // garde UX de editor.js). On clique donc AU MILIEU de l'arête
    // p1-p2 (800,300)-(660,520) → (730,410) : la projection orthogonale
    // tombe sur le segment, addPoint pousse un nouveau triangle.
    await page.mouse.click(730, 410)
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('B : 4 points / 2 tris (ajout sur arête)', info.points === 4 && info.tris === 2)
    check('B : undoCount (4)', (await undoCount()) === '(4)')
    // Sélectionner p0 (520,300) + p3 (730,410) : aucun triangle ne
    // contient les deux → fusion autorisée, pas de modale d'erreur.
    await lasso(480, 260, 770, 450)
    check('B : 2 points non-conflit sélectionnés', (await selectionCount()) === '2')
    await page.click('#mergePoints')
    check('B : fusion réussie → aucune modale', await modalHidden('#mergeErrorModal'))
    info = await sceneInfo()
    check('B : 3 points / 2 tris après fusion', info.points === 3 && info.tris === 2)
    check('B : undoCount (5) après fusion', (await undoCount()) === '(5)')
    check('B : sélection = survivant (0)', (await selectionCount()) === '1')

    // ===================== C. Modale d'aide =====================
    await page.click('#helpBtn')
    check("C : bouton #helpBtn ouvre l'aide", await modalVisible('#helpModal'))
    check('C : focus sur fermer', (await activeId()) === 'helpClose')
    await page.keyboard.press('Escape')
    check("C : Escape ferme l'aide", await modalHidden('#helpModal'))

    await page.keyboard.press('?')
    check("C : ? ouvre l'aide", await modalVisible('#helpModal'))
    await page.keyboard.press('?')
    check("C : ? referme l'aide (toggle)", await modalHidden('#helpModal'))
    await page.keyboard.press('?')
    check("C : ? rouvre l'aide", await modalVisible('#helpModal'))
    await clickBackdrop('#helpModal')
    check('C : clic backdrop ferme', await modalHidden('#helpModal'))

    // ===================== D. Modale de suppression de forme =====================
    // Reset propre via la modale (déjà validée en A) avant de redessiner.
    await page.click('#reset')
    await page.click('#resetModalValidate')
    info = await sceneInfo()
    check('D : scène vide (reset préalable)', info.points === 0 && info.tris === 0)

    await draw(TRIANGLE)
    info = await sceneInfo()
    check('D : triangle redessiné', info.points === 3 && info.tris === 1)

    await page.click('#deleteShape')
    check('D : modale suppression visible', await modalVisible('#deleteShapeModal'))
    infoText = await page.locator('#deleteShapeModalInfo').textContent()
    check('D : message « dernière forme »', infoText.includes('dernière forme'))
    await page.click('#deleteShapeModalCancel')
    check('D : Annuler ferme + scène intacte', (await modalHidden('#deleteShapeModal'))
        && (await sceneInfo()).points === 3)

    await page.click('#deleteShape')
    await page.click('#deleteShapeModalValidate')
    info = await sceneInfo()
    check('D : Supprimer remplace par une scène vide', info.points === 0 && info.tris === 0)
    check('D : undoCount (4) après suppression', (await undoCount()) === '(4)')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
