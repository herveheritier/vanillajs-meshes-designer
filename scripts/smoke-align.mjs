// Smoke test de l'alignement / répartition des points sélectionnés
// (évolution « boutons pour forcer l'alignement et la répartition des
// points sélectionnés ») — playwright-core.
//
// Parcours, sur des scènes JSON seedées aux coordonnées exactes
// (pattern addInitScript : scène écrite dans localStorage AVANT le boot
// de la page, lue par loadState) :
//   A. Scène de 4 points (0,0) (32,20) (40,16) (96,24) :
//      - états disabled des 4 actions au boot (sélection vide) puis
//        après selectAll (align ≥ 2, répartir ≥ 3 → tous actifs) ;
//      - ouverture du panneau #align (bouton), fermeture par Echap,
//        réouverture, fermeture au clic extérieur ;
//      - Aligner X via le bouton : tous les X prennent celui du 1er
//        point sélectionné (ancre = pointList[0], X=0), Y inchangés ;
//      - Aligner Y via le bouton : tous les Y prennent celui de l'ancre
//        (Y=0), X inchangés ;
//      - Répartir X via le bouton : C passe de 40 à 64 (pas = (96-0)/3),
//        les extrêmes restent en place ;
//      - Répartir Y via le bouton : C passe de 16 à 8 et B de 20 à 16 ;
//      - mêmes 4 actions via les raccourcis clavier Alt+← / Alt+→ /
//        Alt+Shift+← / Alt+Shift+→ ;
//      - Ctrl+Z restaure les coordonnées exactes après chaque action,
//        Ctrl+Shift+Z (redo) les ré-applique ;
//      - le panneau reste OUVERT après une action (enchaînement).
//   B. Scène de 2 points : Aligner X actifs mais Répartir X/Y grisés
//      (bornes répartir ≥ 3) ; Aligner X unifie bien les X.
//   C. Scène de 1 point : les 4 actions grisées (bornes align ≥ 2).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-align.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Scène JSON seedée : coordonnées exactes pour vérifier align/répartir
// au pixel près. A = ancre (1er point, X=0, Y=0) ; B/C/D ont des X et Y
// volontairement NON uniformes pour que la répartition produise des
// changements mesurables (B x=32 y=20, C x=40 y=16, D x=96 y=24).
const sceneWith = (points) => JSON.stringify({
    format: 'meshes-designer',
    version: 1,
    name: 'align-test',
    shapes: [{
        pointList: points.map(([x, y]) => ({ x, y })),
        // 2 tris formant un quad : la géométrie ne change pas pendant
        // align/répartir (les indices restent valides, on ne touche
        // qu'aux coordonnées).
        tris: [
            { p1: 0, p2: 1, p3: 2 },
            { p1: 0, p2: 2, p3: 3 },
        ].slice(0, Math.max(0, points.length - 2)),
    }],
    activeShapeIndex: 0,
})

const SCENE_4 = sceneWith([[0, 0], [32, 20], [40, 16], [96, 24]])
const SCENE_2 = sceneWith([[0, 0], [32, 8]])
const SCENE_1 = sceneWith([[0, 0]])

const { check, finish } = createHarness()

const browser = await launchBrowser()

// Erreurs JS collectées sur TOUTES les pages (pageerror + console.error,
// même pattern que smoke-clipboard.mjs) : attachErrorCollector retourne
// le tableau référencé par les listeners (rempli de façon asynchrone),
// on en garde la référence et on le déroule à la fin du parcours.
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

// Coordonnées du plan actif depuis le localStorage persisté.
const coords = (page) => page.evaluate((key) => {
    try {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        const shape = (s.shapes && s.shapes[0]) || {}
        const pl = Array.isArray(shape.pointList) ? shape.pointList : []
        return pl.map(p => ({ x: p.x, y: p.y }))
    } catch (e) { return [] }
}, SCENE_STORAGE_KEY)

const selectionCount = (page) => page.locator('#selectionCount').textContent()
const alignDisabled = (page, id) => page.locator('#' + id).isDisabled()
const panelVisible = (page) => page.locator('#alignPanel').isVisible()

try {
    // ===== Phase A — scène 4 points =====
    let page = await openSeededPage(SCENE_4)

    check('A : scène seedée (4 points)', (await coords(page)).length === 4)
    check('A : actions grisées sans sélection (align X, Y, répartir X, Y)',
        await alignDisabled(page, 'alignX') && await alignDisabled(page, 'alignY')
        && await alignDisabled(page, 'distributeX') && await alignDisabled(page, 'distributeY'))

    // --- Ouverture / fermeture du panneau (sélection vide : boutons
    // grisés mais le panneau s'ouvre quand même) ---
    await page.click('#align')
    await page.waitForTimeout(100)
    check('A : clic #align → panneau visible', await panelVisible(page))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    check('A : Echap → panneau fermé', !(await panelVisible(page)))
    await page.click('#align')
    await page.waitForTimeout(100)
    check('A : re-clic #align → panneau rouvert', await panelVisible(page))
    // Sélectionner TOUS les points ferme le panneau (clic extérieur,
    // même handler que wireShapesPanel) : comportement voulu, on
    // rouvre ensuite.
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    check('A : 4 points sélectionnés', (await selectionCount(page)) === '4')
    check('A : selectAll ferme le panneau (clic extérieur)', !(await panelVisible(page)))
    await page.click('#align')
    await page.waitForTimeout(100)
    check('A : actions actives avec 4 points (align ≥ 2, répartir ≥ 3)',
        !(await alignDisabled(page, 'alignX')) && !(await alignDisabled(page, 'alignY'))
        && !(await alignDisabled(page, 'distributeX')) && !(await alignDisabled(page, 'distributeY')))

    // --- Aligner X (bouton) : la sélection (4 points) + le panneau
    // sont déjà actifs de la phase précédente. L'undo VIDE la sélection
    // (clearEditingTransientState) : chaque phase suivante re-sélectionne
    // puis rouvre le panneau. ---
    await page.click('#alignX')
    await page.waitForTimeout(150)
    let c = await coords(page)
    check('A : Aligner X → X unifiés sur l ancre (0), Y inchangés',
        c.every((p) => p.x === 0)
        && c[1].y === 20 && c[2].y === 16 && c[3].y === 24)
    check('A : panneau reste ouvert après l action (enchaînement)', await panelVisible(page))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : undo Aligner X → coordonnées exactes restaurées',
        c[1].x === 32 && c[2].x === 40 && c[3].x === 96
        && c[1].y === 20 && c[2].y === 16 && c[3].y === 24)

    // --- Aligner Y (bouton) ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.click('#align')
    await page.waitForTimeout(100)
    await page.click('#alignY')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : Aligner Y → Y unifiés sur l ancre (0), X inchangés',
        c.every((p) => p.y === 0)
        && c[1].x === 32 && c[2].x === 40 && c[3].x === 96)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    // --- Répartir X (bouton) ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.click('#align')
    await page.waitForTimeout(100)
    await page.click('#distributeX')
    await page.waitForTimeout(150)
    c = await coords(page)
    // Tri par X : A(0) B(32) C(40) D(96) → pas = 96/3 = 32 →
    // B reste 32 (rang 1), C passe à 64 (rang 2), extrêmes 0 et 96 fixes.
    check('A : Répartir X → C passe de 40 à 64, extrêmes en place',
        c[0].x === 0 && c[1].x === 32 && c[2].x === 64 && c[3].x === 96)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    // --- Répartir Y (bouton) ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.click('#align')
    await page.waitForTimeout(100)
    await page.click('#distributeY')
    await page.waitForTimeout(150)
    c = await coords(page)
    // Tri par Y : A(0) C(16) B(20) D(24) → pas = 24/3 = 8 →
    // C passe à 8 (rang 1), B passe à 16 (rang 2), extrêmes fixes.
    check('A : Répartir Y → C passe à 8 et B à 16, extrêmes en place',
        c[0].y === 0 && c[2].y === 8 && c[1].y === 16 && c[3].y === 24)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : undo Répartir Y → coords d origine',
        c[1].x === 32 && c[2].x === 40 && c[3].x === 96
        && c[1].y === 20 && c[2].y === 16 && c[3].y === 24)

    // --- Redo : Ctrl+Shift+Z ré-applique la dernière action ---
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : redo Répartir Y → C=8, B=16 à nouveau',
        c[2].y === 8 && c[1].y === 16 && c[3].y === 24)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    // --- Raccourcis clavier (sélection seule suffit, pas de panneau) ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.keyboard.press('Alt+ArrowLeft')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : Alt+← = Aligner X (X unifiés sur 0)', c.every((p) => p.x === 0))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.keyboard.press('Alt+ArrowRight')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : Alt+→ = Aligner Y (Y unifiés sur 0)', c.every((p) => p.y === 0))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.keyboard.press('Alt+Shift+ArrowLeft')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : Alt+Shift+← = Répartir X (C=64)', c[2].x === 64 && c[1].x === 32 && c[0].x === 0 && c[3].x === 96)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('A : Alt+Shift+→ = Répartir Y (C=8, B=16)', c[2].y === 8 && c[1].y === 16 && c[0].y === 0 && c[3].y === 24)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)

    // --- Fermeture au clic extérieur (sur le canvas) ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.click('#align')
    await page.waitForTimeout(100)
    await page.mouse.click(100, 700)
    await page.waitForTimeout(100)
    check('A : clic extérieur → panneau fermé', !(await panelVisible(page)))
    await page.close()

    // ===== Phase B — scène 2 points : répartir grisé, align actif =====
    page = await openSeededPage(SCENE_2)
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    check('B : 2 points sélectionnés', (await selectionCount(page)) === '2')
    check('B : Aligner X/Y actifs (≥ 2)', !(await alignDisabled(page, 'alignX')) && !(await alignDisabled(page, 'alignY')))
    check('B : Répartir X/Y grisés (bornes ≥ 3)',
        await alignDisabled(page, 'distributeX') && await alignDisabled(page, 'distributeY'))
    await page.click('#align')
    await page.waitForTimeout(100)
    await page.click('#alignX')
    await page.waitForTimeout(150)
    c = await coords(page)
    check('B : Aligner X sur 2 points → X unifiés (0, 0), Y conservés',
        c[0].x === 0 && c[1].x === 0 && c[0].y === 0 && c[1].y === 8)
    await page.close()

    // ===== Phase C — scène 1 point : tout grisé (bornes align ≥ 2) =====
    page = await openSeededPage(SCENE_1)
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    check('C : 1 point sélectionné', (await selectionCount(page)) === '1')
    check('C : les 4 actions grisées (align ≥ 2)',
        await alignDisabled(page, 'alignX') && await alignDisabled(page, 'alignY')
        && await alignDisabled(page, 'distributeX') && await alignDisabled(page, 'distributeY'))
    await page.close()

    const errors = allErrors()
    check('aucune erreur JS sur tout le parcours', errors.length === 0)
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    const errors = allErrors()
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
