// Smoke test du mode d'affichage « toutes couleurs » en édition
// (évolution « bouton pour choisir le mode d'affichage en édition »,
// cf. DESIGN.md §7.18) — playwright-core.
//
// Parcours : scène de 2 plans à triangles remplis (injectée via
// localStorage avec addInitScript — le wire format porte les fills) ;
// vérifier le mode standard (plan actif rempli, plan inactif NON
// rempli), le toggle « toutes couleurs » (plan inactif rempli de SA
// couleur, plan actif inchangé), le retour au standard, la persistance
// de la préférence (clé dédiée + restore au boot dans un contexte
// neuf), et le masquage du bouton en preview (chrome masquée).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-allfills.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')
// Clé de préférence (constants.js ALL_FILLS_STORAGE_KEY) — dupliquée
// ici : le smoke doit la connaître pour preset le restore au boot.
const ALL_FILLS_KEY = 'meshesDesigner.showAllFills'

// Scène : 2 plans (triangles remplis, couleurs distinctes). Plan A
// (actif, rouge) autour de x=0, plan B (inactif, bleu) autour de x=200
// — centroïdes modèle (50, 28.87) et (250, 28.87).
const SCENE_PAYLOAD = {
    format: 'meshes-designer',
    version: 1,
    name: 'nouvelleScene',
    activeGrid: false,
    GRID_STEP: 32,
    shapes: [
        { pointList: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 86.6 }], tris: [{ p1: 0, p2: 1, p3: 2, fill: '#ff4444' }] },
        { pointList: [{ x: 200, y: 0 }, { x: 300, y: 0 }, { x: 250, y: 86.6 }], tris: [{ p1: 0, p2: 1, p3: 2, fill: '#4444ff' }] },
    ],
    activeShapeIndex: 0,
    zoomLevel: 1,
    viewCenter: { x: 0, y: 0 },
}

const { check, finish } = createHarness()

const browser = await launchBrowser()

// Position écran (CSS px) d'un point modèle : viewCenter (0,0), zoom 1,
// le centre du board = origine modèle (même convention que l'axe Y
// inversé de modelToScreen).
const screenOf = async (page, mx, my) => {
    const c = await page.evaluate(() => {
        const r = document.querySelector('#board').getBoundingClientRect()
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
    })
    return { x: c.cx + mx, y: c.cy - my }
}

// Couleur moyenne (r,g,b) dans une fenêtre 12×12 autour de (x, y) CSS px
// (conversion CSS -> pixels physiques ×dpr, comme smoke_lib).
const avgColorNear = (page, x, y) => page.evaluate(({ px, py }) => {
    const board = document.querySelector('#board')
    const ctx = board.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const sx = Math.round(px * dpr)
    const sy = Math.round(py * dpr)
    const img = ctx.getImageData(sx - 6, sy - 6, 12, 12).data
    let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < img.length; i += 4) {
        r += img[i]; g += img[i + 1]; b += img[i + 2]; n++
    }
    return { r: r / n, g: g / n, b: b / n }
}, { px: x, py: y })

const isDark = (c) => c.r < 30 && c.g < 30 && c.b < 30
const isRed = (c) => c.r > c.b + 60
const isBlue = (c) => c.b > c.r + 60

const allFillsActive = (page) => page.locator('#showAllFills').evaluate((el) => el.classList.contains('all-fills-active'))

try {
    // --- Contexte 1 : scène injectée AVANT le boot (addInitScript —
    // sinon le beforeunload du reload écraserait la clé avec la scène
    // par défaut). ---
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.addInitScript(({ key, payload }) => {
        localStorage.setItem(key, payload)
    }, { key: SCENE_STORAGE_KEY, payload: JSON.stringify(SCENE_PAYLOAD) })
    const errors = attachErrorCollector(page)
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(500)

    check('bouton #showAllFills présent', await page.locator('#showAllFills').count() === 1)
    check('2 plans chargés (1/2)', (await page.locator('#shapeLabel').textContent()) === '1/2')
    check('mode standard au départ (bouton inactif)', !(await allFillsActive(page)))

    const a = await screenOf(page, 50, 28.87)   // centroïde du plan actif (rouge)
    const b = await screenOf(page, 250, 28.87)  // centroïde du plan inactif (bleu)

    // --- 1. Mode standard : actif rempli, inactif non rempli ---
    let col = await avgColorNear(page, a.x, a.y)
    check('standard : plan actif rempli de sa couleur (rouge)', isRed(col))
    col = await avgColorNear(page, b.x, b.y)
    check('standard : plan inactif NON rempli (fond noir)', isDark(col))

    // --- 2. Toggle « toutes couleurs » ---
    await page.click('#showAllFills')
    await page.waitForTimeout(150)
    check('toggle : bouton .all-fills-active', await allFillsActive(page))
    check('toggle : aria-pressed=true', (await page.locator('#showAllFills').getAttribute('aria-pressed')) === 'true')
    col = await avgColorNear(page, b.x, b.y)
    check('toutes couleurs : plan inactif rempli de SA couleur (bleu)', isBlue(col))
    col = await avgColorNear(page, a.x, a.y)
    check('toutes couleurs : plan actif inchangé (rouge)', isRed(col))

    // --- 3. Retour au standard ---
    await page.click('#showAllFills')
    await page.waitForTimeout(150)
    check('re-toggle : bouton inactif', !(await allFillsActive(page)))
    col = await avgColorNear(page, b.x, b.y)
    check('re-toggle : plan inactif non rempli (fond noir)', isDark(col))

    // --- 4. Persistance : clé écrite au toggle (préférence de vue) ---
    await page.click('#showAllFills')
    await page.waitForTimeout(100)
    const stored = await page.evaluate((key) => localStorage.getItem(key), ALL_FILLS_KEY)
    check('persistance : clé meshesDesigner.showAllFills = 1', stored === '1')

    // --- 5. Masquage en preview (chrome masquée par groupe, :has()) ---
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('preview : bouton #showAllFills masqué', !(await page.locator('#showAllFills').isVisible()))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('sortie preview : bouton de retour', await page.locator('#showAllFills').isVisible())

    check('contexte 1 : aucune erreur JS', errors.length === 0)
    await page.close()

    // --- Contexte 2 : restore de la préférence au boot ---
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page2 = await ctx2.newPage()
    await page2.addInitScript(({ sceneKey, scenePayload, prefKey }) => {
        localStorage.setItem(sceneKey, scenePayload)
        localStorage.setItem(prefKey, '1')
    }, { sceneKey: SCENE_STORAGE_KEY, scenePayload: JSON.stringify(SCENE_PAYLOAD), prefKey: ALL_FILLS_KEY })
    const errors2 = attachErrorCollector(page2)
    await page2.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page2.waitForSelector('#board')
    await page2.waitForTimeout(500)
    check('restore au boot : bouton .all-fills-active', await allFillsActive(page2))
    const b2 = await screenOf(page2, 250, 28.87)
    col = await avgColorNear(page2, b2.x, b2.y)
    check('restore au boot : plan inactif rempli (bleu)', isBlue(col))
    check('contexte 2 : aucune erreur JS', errors2.length === 0)
    await ctx2.close()
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
}

await browser.close()
finish()
