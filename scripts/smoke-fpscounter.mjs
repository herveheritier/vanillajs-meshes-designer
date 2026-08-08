// Smoke test du compteur FPS discret (pilule toolbar, TOUJOURS visible —
// cf. DESIGN.md §2.4.1) — playwright-core.
//
// Parcours : vérifier que la pilule #fpsCounter est présente et visible
// au boot, qu'elle affiche une valeur « N fps » positive et rafraîchie
// (boucle rAF permanente démarrée par startFpsCounter), et qu'elle est
// masquée en preview (chrome masquée par les :has() du groupe canvas
// ops). En plus : l'état data-perf — « good » (vert) quand la fréquence
// est ≥ 45, « warn » (ambre) sous le seuil ; le warn est exercé en
// vrai en throttlant requestAnimationFrame (frames à 100 ms → ~10 fps),
// puis le retour à « good » après restauration.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-fpscounter.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')
// Seuil de fluidité (viewport.js FPS_COUNTER_WARN_THRESHOLD) — dupliqué
// ici : le smoke doit le connaître pour vérifier la cohérence de l'état.
const WARN_THRESHOLD = 45

// La pilule affiche « N fps » (entier positif suivi de l'unité).
const fpsText = (page) => page.locator('#fpsCounter').textContent()
const fpsPerf = (page) => page.locator('#fpsCounter').getAttribute('data-perf')
const fpsColor = (page) => page.evaluate(() => {
    const el = document.querySelector('#fpsCounter')
    return getComputedStyle(el).color
})
// Invariant : l'état data-perf doit toujours refléter le seuil appliqué
// à la valeur affichée (« good » ⇔ fps ≥ 45), indépendamment de la
// vitesse réelle de la machine.
const checkPerfConsistent = async (page) => {
    const text = (await fpsText(page)) || ''
    const perf = await fpsPerf(page)
    if (!/^\d+ fps$/.test(text)) return false
    const fps = parseInt(text, 10)
    return (fps >= WARN_THRESHOLD) === (perf === 'good')
}

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
    check('data-perf cohérent avec le seuil au boot', await checkPerfConsistent(page))
    check('couleur cohérente avec data-perf au boot',
        (await fpsColor(page)) === ((await fpsPerf(page)) === 'warn' ? 'rgb(255, 210, 80)' : 'rgb(55, 194, 0)'))

    // Liveness : la boucle continue de tourner (la valeur peut rester
    // égale si le taux est stable — on vérifie seulement qu'elle reste
    // valide après un nouvel intervalle, sans erreur JS).
    await page.waitForTimeout(800)
    const text2 = (await fpsText(page)) || ''
    check('valeur rafraîchie (toujours « N fps »)',
        /^\d+ fps$/.test(text2) && parseInt(text2, 10) > 0)

    // --- État « warn » : throttle rAF à ~10 fps (frames à 100 ms) → la
    // valeur converge sous le seuil et la pilule passe en ambre. ---
    await page.evaluate(() => {
        window.__origRaf = window.requestAnimationFrame.bind(window)
        // rAF patché : un callback toutes les 100 ms (~10 fps).
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 100)
    })
    // 16 échantillons à 100 ms : l'EMA (0.1) converge ~10.5 → warn.
    await page.waitForTimeout(1700)
    check('sous le seuil : data-perf="warn"', (await fpsPerf(page)) === 'warn')
    check('sous le seuil : couleur ambre', (await fpsColor(page)) === 'rgb(255, 210, 80)')

    // --- Restauration : le rAF réel reprend, la valeur remonte et
    // l'état redevient cohérent (généralement « good »). ---
    await page.evaluate(() => {
        window.requestAnimationFrame = window.__origRaf
        delete window.__origRaf
    })
    await page.waitForTimeout(1700)
    check('restauré : data-perf de nouveau cohérent avec le seuil', await checkPerfConsistent(page))
    check('restauré : couleur de nouveau cohérente',
        (await fpsColor(page)) === ((await fpsPerf(page)) === 'warn' ? 'rgb(255, 210, 80)' : 'rgb(55, 194, 0)'))

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
