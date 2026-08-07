// Smoke test de l'ordre des formes (évolution « boutons pour gérer
// l'ordre des formes ») — playwright-core.
//
// Parcours : charger une scène de 3 plans (autoimport), vérifier
// l'état initial des boutons (grisés aux bornes), monter / descendre
// le plan actif par les boutons ET par Alt+Flèches, vérifier que
// l'ordre du tableau (et donc des plans) suit,
// undo/redo (une entry chacun, l'index actif restauré), persistance
// au reload, et les bornes (1er plan : descendre impossible,
// dernier : monter impossible).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-shapeorder.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// 3 plans : triangles de 3 points, premier point à x = 0 / 20 / 40
// pour identifier chaque plan dans l'ordre du tableau persisté.
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n40,0;50,0;45,8.66\n'

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Ordre lisible des plans : premier point x de chaque plan dans
// l'ordre du tableau (0/20/40 = plan A/B/C). L'ordre du tableau EST
// l'ordre des plans.
const shapeOrder = () => page.evaluate((key) => {
    try {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        if (!Array.isArray(s.shapes)) return []
        return s.shapes.map((sh) => {
            const p = (Array.isArray(sh.pointList) && sh.pointList[0]) || {}
            return Math.round(p.x)
        })
    } catch (e) {
        return []
    }
}, SCENE_STORAGE_KEY)

const label = () => page.locator('#shapeLabel').textContent()
const upDisabled = () => page.locator('#moveShapeUp').isDisabled()
const downDisabled = () => page.locator('#moveShapeDown').isDisabled()
const undoCount = () => page.locator('#undoCount').textContent()

try {
    const url = BASE_URL + '?autoimport=' + Buffer.from(MESHES_TEXT, 'utf8').toString('base64url')
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    await page.waitForFunction(() => document.querySelector('#shapeLabel')?.textContent === '1/3', null, { timeout: 8000 })

    // --- 1. État initial : 3 plans, plan actif = 1er, bornes ---
    check('3 plans chargés (1/3)', (await label()) === '1/3')
    check('ordre initial [0,20,40]', JSON.stringify(await shapeOrder()) === '[0,20,40]')
    check('1er plan : monter possible, descendre grisé',
        !(await upDisabled()) && (await downDisabled()))
    check('undo vide au départ', (await undoCount()) === '(0)')

    // --- 2. Monter par le bouton : indice +1, plan actif suit ---
    await page.click('#moveShapeUp')
    await page.waitForTimeout(120)
    check('monter : compteur 2/3', (await label()) === '2/3')
    check('monter : ordre [20,0,40] (plan A passé au-dessus de B)',
        JSON.stringify(await shapeOrder()) === '[20,0,40]')
    check('monter : 1 entry undo', (await undoCount()) === '(1)')

    // --- 3. Undo / redo : ordre ET index actif restaurés ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    check('undo : compteur revenu à 1/3', (await label()) === '1/3')
    check('undo : ordre restauré [0,20,40]', JSON.stringify(await shapeOrder()) === '[0,20,40]')
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(120)
    check('redo : compteur 2/3', (await label()) === '2/3')
    check('redo : ordre [20,0,40]', JSON.stringify(await shapeOrder()) === '[20,0,40]')

    // --- 4. Alt+Flèche Haut : même fonction que le bouton ---
    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForTimeout(120)
    check('Alt+Flèche Haut : compteur 3/3', (await label()) === '3/3')
    check('Alt+Flèche Haut : ordre [20,40,0] (plan B au-dessus de C)',
        JSON.stringify(await shapeOrder()) === '[20,40,0]')
    check('dernier plan : monter grisé, descendre possible',
        (await upDisabled()) && !(await downDisabled()))

    // --- 5. Alt+Flèche Bas : indice -1 ---
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(120)
    check('Alt+Flèche Bas : compteur 2/3', (await label()) === '2/3')
    check('Alt+Flèche Bas : ordre [20,0,40]', JSON.stringify(await shapeOrder()) === '[20,0,40]')

    // --- 6. Descendre par le bouton jusqu'au 1er plan ---
    await page.click('#moveShapeDown')
    await page.waitForTimeout(120)
    check('descendre : compteur 1/3', (await label()) === '1/3')
    check('descendre : ordre [0,20,40]', JSON.stringify(await shapeOrder()) === '[0,20,40]')
    check('1er plan : descendre grisé', await downDisabled())

    // --- 7. Bornes : no-op hors bornes (défense en profondeur).
    // Le bouton étant disabled, Playwright refuse de le cliquer ; on
    // force l'événement via dispatchEvent (comme un clic programmatique)
    // pour vérifier que moveShapeDown est bien un no-op sur le 1er plan.
    await page.evaluate(() => {
        document.querySelector('#moveShapeDown').dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }))
    })
    await page.waitForTimeout(100)
    check('descendre sur le 1er plan : ordre inchangé (no-op hors bornes)', JSON.stringify(await shapeOrder()) === '[0,20,40]')

    // --- 8. Persistance : l'ordre survit au reload ---
    await page.click('#moveShapeUp')
    await page.waitForTimeout(120)
    check('monter : 2/3 avant reload', (await label()) === '2/3')
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('reload : compteur 2/3 restauré', (await label()) === '2/3')
    check('reload : ordre [20,0,40] restauré', JSON.stringify(await shapeOrder()) === '[20,0,40]')

    // --- 9. Plans VIDES : insertion AVANT/APRÈS le plan courant
    // (évolution « intercaler un nouveau plan », cf. DESIGN.md §7.17) +
    // fallback snapshot de saveState (scène 0 pt / 0 tri →
    // shouldUseSnapshot promeut l'entry en snapshot ; shapeMove est
    // skipé par snapshotBeforeState comme insertPoint — sans ça, l'undo
    // restaurerait un ordre corrompu). Contexte neuf (storage isolé,
    // URL SANS autoimport : le beforeunload re-persiste la scène en
    // mémoire au reload, il faut donc un contexte frais pour repartir
    // d'une scène vide propre).
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page2 = await ctx2.newPage()
    const errors2 = attachErrorCollector(page2)
    await page2.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page2.waitForSelector('#board')
    await page2.waitForTimeout(400)
    // Clic GAUCHE sur + : le nouveau plan s'intercale AVANT le plan
    // courant (index 0) et devient actif → compteur 1/2. Clic DROIT :
    // s'intercale APRÈS (index 1) et devient actif → compteur 2/3.
    await page2.click('#newShape')
    await page2.waitForTimeout(120)
    check('clic gauche : plan vide inséré AVANT (1/2)', (await page2.locator('#shapeLabel').textContent()) === '1/2')
    await page2.click('#newShape', { button: 'right' })
    await page2.waitForTimeout(120)
    check('clic droit : plan vide inséré APRÈS (2/3)', (await page2.locator('#shapeLabel').textContent()) === '2/3')
    await page2.click('#moveShapeDown')
    await page2.waitForTimeout(120)
    check('descendre un plan vide : 1/3', (await page2.locator('#shapeLabel').textContent()) === '1/3')
    await page2.keyboard.press('Control+z')
    await page2.waitForTimeout(120)
    check('undo (fallback snapshot) : compteur 2/3 restauré', (await page2.locator('#shapeLabel').textContent()) === '2/3')
    // Undo des INSERTIONS elles-mêmes (fallback snapshot, scène vide).
    // Régression couverte : saveState appelé AVANT le splice corrompait
    // le snapshot (l'inverse splice(newIndex, 1) retirait un plan RÉEL
    // du clone — no-op seulement pour l'ancien append en fin de
    // tableau) — l'undo d'une insertion relative rendait la scène
    // corrompue (0 plan ou plan manquant).
    await page2.keyboard.press('Control+z')
    await page2.waitForTimeout(120)
    check('undo insertion APRÈS : compteur 1/2 restauré', (await page2.locator('#shapeLabel').textContent()) === '1/2')
    await page2.keyboard.press('Control+z')
    await page2.waitForTimeout(120)
    check('undo insertion AVANT : compteur 1/1 restauré', (await page2.locator('#shapeLabel').textContent()) === '1/1')
    const emptyOrder = await page2.evaluate((key) => {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        return Array.isArray(s.shapes) ? s.shapes.length : -1
    }, SCENE_STORAGE_KEY)
    check('undo insertions : état initial restauré (1 seul plan)', emptyOrder === 1)
    // Suppression multi-plan + undo sur petite scène (fallback snapshot) :
    // régression couverte — performDeleteShape appelait saveState AVANT le
    // splice, l'inverse du remove (ré-insertion du plan) était rejoué sur
    // l'état pré-mutation → plan en DOUBLON (2 plans → 3 après Ctrl+Z).
    await page2.click('#newShape')
    await page2.waitForTimeout(120)   // insertion AVANT : [new, old], actif 1/2
    check('2 plans après insertion avant (1/2)', (await page2.locator('#shapeLabel').textContent()) === '1/2')
    await page2.click('#deleteShape')
    await page2.waitForTimeout(100)
    await page2.click('#deleteShapeModalValidate')
    await page2.waitForTimeout(120)   // 1 plan, actif 1/1
    check('suppression multi-plan : 1/1', (await page2.locator('#shapeLabel').textContent()) === '1/1')
    await page2.keyboard.press('Control+z')
    await page2.waitForTimeout(120)
    check('undo suppression : 1/2 restauré (pas de doublon)', (await page2.locator('#shapeLabel').textContent()) === '1/2')
    const afterDeleteUndo = await page2.evaluate((key) => {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        return Array.isArray(s.shapes) ? s.shapes.length : -1
    }, SCENE_STORAGE_KEY)
    check('undo suppression : 2 plans (pas de doublon)', afterDeleteUndo === 2)
    check('contexte 2 : aucune erreur JS', errors2.length === 0)
    await ctx2.close()

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
