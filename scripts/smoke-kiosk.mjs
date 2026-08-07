// Smoke test du kiosque de sélection des plans (#kiosk, Alt+K) — playwright-core.
//
// Parcours : charger une scène de 3 plans (autoimport), vérifier que
// le bouton #kiosk est actif (et grisé avec un seul plan), ouvrir le
// kiosque (bouton puis Alt+K), vérifier le masquage body.kiosk-mode +
// le toast guide, puis :
//   - Échap : sortie sans changement du plan actif ;
//   - clic à droite des cartes : sélectionne le dernier plan et sort ;
//   - clic à gauche des cartes : sélectionne le 1er plan et sort ;
//   - chevauchement (9 plans) : le clic dans la zone de recouvrement
//     sélectionne le plan MIS EN AVANT (le focus), pas le voisin caché
//     dont le centre est le plus proche ;
//   - marge gauche (9 plans) : le pointeur n'est au-dessus d'AUCUNE
//     carte, le clic sélectionne quand même le plan mis en avant — règle
//     « clic = focus » (même règle linéaire que l'affichage, cf.
//     DESIGN.md §7.16) : jamais un plan précédent/suivant.
// Avec 3 plans, les cartes sont en 3 colonnes (spacing 0.4 × largeur) :
// centres à 0.1 / 0.5 / 0.9 de la largeur du board.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-kiosk.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// 3 plans : triangles de 3 points, premier point à x = 0 / 20 / 40
// (même fixture que smoke-shapeorder, lisible dans le localStorage).
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n40,0;50,0;45,8.66\n'
const MESHES_TEXT_ONE = '0,0;10,0;5,8.66\n'
// 9 plans serrés (spacing ~0.11 × largeur) : les cartes se chevauchent.
const MESHES_TEXT_NINE = Array.from(
    { length: 9 },
    (_, i) => `${i * 20},0;${i * 20 + 10},0;${i * 20 + 5},8.66`
).join('\n') + '\n'

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

const label = () => page.locator('#shapeLabel').textContent()
const kioskModeClass = () => page.evaluate(() => document.body.classList.contains('kiosk-mode'))
const kioskActiveClass = () => page.evaluate(() => document.querySelector('#kiosk')?.classList.contains('kiosk-active') || false)
const boardRect = () => page.evaluate(() => {
    const r = document.querySelector('#board').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const commentVisible = async () => {
    const el = await page.evaluate(() => {
        const c = document.querySelector('#actionComment')
        return c ? { visible: c.classList.contains('action-comment-visible'), text: c.textContent } : null
    })
    return el && el.visible && el.text && el.text.includes('Survolez les plans')
}

try {
    const url = BASE_URL + '?autoimport=' + Buffer.from(MESHES_TEXT, 'utf8').toString('base64url')
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    await page.waitForFunction(() => document.querySelector('#shapeLabel')?.textContent === '1/3', null, { timeout: 8000 })

    // --- 1. Bouton actif avec 3 plans ---
    check('3 plans chargés (1/3)', (await label()) === '1/3')
    check('#kiosk actif avec 3 plans', !(await page.locator('#kiosk').isDisabled()))

    // --- 2. Ouverture par le bouton : chrome masquée + toast guide ---
    await page.click('#kiosk')
    await page.waitForTimeout(150)
    check('ouverture bouton : body.kiosk-mode posé', await kioskModeClass())
    check('ouverture bouton : #kiosk.kiosk-active', await kioskActiveClass())
    check('toast guide visible (« Survolez les plans »)', await commentVisible())

    // --- 3. Échap : sortie sans changement du plan actif ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Échap : kiosk-mode retiré', !(await kioskModeClass()))
    check('Échap : plan actif inchangé (1/3)', (await label()) === '1/3')

    // --- 4. Alt+K ouvre le kiosque ---
    await page.keyboard.press('Alt+k')
    await page.waitForTimeout(150)
    check('Alt+K : kiosk-mode posé', await kioskModeClass())

    // --- 5. Clic à droite : sélectionne le dernier plan et sort ---
    const rect = await boardRect()
    const rightX = rect.x + rect.w * 0.85
    const midY = rect.y + rect.h * 0.5
    await page.mouse.move(rightX, midY)
    await page.waitForTimeout(200)
    await page.mouse.click(rightX, midY)
    await page.waitForTimeout(200)
    check('clic droite : plan 3/3 sélectionné', (await label()) === '3/3')
    check('clic droite : kiosque refermé', !(await kioskModeClass()))

    // --- 6. Rouverte + clic à gauche : plan 1 ---
    await page.keyboard.press('Alt+k')
    await page.waitForTimeout(150)
    const leftX = rect.x + rect.w * 0.15
    await page.mouse.move(leftX, midY)
    await page.waitForTimeout(200)
    await page.mouse.click(leftX, midY)
    await page.waitForTimeout(200)
    check('clic gauche : plan 1/3 sélectionné', (await label()) === '1/3')
    check('clic gauche : kiosque refermé', !(await kioskModeClass()))

    // --- 7. Alt+K referme aussi ---
    await page.keyboard.press('Alt+k')
    await page.waitForTimeout(150)
    check('Alt+K : kiosk-mode posé (2e fois)', await kioskModeClass())
    await page.keyboard.press('Alt+k')
    await page.waitForTimeout(150)
    check('Alt+K : kiosk-mode retiré', !(await kioskModeClass()))

    // --- 8. Chevauchement (9 plans) : le plan mis en avant gagne ---
    // Pointeur à 0.375 × largeur (= 480 px à 1280) : focus = 3.0 → le
    // plan 4 est mis en avant (centré à w/2), sa carte recouvre
    // partiellement celle du plan 3. Le clic doit sélectionner le plan 4
    // (le focus), pas le plan 3 (voisin caché au centre plus proche).
    const page3 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors3 = attachErrorCollector(page3)
    const urlNine = BASE_URL + '?autoimport=' + Buffer.from(MESHES_TEXT_NINE, 'utf8').toString('base64url')
    await page3.goto(urlNine, { waitUntil: 'networkidle' })
    await page3.waitForSelector('#board')
    await page3.waitForTimeout(400)
    await page3.waitForFunction(() => document.querySelector('#shapeLabel')?.textContent === '1/9', null, { timeout: 8000 })
    check('9 plans chargés (1/9)', (await page3.locator('#shapeLabel').textContent()) === '1/9')
    await page3.keyboard.press('Alt+k')
    await page3.waitForTimeout(150)
    const rect9 = await page3.evaluate(() => {
        const r = document.querySelector('#board').getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    const overlapX = rect9.x + rect9.w * 0.375
    const midY9 = rect9.y + rect9.h * 0.5
    await page3.mouse.move(overlapX, midY9)
    await page3.waitForTimeout(200)
    await page3.mouse.click(overlapX, midY9)
    await page3.waitForTimeout(200)
    check('clic chevauchement : plan du dessus sélectionné (4/9)', (await page3.locator('#shapeLabel').textContent()) === '4/9')
    check('clic chevauchement : kiosque refermé', !(await page3.evaluate(() => document.body.classList.contains('kiosk-mode'))))
    check('chevauchement : aucune erreur JS', errors3.length === 0)

    // --- 8b. Marge gauche (9 plans) : le clic sélectionne le focus ---
    // Pointeur/clic à 0.09 × largeur (= 115 px à 1280) : focus = 0.72 →
    // le plan 2 est mis en avant (centré à mi-écran) mais AUCUNE carte
    // n'est sous le pointeur (marge). Le clic doit sélectionner le plan
    // 2 (le mis en avant) — jamais le plan 1 : l'ancien hit-test
    // retombait sur le plan au centre le plus proche (plan précédent).
    await page3.keyboard.press('Alt+k')
    await page3.waitForTimeout(150)
    const leftMarginX = rect9.x + rect9.w * 0.09
    await page3.mouse.move(leftMarginX, midY9)
    await page3.waitForTimeout(200)
    await page3.mouse.click(leftMarginX, midY9)
    await page3.waitForTimeout(200)
    check('clic marge gauche : plan mis en avant sélectionné (2/9)', (await page3.locator('#shapeLabel').textContent()) === '2/9')
    check('clic marge gauche : kiosque refermé', !(await page3.evaluate(() => document.body.classList.contains('kiosk-mode'))))
    await page3.close()

    // --- 9. Bouton grisé avec un seul plan ---
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors2 = attachErrorCollector(page2)
    const urlOne = BASE_URL + '?autoimport=' + Buffer.from(MESHES_TEXT_ONE, 'utf8').toString('base64url')
    await page2.goto(urlOne, { waitUntil: 'networkidle' })
    await page2.waitForSelector('#board')
    await page2.waitForTimeout(400)
    check('contexte 1 plan : #kiosk grisé', await page2.locator('#kiosk').isDisabled())
    check('contexte 1 plan : aucune erreur JS', errors2.length === 0)
    await page2.close()

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
    if (errors3.length) console.error('ERREURS JS (9 plans):\n' + errors3.join('\n'))
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
