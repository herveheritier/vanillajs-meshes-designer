// Smoke test du presse-papiers interne (couper / copier / coller) —
// playwright-core.
//
// Parcours : dessiner un triangle (3 clics gauche), le peindre (premier
// swatch de la palette, pour vérifier que le fill survit au
// copier/coller), tout sélectionner, puis :
//   - états disabled des boutons #copy / #cut / #paste au fil de la
//     sélection et du presse-papiers ;
//   - copier (Ctrl+C) puis coller (Ctrl+V) : 6 points / 2 tris, la
//     copie décalée d'un demi-pas de grille (GRID_STEP=32 → 16) et
//     sélectionnée, fill du triangle copié conservé ;
//   - re-coller via le bouton #paste : 9 points / 3 tris (cascade : le
//     2e collage est à +32 de la source) ;
//   - annuler ×2 (Ctrl+Z) : retour à 3 points / 1 tri ;
//   - couper (Ctrl+X) : scène vide mais presse-papiers conservé (le
//     bouton Coller reste actif) ;
//   - recoller (Ctrl+V) : le triangle revient (3 points / 1 tri, p3=2).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-clipboard.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Positions écran des 3 clics (viewport 1280×800) : loin de la toolbar
// (haut-gauche) et de la console, formant un triangle non dégénéré.
// GRID_STEP par défaut = 32 → le collage décale d'un demi-pas = 16.
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
        const pl = Array.isArray(shape.pointList) ? shape.pointList : []
        const tris = Array.isArray(shape.tris) ? shape.tris : []
        return {
            points: pl.length,
            tris: tris.length,
            p3: tris[0] ? tris[0].p3 : undefined,
            fills: tris.map(t => t.fill).filter(f => typeof f === 'string'),
            coords: pl.map(p => ({ x: p.x, y: p.y })),
        }
    } catch (e) {
        return { points: -1, tris: -1, p3: undefined, fills: [], coords: [] }
    }
}, SCENE_STORAGE_KEY)

const selectionCount = () => page.locator('#selectionCount').textContent()
const copyDisabled = () => page.locator('#copy').isDisabled()
const cutDisabled = () => page.locator('#cut').isDisabled()
const pasteDisabled = () => page.locator('#paste').isDisabled()

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Dessiner un triangle puis le peindre (1er swatch) ---
    for (const c of CLICKS) {
        await page.mouse.click(c.x, c.y)
        await page.waitForTimeout(120)
    }
    await page.click('#triangleColor')
    await page.waitForTimeout(100)
    await page.locator('#triangleColorSwatches .swatch').first().click()
    // Clic dans le triangle (centroïde ≈ 660,373) : pinceau armé → peint.
    await page.mouse.click(660, 373)
    await page.waitForTimeout(120)
    await page.keyboard.press('Escape') // ferme la palette (désarme le pinceau)
    let info = await sceneInfo()
    check('triangle peint : 1 fill', info.fills.length === 1)
    const paintedFill = info.fills[0]

    // --- 2. États disabled des boutons ---
    check('copier désactivé sans sélection', await copyDisabled())
    check('couper désactivé sans sélection', await cutDisabled())
    check('coller désactivé sans presse-papiers', await pasteDisabled())

    await page.click('#selectAll')
    await page.waitForTimeout(100)
    check('tout sélectionner : 3 points', (await selectionCount()) === '3')
    check('copier actif avec sélection', !(await copyDisabled()))
    check('couper actif avec sélection', !(await cutDisabled()))
    check('coller toujours désactivé (presse-papiers vide)', await pasteDisabled())

    // --- 3. Copier (Ctrl+C) puis coller (Ctrl+V) ---
    await page.keyboard.press('Control+c')
    await page.waitForTimeout(100)
    check('coller actif après copie', !(await pasteDisabled()))
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('coller : 6 points / 2 tris', info.points === 6 && info.tris === 2)
    check('coller : copie décalée d\'un demi-pas de grille (16)',
        Math.abs(info.coords[3].x - info.coords[0].x - 16) < 0.01
        && Math.abs(info.coords[3].y - info.coords[0].y - 16) < 0.01)
    check('coller : fill du triangle copié conservé', info.fills.length === 2 && info.fills.includes(paintedFill))
    check('coller : copie collée sélectionnée', (await selectionCount()) === '3')

    // --- 4. Re-coller via le bouton #paste (cascade : +32 de la source) ---
    await page.click('#paste')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('re-coller : 9 points / 3 tris', info.points === 9 && info.tris === 3)
    check('re-coller : cascade (2e collage à +32 de la source)',
        Math.abs(info.coords[6].x - info.coords[0].x - 32) < 0.01)

    // --- 5. Annuler ×2 → retour au triangle d'origine ---
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('undo ×2 : 3 points / 1 tri', info.points === 3 && info.tris === 1)

    // --- 6. Couper (bouton #cut) : suppression + presse-papiers conservé ---
    await page.click('#selectAll')
    await page.waitForTimeout(100)
    await page.click('#cut')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('couper : scène vide (0 point / 0 tri)', info.points === 0 && info.tris === 0)
    check('couper : presse-papiers conservé (coller actif)', !(await pasteDisabled()))
    check('couper : sélection vidée', (await selectionCount()) === '0')

    // --- 7. Recoller → le triangle revient ---
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('recoller après couper : 3 points / 1 tri (p3=2)', info.points === 3 && info.tris === 1 && info.p3 === 2)
    check('recoller : fill conservé', info.fills.includes(paintedFill))

    // --- 8. Reset complet : le presse-papiers est vidé (plus rien à coller) ---
    // Evolution : un contenu copié avant le reset référence l'ancienne
    // scène — le vider évite de coller de la géométrie fantôme (même
    // politique que l'historique, cf. resetAll / resetEphemeralState).
    await page.click('#reset')
    await page.waitForTimeout(100)
    check('reset : modale ouverte', await page.locator('#resetModal').isVisible())
    await page.click('#resetModalValidate')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('reset : scène vidée', info.points === 0 && info.tris === 0)
    check('reset : presse-papiers vidé (coller désactivé)', await pasteDisabled())
    check('reset : copier/couper désactivés (aucune sélection)', await copyDisabled() && await cutDisabled())

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
