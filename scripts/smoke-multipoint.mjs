// Smoke test du marqueur des sommets multi-points (anneau orange) —
// playwright-core.
//
// Evolution « ajouter une distinction visuelle pour les sommets qui
// correspondent à plusieurs points afin de faciliter leur
// regroupement » (cf. DESIGN.md §7.10) : un anneau orange
// (COLOR_MULTI_POINT = #FFA500) entoure les sommets du plan actif
// dont la position porte PLUSIEURS entrées pointList (doublons de
// scènes legacy/importées) — candidats à la fusion #mergePoints.
//
// Parcours :
//   A. Contre-épreuve négative : scène seedée SANS doublons → aucun
//      pixel orange sur le canvas (le rendu normal — points jaunes,
//      lignes blanches, triangles — ne produit pas de faux positif).
//   B. Scène seedée AVEC un doublon (2 entrées pointList au même
//      coord, chacune référencée par un triangle différent) → l'anneau
//      orange est visible sur le canvas.
//   C. Clic gauche sur le sommet doublé (mode vertex par défaut :
//      sélectionne TOUT le cluster) → bouton Fusionner → les doublons
//      sont regroupés en une seule entrée (4 → 3 points) et l'anneau
//      disparaît.
//
// Le seed passe par page.addInitScript (localStorage écrit AVANT le
// boot de l'app) : un simple setItem + reload serait écrasé par le
// handler beforeunload de l'app (qui re-sérialise l'état courant).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-multipoint.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

const { check, finish } = createHarness()

// Scène de contrôle : un triangle SANS doublon (invariant I3 respecté).
// viewCenter (0,0) + zoom 1 → le sommet (0,0) se projette au CENTRE du
// canvas, ce qui rend la position du doublon de la phase B prédictible.
const SCENE_NO_DUP = {
    format: 'meshes-designer', version: 1, name: 'no-dup',
    activeGrid: false, GRID_STEP: 32,
    shapes: [{
        pointList: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
        tris: [{ p1: 0, p2: 1, p3: 2 }],
    }],
    activeShapeIndex: 0, zoomLevel: 1, viewCenter: { x: 0, y: 0 },
}

// Scène avec un DOUBLON : p3 = (0,0) duplicate de p0. Chaque entrée
// est référencée par un triangle distinct (aucun orphelin I2) → le
// cluster au sommet (0,0) est un vrai candidat à la fusion.
const SCENE_DUP = {
    format: 'meshes-designer', version: 1, name: 'dup',
    activeGrid: false, GRID_STEP: 32,
    shapes: [{
        pointList: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 0 }],
        tris: [{ p1: 0, p2: 1, p3: 2 }, { p1: 3, p2: 1, p3: 2 }],
    }],
    activeShapeIndex: 0, zoomLevel: 1, viewCenter: { x: 0, y: 0 },
}

const seedScene = (page, scene) => page.addInitScript(({ key, value }) => {
    try { localStorage.setItem(key, value) } catch (e) { /* ignore */ }
}, { key: SCENE_STORAGE_KEY, value: JSON.stringify(scene) })

// Compte les pixels ORANGE (#FFA500 = 255,165,0) sur tout le canvas.
// Prédicat serré (r>230, 130<g<190, b<60) : les pixels de bord
// antialiasés des points jaunes (#FFFF00, g décroît AVEC r le long du
// dégradé vers le noir) ne peuvent pas matcher simultanément r>230 et
// g<190 — pas de faux positif du rendu normal (vérifié en phase A).
const countOrangePixels = (page) => page.evaluate(() => {
    const board = document.querySelector('#board')
    const ctx = board.getContext('2d')
    const img = ctx.getImageData(0, 0, board.width, board.height).data
    let orange = 0
    for (let i = 0; i < img.length; i += 4) {
        const r = img[i]
        const g = img[i + 1]
        const b = img[i + 2]
        if (r > 230 && g > 130 && g < 190 && b < 60) orange++
    }
    return orange
})

// Compte les pixels orange dans une fenêtre 32×32 autour de la
// position CSS (x, y) du canvas — renforce le check de PRÉSENCE du
// marqueur par un check de POSITION (même pattern que
// countGreenPixelsNear de smoke_lib.mjs). Le doublon seedé est en
// modèle (0,0) ; avec viewCenter (0,0) et zoom 1, l'anneau doit
// apparaître au CENTRE du canvas, pas ailleurs.
const countOrangePixelsNear = (page, cssX, cssY) => page.evaluate(({ x, y }) => {
    const board = document.querySelector('#board')
    const ctx = board.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(x * dpr)
    const py = Math.round(y * dpr)
    const img = ctx.getImageData(px - 16, py - 16, 32, 32).data
    let orange = 0
    for (let i = 0; i < img.length; i += 4) {
        const r = img[i]
        const g = img[i + 1]
        const b = img[i + 2]
        if (r > 230 && g > 130 && g < 190 && b < 60) orange++
    }
    return orange
}, { x: cssX, y: cssY })

// Info sommaire du plan actif depuis le localStorage.
const sceneInfo = (page) => page.evaluate((key) => {
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

const browser = await launchBrowser()

try {
    // ===================== A. Contre-épreuve négative =====================
    const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsA = attachErrorCollector(pageA)
    await seedScene(pageA, SCENE_NO_DUP)
    await pageA.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageA.waitForSelector('#board')
    await pageA.waitForTimeout(400)

    let info = await sceneInfo(pageA)
    check('A : scène seedée chargée (3 pts / 1 tri)', info.points === 3 && info.tris === 1)
    const orangeA = await countOrangePixels(pageA)
    check('A : aucun pixel orange sans doublon', orangeA === 0)
    await pageA.close()

    // ===================== B. Marqueur visible sur doublon =====================
    const pageB = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsB = attachErrorCollector(pageB)
    const { undoCount } = hudHelpers(pageB)
    const selectionCount = () => pageB.locator('#selectionCount').textContent()
    await seedScene(pageB, SCENE_DUP)
    await pageB.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageB.waitForSelector('#board')
    await pageB.waitForTimeout(400)

    info = await sceneInfo(pageB)
    check('B : scène avec doublon chargée (4 pts / 2 tris)', info.points === 4 && info.tris === 2)
    const orangeB = await countOrangePixels(pageB)
    check('B : anneau orange visible sur le sommet doublé', orangeB > 0)
    // Position : le doublon (0,0) se projette au centre du canvas
    // (viewCenter 0, zoom 1) — l'anneau doit y être, pas ailleurs.
    const centerB = await pageB.evaluate(() => {
        const rect = document.querySelector('#board').getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    const orangeAtCenter = await countOrangePixelsNear(pageB, centerB.x, centerB.y)
    check('B : anneau positionné au sommet doublé (centre du canvas)', orangeAtCenter > 0)

    // ===================== C. Fusion du cluster → anneau disparu =====================
    // Clic gauche au CENTRE du canvas = position modèle (0,0) où les
    // deux doublons p0/p3 sont superposés. Mode vertex (défaut) :
    // processMouseUpSelection sélectionne TOUT le cluster
    // (getIndicesAtSamePosition).
    const center = await pageB.evaluate(() => {
        const rect = document.querySelector('#board').getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await pageB.mouse.click(center.x, center.y)
    await pageB.waitForTimeout(150)
    check('C : clic sur le doublon sélectionne tout le cluster (2)', (await selectionCount()) === '2')

    await pageB.click('#mergePoints')
    await pageB.waitForTimeout(200)
    info = await sceneInfo(pageB)
    check('C : fusion regroupe les doublons (4 → 3 pts, 2 tris)', info.points === 3 && info.tris === 2)
    check('C : sélection = survivant (1)', (await selectionCount()) === '1')
    check('C : une entrée undo en plus', (await undoCount()) === '(1)')

    const orangeC = await countOrangePixels(pageB)
    check('C : anneau disparu après fusion', orangeC === 0)

    check('aucune erreur JS sur tout le parcours', errorsA.length === 0 && errorsB.length === 0)
    await pageB.close()
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
}

await browser.close()
finish()
