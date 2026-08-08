// Smoke test du compteur FPS discret (pilule toolbar, TOUJOURS visible —
// cf. DESIGN.md §2.4.1) — playwright-core.
//
// Parcours : vérifier que la pilule #fpsCounter est présente et visible
// au boot, qu'elle affiche une valeur « N fps » positive et rafraîchie
// (boucle rAF permanente démarrée par startFpsCounter), et qu'elle est
// masquée en preview (chrome masquée par les :has() du groupe canvas
// ops, comme le reste de la toolbar) puis de retour à la sortie.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-fpscounter.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// La pilule affiche « N fps » (entier positif suivi de l'unité).
const fpsText = (page) => page.locator('#fpsCounter').textContent()

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(500)

    const fpsCounter = page.locator('#fpsCounter')
    check('pilule #fpsCounter présente', await fpsCounter.count() === 1)
    check('pilule #fpsCounter visible', await fpsCounter.isVisible())

    // Après ~0.5 s la boucle rAF a tourné : valeur « N fps » positive
    // (fréquence rAF de la session — > 0 même sur machine lente).
    const text1 = (await fpsText(page)) || ''
    check('valeur « N fps » positive',
        /^\d+ fps$/.test(text1) && parseInt(text1, 10) > 0)

    // Liveness : la boucle continue de tourner (la valeur peut rester
    // égale si le taux est stable — on vérifie seulement qu'elle reste
    // valide après un nouvel intervalle, sans erreur JS).
    await page.waitForTimeout(800)
    const text2 = (await fpsText(page)) || ''
    check('valeur rafraîchie (toujours « N fps »)',
        /^\d+ fps$/.test(text2) && parseInt(text2, 10) > 0)

    // Masquage en preview : la pilule est dans le groupe canvas ops,
    // les règles :has() de body.preview-mode la masquent (aucune règle
    // dédiée nécessaire — cf. DESIGN.md §2.4.1).
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    check('preview : pilule #fpsCounter masquée', !(await fpsCounter.isVisible()))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('sortie preview : pilule de retour', await fpsCounter.isVisible())

    check('aucune erreur JS', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
}

await browser.close()
finish()
