// Smoke test du workflow d'édition de base — playwright-core.
//
// Parcours : dessiner un triangle (3 clics gauche), vérifier la scène
// persistée, annuler (Ctrl+Z ×3) jusqu'à la scène vide, rétablir
// (Ctrl+Y ×3), puis exporter en JSON (Ctrl+S) et valider le fichier
// téléchargé + le passage du statut HUD à « sauvegardée ».
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-edit.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, readDownload, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Positions écran des 3 clics (viewport 1280×800) : loin de la toolbar
// (haut-gauche) et de la console, formant un triangle non dégénéré.
const CLICKS = [
    { x: 520, y: 300 },
    { x: 800, y: 300 },
    { x: 660, y: 520 },
]

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Snapshot lisible de la forme active depuis le localStorage de la page.
const sceneInfo = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        const tri = (Array.isArray(shape.tris) && shape.tris[0]) || {}
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.length : 0,
            p3: tri.p3,
        }
    } catch (e) {
        return { points: -1, tris: -1, p3: undefined }
    }
}, SCENE_STORAGE_KEY)

const { undoCount, sceneDirty } = hudHelpers(page)
const undoDisabled = () => page.locator('#undo').isDisabled()
const redoDisabled = () => page.locator('#redo').isDisabled()

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Dessiner un triangle : 3 clics gauche ---
    for (const c of CLICKS) {
        await page.mouse.click(c.x, c.y)
        await page.waitForTimeout(120)
    }
    let info = await sceneInfo()
    check('triangle dessiné : 3 points', info.points === 3)
    check('triangle dessiné : 1 tri complet (p3=2)', info.tris === 1 && info.p3 === 2)
    check('undoCount = (3)', (await undoCount()) === '(3)')
    check('undo actif', !(await undoDisabled()))
    check('scene marquée non sauvegardée', (await sceneDirty()) === 'true')

    // --- 2. Annuler pas à pas (Ctrl+Z) ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('undo ×1 : p3 retiré (tri partiel)', info.p3 === undefined && info.points === 2)

    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('undo ×3 : scène vide', info.points === 0 && info.tris === 0)
    check('undoCount = (0)', (await undoCount()) === '(0)')
    check('undo désactivé', await undoDisabled())
    check('redo actif après 3 undos', !(await redoDisabled()))

    // --- 3. Rétablir (Ctrl+Y) jusqu'au triangle complet ---
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('redo ×3 : triangle reconstruit', info.points === 3 && info.tris === 1 && info.p3 === 2)
    check('redo désactivé après 3 redos', await redoDisabled())
    check('undoCount = (3) après redos', (await undoCount()) === '(3)')

    // --- 4. Export JSON (Ctrl+S) ---
    const downloadPromise = page.waitForEvent('download')
    await page.keyboard.press('Control+s')
    const download = await downloadPromise
    check('téléchargement déclenché', !!download)
    check('nom de fichier mesh-*.json', /^mesh-\d+\.json$/.test(download.suggestedFilename()))
    const exported = await readDownload(download)
    let exp = null
    try { exp = JSON.parse(exported) } catch (e) { /* le check suivant transforme le parse KO en FAIL */ }
    check('export : JSON valide', !!exp)
    if (exp) {
        check('export : format meshes-designer v1', exp.format === 'meshes-designer' && exp.version === 1)
        const shape = (exp.shapes && exp.shapes[0]) || {}
        check('export : triangle complet (3 pts, p3=2)',
            Array.isArray(shape.pointList) && shape.pointList.length === 3
            && Array.isArray(shape.tris) && shape.tris[0] && shape.tris[0].p3 === 2)
    }
    check('HUD scène sauvegardée après export', (await sceneDirty()) === 'false')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
