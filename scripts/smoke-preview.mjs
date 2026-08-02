// Smoke test du mode preview — playwright-core + Chromium système.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-preview.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs (launchBrowser, createHarness,
// attachErrorCollector). Le binaire Chromium est CHROMIUM_PATH
// (défaut /usr/bin/chromium) ; la base URL est le 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')
// Mesh : 0,0;10,0;5,8.66;5,0;8,4.33  →  2 triangles + 1 reliquat partiel
// (filtré à l'hydratation), scène chargée sans file picker via
// ?autoimport= (cf. README « Astuces de développement »).
const AUTOIMPORT = 'MCwwOzEwLDA7NSw4LjY2OzUsMDs4LDQuMzM'
const URL = BASE_URL + '?autoimport=' + AUTOIMPORT

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    // Laisse l'autoimport + le boot (doit) se dérouler.
    await page.waitForTimeout(500)

    // --- 1. La scène a été chargée (autoimport) ---
    const scene = await page.evaluate((key) => localStorage.getItem(key) || '', SCENE_STORAGE_KEY)
    check('autoimport : scène persistée avec tris', scene.includes('"tris"'))

    // --- 2. Bouton preview présent, toolbar visible au départ ---
    check('bouton #preview présent', await page.locator('#preview').count() === 1)
    check('toolbar visible au départ', await page.locator('#toolbar').isVisible())

    // --- 3. Grille activée (G) pour vérifier son masquage en preview ---
    await page.keyboard.press('g')
    check('grille active', await page.locator('#grid').evaluate((el) => el.classList.contains('grid-active')))

    // --- 4. Entrée en preview via le bouton ---
    await page.locator('#preview').click()
    await page.waitForTimeout(150)
    check('body.preview-mode posé', await page.evaluate(() => document.body.classList.contains('preview-mode')))
    check('toolbar masquée', !(await page.locator('#toolbar').isVisible()))
    check('#coords masqué', !(await page.locator('#coords').isVisible()))
    check('#zoomDisplay masqué', !(await page.locator('#zoomDisplay').isVisible()))
    check('#sceneStatus masqué', !(await page.locator('#sceneStatus').isVisible()))
    check('#messageBoard masqué', !(await page.locator('#messageBoard').isVisible()))

    // --- 5. Navigation : molette zoom pendant la preview ---
    // updateZoomDisplay est appelé par le chemin zoom même en preview,
    // donc un changement de texte prouve que la molette a zoomé (et
    // n'a PAS pivoter la sélection — la rotation ne touche pas au zoom).
    await page.mouse.move(640, 400)
    const zoomBefore = await page.locator('#zoomDisplay').textContent()
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(120)
    const zoomAfter = await page.locator('#zoomDisplay').textContent()
    check('molette zoome pendant la preview', zoomBefore !== zoomAfter)

    // --- 6. Sortie clavier : Échap ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Échap : preview quittée', !(await page.evaluate(() => document.body.classList.contains('preview-mode'))))
    check('Échap : toolbar de retour', await page.locator('#toolbar').isVisible())

    // --- 7. Sortie clavier : P (re-entre) puis clic gauche (sort) ---
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('P : preview ré-activée', await page.evaluate(() => document.body.classList.contains('preview-mode')))
    await page.mouse.click(640, 400)
    await page.waitForTimeout(150)
    check('clic gauche : preview quittée', !(await page.evaluate(() => document.body.classList.contains('preview-mode'))))
    check('clic gauche : toolbar de retour', await page.locator('#toolbar').isVisible())

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
