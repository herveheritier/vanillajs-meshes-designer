// Smoke test de l'ordre des formes (évolution « boutons pour gérer
// l'ordre des formes ») — playwright-core.
//
// Parcours : charger une scène de 3 formes (autoimport), vérifier
// l'état initial des boutons (grisés aux bornes), monter / descendre
// la forme active par les boutons ET par Alt+Flèches, vérifier que
// l'ordre du tableau (et donc des plans, forme n = plan n) suit,
// undo/redo (une entry chacun, l'index actif restauré), persistance
// au reload, et les bornes (1re forme : descendre impossible,
// dernière : monter impossible).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-shapeorder.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// 3 formes : triangles de 3 points, premier point à x = 0 / 20 / 40
// pour identifier chaque forme dans l'ordre du tableau persisté.
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n40,0;50,0;45,8.66\n'

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Ordre lisible des formes : premier point x de chaque forme dans
// l'ordre du tableau (0/20/40 = forme A/B/C). L'ordre du tableau EST
// l'ordre des plans (forme n = plan n).
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

    // --- 1. État initial : 3 formes, forme active = 1re, bornes ---
    check('3 formes chargées (1/3)', (await label()) === '1/3')
    check('ordre initial [0,20,40]', JSON.stringify(await shapeOrder()) === '[0,20,40]')
    check('1re forme : monter possible, descendre grisé',
        !(await upDisabled()) && (await downDisabled()))
    check('undo vide au départ', (await undoCount()) === '(0)')

    // --- 2. Monter par le bouton : indice +1, forme active suit ---
    await page.click('#moveShapeUp')
    await page.waitForTimeout(120)
    check('monter : compteur 2/3', (await label()) === '2/3')
    check('monter : ordre [20,0,40] (forme A passée au-dessus de B)',
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
    check('Alt+Flèche Haut : ordre [20,40,0] (forme B au-dessus de C)',
        JSON.stringify(await shapeOrder()) === '[20,40,0]')
    check('dernière forme : monter grisé, descendre possible',
        (await upDisabled()) && !(await downDisabled()))

    // --- 5. Alt+Flèche Bas : indice -1 ---
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(120)
    check('Alt+Flèche Bas : compteur 2/3', (await label()) === '2/3')
    check('Alt+Flèche Bas : ordre [20,0,40]', JSON.stringify(await shapeOrder()) === '[20,0,40]')

    // --- 6. Descendre par le bouton jusqu'à la 1re forme ---
    await page.click('#moveShapeDown')
    await page.waitForTimeout(120)
    check('descendre : compteur 1/3', (await label()) === '1/3')
    check('descendre : ordre [0,20,40]', JSON.stringify(await shapeOrder()) === '[0,20,40]')
    check('1re forme : descendre grisé', await downDisabled())

    // --- 7. Bornes : no-op hors bornes (défense en profondeur).
    // Le bouton étant disabled, Playwright refuse de le cliquer ; on
    // force l'événement via dispatchEvent (comme un clic programmatique)
    // pour vérifier que moveShapeDown est bien un no-op sur la 1re forme.
    await page.evaluate(() => {
        document.querySelector('#moveShapeDown').dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }))
    })
    await page.waitForTimeout(100)
    check('descendre sur la 1re forme : ordre inchangé (no-op hors bornes)', JSON.stringify(await shapeOrder()) === '[0,20,40]')

    // --- 8. Persistance : l'ordre survit au reload ---
    await page.click('#moveShapeUp')
    await page.waitForTimeout(120)
    check('monter : 2/3 avant reload', (await label()) === '2/3')
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('reload : compteur 2/3 restauré', (await label()) === '2/3')
    check('reload : ordre [20,0,40] restauré', JSON.stringify(await shapeOrder()) === '[20,0,40]')

    // --- 9. Formes VIDES : le fallback snapshot de saveState doit
    // rester correct (scène 0 pt / 0 tri → shouldUseSnapshot promeut
    // l'entry en snapshot ; shapeMove est skipé par snapshotBeforeState
    // comme insertPoint — sans ça, l'undo restaurerait un ordre
    // corrompu). Contexte neuf (storage isolé, URL SANS autoimport : le
    // beforeunload re-persiste la scène en mémoire au reload, il faut
    // donc un contexte frais pour repartir d'une scène vide propre).
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page2 = await ctx2.newPage()
    const errors2 = attachErrorCollector(page2)
    await page2.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page2.waitForSelector('#board')
    await page2.waitForTimeout(400)
    await page2.click('#newShape')
    await page2.waitForTimeout(120)
    await page2.click('#newShape')
    await page2.waitForTimeout(120)
    // addShape rend la NOUVELLE forme active (goToShape(newIndex)) :
    // après 2 ajouts, compteur 3/3 (dernière forme, vide).
    check('3 formes vides (3/3)', (await page2.locator('#shapeLabel').textContent()) === '3/3')
    await page2.click('#moveShapeDown')
    await page2.waitForTimeout(120)
    check('descendre une forme vide : 2/3', (await page2.locator('#shapeLabel').textContent()) === '2/3')
    await page2.keyboard.press('Control+z')
    await page2.waitForTimeout(120)
    check('undo (fallback snapshot) : compteur 3/3 restauré', (await page2.locator('#shapeLabel').textContent()) === '3/3')
    const emptyOrder = await page2.evaluate((key) => {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        return Array.isArray(s.shapes) ? s.shapes.length : -1
    }, SCENE_STORAGE_KEY)
    check('undo (fallback snapshot) : 3 formes toujours présentes', emptyOrder === 3)
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
