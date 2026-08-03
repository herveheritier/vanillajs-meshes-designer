// Smoke test du panneau de formes prédéfinies (#shapes) — playwright-core.
//
// Parcours : ouvrir / fermer le panneau, armer chaque forme via les
// boutons du panneau, tracer par clic + glisser, verifier la geometrie
// generee (points + triangles, carre a cotes egaux), undo/redo,
// fermeture par Echap et clic exterieur, desarmement par Echap, trace
// trop petit ignore.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-shapes.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Snapshot lisible de la forme active (compteurs + coordonnees des
// points pour le test du carre).
const sceneInfo = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.length : 0,
            pointList: Array.isArray(shape.pointList) ? shape.pointList.map(p => ({ x: p.x, y: p.y })) : [],
        }
    } catch (e) {
        return { points: -1, tris: -1, pointList: [] }
    }
}, SCENE_STORAGE_KEY)

const panelVisible = () => page.locator('#shapesPanel').isVisible()
const shapesArmed = () => page.locator('#shapes').evaluate((btn) => btn.classList.contains('shapes-armed'))
const shapesText = () => page.locator('#shapesText').textContent()

// Ouvre le panneau puis clique le bouton de forme `kind` (data-shape).
const armShape = async (kind) => {
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.click(`#shapesPanel button[data-shape="${kind}"]`)
    await page.waitForTimeout(100)
}

const drawDrag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(150)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Panneau : ouverture / fermeture par le bouton ---
    await page.click('#shapes')
    await page.waitForTimeout(100)
    check('panneau ouvert au clic sur #shapes', await panelVisible())
    await page.click('#shapes')
    await page.waitForTimeout(100)
    check('panneau ferme au 2e clic', !(await panelVisible()))

    // --- 2. Rectangle : 4 points, 2 triangles, outil desarme ---
    await armShape('rect')
    check('outil arme : classe shapes-armed', await shapesArmed())
    check('outil arme : libellé rectangle', (await shapesText()) === 'rectangle')
    check('panneau ferme apres armement', !(await panelVisible()))
    await drawDrag(500, 400, 700, 550)
    let info = await sceneInfo()
    check('rectangle cree : 4 points', info.points === 4)
    check('rectangle cree : 2 triangles', info.tris === 2)
    check('outil desarme apres creation', !(await shapesArmed()))

    // --- 3. Undo / redo ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('undo : rectangle retire', info.points === 0 && info.tris === 0)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('redo : rectangle reconstruit', info.points === 4 && info.tris === 2)

    // --- 4. Carre : cotes egaux ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('square')
    await drawDrag(500, 400, 700, 600)  // dx=200, dy=200 -> cote = 200
    info = await sceneInfo()
    check('carre cree : 4 points', info.points === 4)
    check('carre : cotes egaux', info.pointList.length === 4 &&
        Math.abs((info.pointList[1].x - info.pointList[0].x) - (info.pointList[3].y - info.pointList[0].y)) < 0.01)

    // --- 5. Hexagone : 7 points, 6 triangles ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('hexa')
    await drawDrag(500, 400, 600, 400)
    info = await sceneInfo()
    check('hexagone cree : 7 points (centre + 6)', info.points === 7)
    check('hexagone cree : 6 triangles', info.tris === 6)

    // --- 6. Etoile : 11 points, 10 triangles ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('star')
    await drawDrag(500, 400, 600, 400)
    info = await sceneInfo()
    check('etoile cree : 11 points (centre + 10 sommets)', info.points === 11)
    check('etoile cree : 10 triangles', info.tris === 10)

    // --- 7. Echap : ferme le panneau / desarme l'outil ---
    await page.click('#shapes')
    await page.waitForTimeout(100)
    check('panneau ouvert (test Echap)', await panelVisible())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    check('Echap : panneau ferme', !(await panelVisible()))
    await armShape('tri')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    check('Echap : outil desarme sans creer', !(await shapesArmed()))

    // --- 8. Clic exterieur ferme le panneau (le clic canvas ajoute un
    // point, comportement normal de l'edition — annule ensuite) ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)  // scene vide (retire l'etoile)
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.mouse.click(900, 700)
    await page.waitForTimeout(100)
    check('clic exterieur : panneau ferme', !(await panelVisible()))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)  // retire le point accidentel du clic

    // --- 9. Trace trop petit ignore (outil reste arme) ---
    await armShape('tri')
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('clic sans glisser : aucune forme creee', info.points === 0 && info.tris === 0)
    check('outil toujours arme apres clic ignore', await shapesArmed())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)

    // --- 10. Clamp aux bords de la fenetre : le panneau doit rester
    // entierement visible meme quand le bouton #shapes est colle au
    // bord droit ou bas du viewport (regression : le positionnement
    // brut a rect.left / rect.bottom le faisait deborder).
    // On decale le bouton en position fixed pres du bord, on ouvre le
    // panneau, on verifie ses bounds, puis on restaure le style.
    await page.evaluate(() => {
        window.__shapesBtnStyle = document.querySelector('#shapes').getAttribute('style') || ''
        const btn = document.querySelector('#shapes')
        btn.style.position = 'fixed'
        btn.style.top = '120px'
        btn.style.left = (window.innerWidth - 70) + 'px'
    })
    await page.click('#shapes')
    await page.waitForTimeout(100)
    const rightClamp = await page.evaluate(() => {
        const p = document.querySelector('#shapesPanel').getBoundingClientRect()
        return { left: p.left, right: p.right, vw: window.innerWidth }
    })
    check('bord droit : panneau entierement dans la fenetre',
        rightClamp.left >= 0 && rightClamp.right <= rightClamp.vw)
    check('bord droit : panneau redecale (clamp effectif)',
        rightClamp.right <= rightClamp.vw - 4)
    await page.click('#shapes')
    await page.waitForTimeout(100)

    await page.evaluate(() => {
        const btn = document.querySelector('#shapes')
        btn.style.position = 'fixed'
        btn.style.top = (window.innerHeight - 60) + 'px'
        btn.style.left = '120px'
    })
    await page.click('#shapes')
    await page.waitForTimeout(100)
    const bottomClamp = await page.evaluate(() => {
        const p = document.querySelector('#shapesPanel').getBoundingClientRect()
        return { top: p.top, bottom: p.bottom, vh: window.innerHeight }
    })
    check('bord bas : panneau entierement dans la fenetre',
        bottomClamp.top >= 0 && bottomClamp.bottom <= bottomClamp.vh)
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.evaluate(() => {
        document.querySelector('#shapes').setAttribute('style', window.__shapesBtnStyle || '')
        delete window.__shapesBtnStyle
    })

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
