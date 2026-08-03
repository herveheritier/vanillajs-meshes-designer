// Smoke test de l'outil cercle (creation par eventail de triangles) —
// playwright-core.
//
// Parcours : activer le mode cercle via le bouton #circle (verif de
// l'etat actif + compteur de cotes), tracer un cercle par
// clic + glisser, verifier la scene generee (N+1 points, N triangles),
// annuler / retablir, regler le nombre de cotes a la molette, annuler
// un trace trop petit, quitter le mode par Echap.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-circle.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

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
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.length : 0,
        }
    } catch (e) {
        return { points: -1, tris: -1 }
    }
}, SCENE_STORAGE_KEY)

const circleActive = () => page.locator('#circle').evaluate((btn) => btn.classList.contains('circle-active'))
const circleText = () => page.locator('#circleText').textContent()

// Trace un cercle : mousedown (centre) -> move (rayon) -> up.
const drawCircle = async (cx, cy, rx, ry) => {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(rx, ry, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(150)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Activer le mode cercle ---
    await page.click('#circle')
    await page.waitForTimeout(120)
    check('mode cercle actif (classe circle-active)', await circleActive())
    check('compteur de cotes = 24 par defaut', (await circleText()) === '24')

    // --- 2. Tracer un cercle (centre 500,400 / rayon ~100 px) ---
    await drawCircle(500, 400, 600, 400)
    let info = await sceneInfo()
    check('cercle genere : 25 points (1 centre + 24 cotes)', info.points === 25)
    check('cercle genere : 24 triangles (eventail)', info.tris === 24)
    // Spec utilisateur : le bouton se desélectionne apres la creation.
    check('mode cercle quitte apres la creation', !(await circleActive()))
    check('compteur de cotes efface apres la creation', (await circleText()) === '')

    // --- 3. Annuler / retablir ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('undo : cercle retire (scene vide)', info.points === 0 && info.tris === 0)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('redo : cercle reconstruit', info.points === 25 && info.tris === 24)

    // --- 4. Re-activation + molette SUR LE BOUTON = nombre de cotes ---
    await page.click('#circle')
    await page.waitForTimeout(120)
    await page.locator('#circle').hover()
    await page.mouse.wheel(0, -100)  // deltaY < 0 -> +1 cote
    await page.waitForTimeout(120)
    check('molette sur le bouton : compteur passe a 25', (await circleText()) === '25')
    // Scene vide d'abord (Ctrl+Z sur le cercle precedent), puis trace.
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await drawCircle(500, 400, 600, 400)
    info = await sceneInfo()
    check('cercle a 25 cotes : 26 points', info.points === 26)
    check('cercle a 25 cotes : 25 triangles', info.tris === 25)
    check('mode cercle quitte apres la 2e creation', !(await circleActive()))

    // --- 5. Trace trop petit (clic sans glisser) : ignore, mode reste ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await page.click('#circle')
    await page.waitForTimeout(120)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('clic sans glisser : aucun cercle cree', info.points === 0 && info.tris === 0)
    check('mode toujours actif apres clic ignore', await circleActive())

    // --- 6. Echap quitte le mode ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    check('Echap : mode cercle desactive', !(await circleActive()))
    check('Echap : compteur de cotes efface', (await circleText()) === '')

    // --- 7. Re-activation : clic droit = annule le trace (le mode
    // reste actif), Echap = quitte le mode ---
    await page.click('#circle')
    await page.waitForTimeout(120)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(600, 400, { steps: 4 })
    await page.waitForTimeout(120)
    await page.mouse.click(700, 400, { button: 'right' })
    await page.waitForTimeout(120)
    check('clic droit : mode cercle toujours actif', await circleActive())
    // Le relachement gauche qui suit ne doit pas commiter de cercle
    // (le centre a ete annule).
    await page.mouse.up()
    await page.waitForTimeout(120)
    check('clic droit : aucun cercle commite au relachement', (await sceneInfo()).points === 0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    check('Echap : mode cercle desactive', !(await circleActive()))
    check('Echap : compteur de cotes efface', (await circleText()) === '')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
