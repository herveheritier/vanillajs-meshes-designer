// Smoke test de la rotation à la molette — playwright-core.
//
// Parcours (viewport 1280×800, zoom 1) :
//   • A. 2 points sélectionnés + molette → ROTATION de la sélection
//     autour de la position du curseur (le pivot), ROTATE_STEP = 5°.
//     Vérification par la math exacte (même formule que
//     rotateSelectedPoints), pivot lu depuis l'état réel de l'app via
//     import('./state.js') (même instance de module que la page).
//   • C. AltGr (Ctrl+Alt) + molette → rotation GLOBALE de toutes les
//     formes autour du curseur (rotateEachShapeAroundPivot), la
//     sélection est vidée.
//   • B. < 2 points sélectionnés → la molette ZOOME (snapZoom 1.1)
//     sans toucher à la géométrie.
//
// Chaque rotation est commitée par un debounce de 400 ms (wheel timer)
// → UNE entrée d'historique : on attend #undoCount avant de lire le
// localStorage (persistState n'écrit qu'au commit du debounce).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-rotate.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

const TRIANGLE = [
    { x: 520, y: 300 },
    { x: 800, y: 300 },
    { x: 660, y: 520 },
]

// ROTATE_STEP (constants.js) = 5° — replica de la formule de
// rotation utilisée par rotateSelectedPoints / rotateEachShapeAroundPivot.
const DEG5 = (5 * Math.PI) / 180
const rotate = (p, c, a) => {
    const dx = p.x - c.x
    const dy = p.y - c.y
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

const EPS = 1e-3
const closeTo = (a, b) => Math.abs(a - b) < EPS
const samePoint = (p, q) => closeTo(p.x, q.x) && closeTo(p.y, q.y)

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Positions [x, y] de la forme active depuis le localStorage.
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

// Accès à l'état réel de l'app : import('./state.js') résout la MÊME
// instance de module que la page (cache de modules par URL) → on lit
// le vrai center pixel / viewCenter / zoomLevel sans dupliquer la
// transform (cf. connaissance §ctx : center = pixel de l'origine,
// viewCenter = point modèle centré).
const readCtx = () => page.evaluate(async () => {
    const m = await import('./state.js')
    return {
        center: { x: m.state.ctx.center.x, y: m.state.ctx.center.y },
        viewCenter: { x: m.state.ctx.viewCenter.x, y: m.state.ctx.viewCenter.y },
        zoom: m.state.ctx.zoomLevel,
    }
})

const { undoCount } = hudHelpers(page)
const selectionCount = () => page.locator('#selectionCount').textContent()

const draw = async (points) => {
    for (const c of points) {
        await page.mouse.click(c.x, c.y)
        await page.waitForTimeout(120)
    }
}

const lasso = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
}

// Attend le commit du debounce de rotation (400 ms) via le pill undo.
const waitUndo = async (expected) => {
    await page.waitForFunction(
        (n) => document.querySelector('#undoCount').textContent === n,
        expected,
        { timeout: 4000 }
    )
}

// screenToModel exact (réplique de la transform de l'app : le point
// modèle viewCenter est mappé au pixel center, Y inversé) pour un
// point écran.
const screenToModel = (ctx, sx, sy) => ({
    x: ctx.viewCenter.x + (sx - ctx.center.x) / ctx.zoom,
    y: ctx.viewCenter.y - (sy - ctx.center.y) / ctx.zoom,
})

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // ================= A. Molette sur sélection = rotation =================
    await draw(TRIANGLE)
    let before = await shapePoints()
    check('A : triangle dessiné (3 points)', before.length === 3)

    await lasso(480, 260, 840, 330)
    check('A : 2 points sélectionnés', (await selectionCount()) === '2')

    let ctx = await readCtx()
    check('A : zoom initial = 1', ctx.zoom === 1)

    // Curseur au milieu de l'arête p0-p1 (660,300) → pivot = sa position
    // modèle. Molette UP (deltaY < 0) → angle = -ROTATE_STEP.
    await page.mouse.move(660, 300)
    await page.mouse.wheel(0, -120)
    // La rotation commute un debounce de 400 ms : attendre l'entrée undo.
    await waitUndo('(4)')

    const after = await shapePoints()
    const pivot = screenToModel(ctx, 660, 300)
    const exp0 = rotate(before[0], pivot, -DEG5)
    const exp1 = rotate(before[1], pivot, -DEG5)
    check('A : p0 tourné de -5° autour du curseur', samePoint(after[0], exp0))
    check('A : p1 tourné de -5° autour du curseur', samePoint(after[1], exp1))
    check('A : p2 (non sélectionné) inchangé', samePoint(after[2], before[2]))
    check('A : distances p0-p1 conservées (rotation rigide)',
        closeTo(Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y),
                Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y)))
    ctx = await readCtx()
    check('A : zoom inchangé (rotation ≠ zoom)', ctx.zoom === 1)
    check('A : une seule entrée undo (debounce 400ms)', (await undoCount()) === '(4)')

    // ============ C. AltGr + molette = rotation globale autour du curseur ============
    before = await shapePoints()
    check('C : sélection encore active (2)', (await selectionCount()) === '2')
    ctx = await readCtx()
    await page.keyboard.down('Control')
    await page.keyboard.down('Alt')
    await page.mouse.move(660, 300)
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Alt')
    await page.keyboard.up('Control')
    await waitUndo('(5)')

    const afterAlt = await shapePoints()
    const pivotAlt = screenToModel(ctx, 660, 300)
    const altOk = afterAlt.length === 3 && afterAlt.every((p, i) =>
        samePoint(p, rotate(before[i], pivotAlt, -DEG5)))
    check('C : les 3 points tournés de -5° autour du curseur', altOk)
    check('C : AltGr vide la sélection', (await selectionCount()) === '0')
    ctx = await readCtx()
    check('C : zoom inchangé', ctx.zoom === 1)
    check('C : une seule entrée undo', (await undoCount()) === '(5)')

    // ============ B. < 2 sélectionnés → la molette zoome ============
    check('B : sélection vide au départ', (await selectionCount()) === '0')
    before = await shapePoints()
    ctx = await readCtx()
    await page.mouse.move(660, 300)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(150)
    ctx = await readCtx()
    check('B : zoom 1 → 1.1 (snapZoom)', ctx.zoom === 1.1)
    const afterZoom = await shapePoints()
    check('B : géométrie inchangée par le zoom',
        afterZoom.length === 3 && afterZoom.every((p, i) => samePoint(p, before[i])))

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
