// Smoke test des gestes souris avancés — playwright-core.
//
// Parcours : dessiner un triangle (3 clics gauche), sélectionner au
// lasso (boîte englobante), désélectionner, puis tester les deux
// gestes de déplacement :
//   • clic droit + drag = grab du groupe sélectionné (delta modèle =
//     delta écran / zoom, Y inversé — zoom 1 par défaut ici) ;
//   • AltGr (Ctrl+Alt) + clic droit + drag = déplacement GLOBAL de
//     tous les points de toutes les formes (moveAllActive).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-gestures.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Mêmes positions que smoke-edit.mjs (viewport 1280×800) : triangle
// non dégénéré, loin de la toolbar et de la console.
const CLICKS = [
    { x: 520, y: 300 },
    { x: 800, y: 300 },
    { x: 660, y: 520 },
]

// Tolérance sur les positions modèles : le grab applique dx/dy = delta
// écran / zoom (zoom = 1) sans snap (grille désactivée par défaut),
// mais screenToModel passe par des floats — 1e-3 suffit.
const EPS = 1e-3
const closeTo = (a, b) => Math.abs(a - b) < EPS

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Positions [x, y] de la forme active depuis le localStorage de la page.
const shapePoints = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        const pts = Array.isArray(shape.pointList) ? shape.pointList : []
        return pts.map((p) => ({ x: p.x, y: p.y }))
    } catch (e) {
        return []
    }
}, SCENE_STORAGE_KEY)

// Info sommaire (counts) pour les assertions de structure.
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

const { undoCount, sceneDirty } = hudHelpers(page)
const selectionCount = () => page.locator('#selectionCount').textContent()

// Lasso : drag gauche qui englobe une boîte écran donnée. Ne mute que
// state.selectedPoints (aucun point ajouté), contrairement au clic.
const lasso = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
}

// Grab (clic droit + drag) de p1 vers p2 — sélection actuelle ou,
// avec Ctrl+Alt enfoncés, déplacement global (AltGr).
const rightDrag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(x2, y2, { steps: 6 })
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(120)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- A. Dessiner un triangle : 3 clics gauche ---
    for (const c of CLICKS) {
        await page.mouse.click(c.x, c.y)
        await page.waitForTimeout(120)
    }
    let info = await sceneInfo()
    check('triangle dessiné : 3 points / 1 tri', info.points === 3 && info.tris === 1)
    check('undoCount = (3) après dessin', (await undoCount()) === '(3)')
    const before = await shapePoints()
    check('positions modèles lues', before.length === 3)

    // --- B. Lasso autour des 2 points du haut (y ≤ 330) ---
    await lasso(480, 260, 840, 330)
    check('lasso : 2 points sélectionnés', (await selectionCount()) === '2')
    info = await sceneInfo()
    check('lasso ne mute pas la scène (3 points conservés)', info.points === 3 && info.tris === 1)

    // --- C. Lasso sur zone vide : désélection sans ajouter de point ---
    // Zone (200,700) : bas du canvas, loin du triangle et des overlays
    // (toolbar / console occupent le coin haut-gauche) — plus robuste
    // qu'un coin supérieur qui pourrait être masqué par la chrome.
    await lasso(200, 700, 240, 740)
    check('lasso vide : sélection = 0', (await selectionCount()) === '0')
    info = await sceneInfo()
    check('désélection par lasso sans ajout de point', info.points === 3)

    // --- D. Lasso autour des 3 points, puis grab du groupe ---
    await lasso(480, 260, 840, 560)
    check('lasso : 3 points sélectionnés', (await selectionCount()) === '3')

    // Clic droit + drag (640,380) → (700,420) : delta écran (60,40) →
    // delta modèle (60,-40) à zoom 1 (Y inversé). Tous les points
    // sélectionnés bougent d'autant, la sélection est conservée et le
    // geste commite UNE entrée d'historique.
    await rightDrag(640, 380, 700, 420)
    const afterGrab = await shapePoints()
    const grabbedOk = afterGrab.length === 3 && afterGrab.every((p, i) =>
        closeTo(p.x, before[i].x + 60) && closeTo(p.y, before[i].y - 40))
    check('grab : les 3 points déplacés de (60,-40)', grabbedOk)
    check('grab : sélection conservée (3)', (await selectionCount()) === '3')
    check('grab : undoCount = (4) (une entrée)', (await undoCount()) === '(4)')
    check('grab : scène marquée non sauvegardée', (await sceneDirty()) === 'true')

    // --- E. AltGr (Ctrl+Alt) + clic droit + drag : déplacement global ---
    // Delta écran (20,10) → delta modèle (20,-10). moveAllActive vide
    // la sélection et déplace TOUS les points de TOUTES les formes.
    const beforeAlt = await shapePoints()
    await page.keyboard.down('Control')
    await page.keyboard.down('Alt')
    await rightDrag(640, 380, 660, 390)
    await page.keyboard.up('Alt')
    await page.keyboard.up('Control')
    const afterAlt = await shapePoints()
    const altOk = afterAlt.length === 3 && afterAlt.every((p, i) =>
        closeTo(p.x, beforeAlt[i].x + 20) && closeTo(p.y, beforeAlt[i].y - 10))
    check('AltGr : les 3 points déplacés de (20,-10)', altOk)
    check('AltGr : sélection vidée par moveAll', (await selectionCount()) === '0')
    check('AltGr : undoCount = (5) (une entrée)', (await undoCount()) === '(5)')
    check('AltGr : scène marquée non sauvegardée', (await sceneDirty()) === 'true')

    // --- F. Les gestes n'ont pas corrompu la structure ---
    info = await sceneInfo()
    check('structure intacte après gestes (3 pts / 1 tri)', info.points === 3 && info.tris === 1)

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
