// Smoke test du mode preview — playwright-core + Chromium système.
//
// Couvre le cycle en 3 états du bouton prévisualiser (évolution bouton
// prévisualiser, cf. DESIGN.md §2.6) :
//   off -> preview simple (chrome masquée, géométrie seule)
//       -> plans (tous les plans rendus dans leur ordre, bouton en
//          accent ambre + libellé « plans »)
//       -> off
// Le bouton #preview flotte pendant la preview (seule chrome
// conservée) pour que le cycle au clic soit possible. Sortie directe
// par Échap ou clic gauche sur le canvas. P cycle comme le bouton.
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

// Petit helper : état du cycle lu depuis le DOM (le module state.js
// n'est pas exposé sur window) — les classes du bouton + le libellé
// #previewText reflètent l'état courant.
const previewState = () => page.evaluate(() => ({
    mode: document.body.classList.contains('preview-mode'),
    plans: document.querySelector('#preview')?.classList.contains('preview-plans') || false,
    label: document.querySelector('#previewText')?.textContent || '',
}))

// Clic sur le bouton #preview puis blur : après un clic, le bouton
// garde le focus, et les raccourcis clavier de la toolbar (P comme
// G/R/F) sont gardés par `!inPreviewBtn` (e.target = bouton → P
// ignoré). Le blur rend le clavier opérationnel pour la suite.
const clickPreview = async () => {
    await page.locator('#preview').click()
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur()
        }
    })
}

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

    // --- 4. 1er clic sur le bouton : entrée en preview simple ---
    await clickPreview()
    await page.waitForTimeout(150)
    check('1er clic : body.preview-mode posé', (await previewState()).mode)
    check('1er clic : pas d\'état plans', !(await previewState()).plans)
    // Le bouton #preview flotte (seule chrome conservée en preview)
    // pour permettre le cycle au clic — les autres éléments sont masqués.
    check('1er clic : bouton #preview visible (flottant)', await page.locator('#preview').isVisible())
    check('1er clic : bouton .preview-active', await page.locator('#preview').evaluate((el) => el.classList.contains('preview-active')))
    check('1er clic : bouton grille masqué', !(await page.locator('#grid').isVisible()))
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

    // --- 6. 2e clic sur le bouton : vue plans ---
    await clickPreview()
    await page.waitForTimeout(150)
    check('2e clic : preview toujours active', (await previewState()).mode)
    check('2e clic : état plans actif', (await previewState()).plans)
    check('2e clic : libellé « plans »', (await previewState()).label === 'plans')
    check('2e clic : bouton .preview-plans', await page.locator('#preview').evaluate((el) => el.classList.contains('preview-plans')))
    // La chrome reste masquée en plans.
    check('2e clic : bouton grille masqué', !(await page.locator('#grid').isVisible()))
    check('2e clic : #coords masqué', !(await page.locator('#coords').isVisible()))
    // La molette zoome toujours en plans (visualisation seule). Le
    // clic du 2e bouton a laissé la souris sur le bouton : on la
    // ramène sur le canvas avant la molette (l'événement wheel doit
    // atteindre #board, pas le bouton).
    await page.mouse.move(640, 400)
    const zoomPlansBefore = await page.locator('#zoomDisplay').textContent()
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(120)
    const zoomPlansAfter = await page.locator('#zoomDisplay').textContent()
    check('molette zoome en plans', zoomPlansBefore !== zoomPlansAfter)

    // --- 7. 3e clic sur le bouton : sortie ---
    await clickPreview()
    await page.waitForTimeout(150)
    check('3e clic : preview quittée', !(await previewState()).mode)
    check('3e clic : état plans remis à off', !(await previewState()).plans)
    check('3e clic : toolbar de retour', await page.locator('#toolbar').isVisible())
    check('3e clic : bouton grille de retour', await page.locator('#grid').isVisible())

    // --- 8. Cycle clavier P : p -> preview -> plans -> off ---
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('P : preview ré-activée', (await previewState()).mode && !(await previewState()).plans)
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('P : état plans', (await previewState()).mode && (await previewState()).plans)
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('P : preview quittée', !(await previewState()).mode && !(await previewState()).plans)

    // --- 9. Échap depuis les plans : sortie directe ---
    await page.keyboard.press('p')
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('Échap depuis plans : état plans actif avant sortie', (await previewState()).plans)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Échap : preview quittée', !(await previewState()).mode)
    check('Échap : toolbar de retour', await page.locator('#toolbar').isVisible())

    // --- 10. Clic gauche sur le canvas : sortie directe ---
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('clic gauche : preview active avant clic', (await previewState()).mode)
    await page.mouse.click(640, 400)
    await page.waitForTimeout(150)
    check('clic gauche : preview quittée', !(await previewState()).mode)
    check('clic gauche : toolbar de retour', await page.locator('#toolbar').isVisible())

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
