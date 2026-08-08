// Smoke test du compteur FPS discret (pilule toolbar, TOUJOURS visible —
// cf. DESIGN.md §2.4.1) — playwright-core.
//
// Parcours : vérifier que la pilule #fpsCounter est présente et visible
// au boot, qu'elle affiche une valeur « N fps » positive et rafraîchie
// (boucle rAF permanente), et qu'elle est masquée en preview. L'état
// data-perf est exercé en vrai avec l'HYSTÉRÉSIS (bande morte
// [42, 48]) : warn (ambre) sous 42 fps, good (vert) au-dessus de 48 ;
// entre les deux l'état précédent est conservé — à ~45 fps la pilule ne
// doit NI passer en ambre (depuis good) NI revenir en vert (depuis
// warn). Le rAF est patché avec des timestamps EXACTS (accumulateur
// last += 1000/fps) pour simuler une fréquence précise sans dépendre de
// la jitter des timers.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-fpscounter.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')
// Bornes de l'hystérésis (viewport.js FPS_COUNTER_WARN_LOW/HIGH) —
// dupliquées ici : le smoke doit les connaître pour vérifier la
// cohérence de l'état et choisir la fréquence de la bande morte (45).
const WARN_LOW = 42
const WARN_HIGH = 48

// Patch rAF pour simuler une fréquence EXACTE : chaque callback reçoit
// un timestamp accumulé (last += 1000/fps), donc le dt mesuré par la
// boucle est exactement 1000/fps — indépendant de la jitter des timers.
const patchRafAt = (page, fps) => page.evaluate((fps) => {
    if (!window.__rafState) {
        window.__rafState = {
            orig: window.requestAnimationFrame.bind(window),
            last: performance.now(),
        }
    }
    const st = window.__rafState
    const frameTime = 1000 / fps
    window.requestAnimationFrame = (cb) => {
        st.last += frameTime
        window.setTimeout(() => cb(st.last), Math.max(0, st.last - performance.now()))
    }
}, fps)

const restoreRaf = (page) => page.evaluate(() => {
    if (!window.__rafState) return
    window.requestAnimationFrame = window.__rafState.orig
    delete window.__rafState
})

const fpsText = (page) => page.locator('#fpsCounter').textContent()
const fpsPerf = (page) => page.locator('#fpsCounter').getAttribute('data-perf')
const fpsColor = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#fpsCounter')).color)
const colorFor = (perf) => perf === 'warn' ? 'rgb(255, 210, 80)' : 'rgb(55, 194, 0)'

// Invariant avec hystérésis : l'état doit toujours être « atteignable »
// — warn ⇒ la valeur affichée est ≤ 48 (sinon l'état serait repassé en
// good), good ⇒ ≥ 42 (sinon il serait passé en warn). Bornes INCLUSIVES
// : la bande morte [42, 48] conserve l'état à exactement 42/48. Valable
// quel que soit le niveau réel de la machine.
const checkPerfConsistent = async (page) => {
    const text = (await fpsText(page)) || ''
    const perf = await fpsPerf(page)
    if (!/^\d+ fps$/.test(text)) return false
    const fps = parseInt(text, 10)
    return perf === 'warn' ? fps <= WARN_HIGH : fps >= WARN_LOW
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
    check('data-perf cohérent au boot', await checkPerfConsistent(page))
    check('couleur cohérente au boot', (await fpsColor(page)) === colorFor(await fpsPerf(page)))

    // Liveness : la boucle continue de tourner (la valeur peut rester
    // égale si le taux est stable — on vérifie seulement qu'elle reste
    // valide après un nouvel intervalle, sans erreur JS).
    await page.waitForTimeout(800)
    const text2 = (await fpsText(page)) || ''
    check('valeur rafraîchie (toujours « N fps »)',
        /^\d+ fps$/.test(text2) && parseInt(text2, 10) > 0)

    // --- Cycle d'hystérésis complet, piloté par timestamps exacts ---

    // 1) ~45 fps (dans la bande morte) depuis l'état initial : l'état
    // ne bascule PAS (valeur > 42 → pas d'entrée en warn ; ni < 48 →
    // pas de retour en good non plus). État inchangé = anti-clignotement.
    const perfBefore = await fpsPerf(page)
    await patchRafAt(page, 45)
    await page.waitForTimeout(800)
    check('bande morte (45 fps) : état inchangé', (await fpsPerf(page)) === perfBefore)
    const deadbandText = (await fpsText(page)) || ''
    const deadbandMatch = /^(\d+) fps$/.exec(deadbandText)
    check('bande morte (45 fps) : valeur dans [42, 48]',
        !!(deadbandMatch && parseInt(deadbandMatch[1], 10) >= WARN_LOW && parseInt(deadbandMatch[1], 10) <= WARN_HIGH))
    check('bande morte (45 fps) : couleur cohérente avec l\'état',
        (await fpsColor(page)) === colorFor(await fpsPerf(page)))

    // 2) ~10 fps : la valeur descend sous 42 → « warn » + ambre.
    await patchRafAt(page, 10)
    await page.waitForTimeout(1700)
    check('sous le seuil bas : data-perf="warn"', (await fpsPerf(page)) === 'warn')
    check('sous le seuil bas : couleur ambre', (await fpsColor(page)) === 'rgb(255, 210, 80)')

    // 3) Retour à ~45 fps (bande morte) depuis « warn » : PAS de retour
    // en vert (la valeur reste < 48 — anti-clignotement côté haut).
    await patchRafAt(page, 45)
    await page.waitForTimeout(800)
    check('bande morte (45 fps) : reste « warn »', (await fpsPerf(page)) === 'warn')
    check('bande morte (45 fps) : couleur toujours ambre', (await fpsColor(page)) === 'rgb(255, 210, 80)')

    // 4) rAF réel restauré : la fréquence remonte (> 48) → « good » et
    // l'état redevient cohérent (indépendamment du niveau de la machine).
    await restoreRaf(page)
    await page.waitForTimeout(600)
    check('restauré : data-perf cohérent', await checkPerfConsistent(page))
    check('restauré : couleur cohérente avec l\'état', (await fpsColor(page)) === colorFor(await fpsPerf(page)))

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
