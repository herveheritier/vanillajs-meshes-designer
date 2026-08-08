// Smoke test du panneau de formes prédéfinies (#shapes) — playwright-core.
//
// Parcours : ouvrir / fermer le panneau, armer chaque forme via les
// boutons du panneau, tracer en 2 clics (evolution : meme modele que
// le cercle), verifier la geometrie generee (points + triangles,
// carre a cotes egaux, triangle en un seul triangle), undo/redo,
// fermeture par Echap et clic exterieur, desarmement par Echap, trace
// trop petit ignore.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-shapes.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY, cursorOverlayState, countGreenPixelsNear } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Snapshot lisible du plan actif (compteurs + coordonnees des
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

// Geste en 2 temps (evolution « generaliser la creation des formes sur
// le modele du cercle ») : 1er clic = ancre (1er coin pour rect/carre,
// centre pour les polygones), mouvement = taille (+ orientation pour
// les polygones), 2e clic = valide. Le relachement du 1er clic ne
// cree rien.
const drawShape2Clicks = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps: 6 })
    await page.mouse.up()
    await page.mouse.down()
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

    // --- 1b. Le panneau contient aussi le cercle (deplace depuis la
    // toolbar) : choisir « Cercle » arme le mode cercle sur #shapes ---
    await page.click('#shapes')
    await page.waitForTimeout(100)
    check('panneau : bouton Cercle present',
        await page.locator('#shapesPanel button[data-shape="circle"]').isVisible())
    await page.click('#shapesPanel button[data-shape="circle"]')
    await page.waitForTimeout(120)
    check('choix Cercle : bouton #shapes arme + libellé',
        await shapesArmed() && (await shapesText()) === 'cercle 24')
    check('choix Cercle : panneau ferme', !(await panelVisible()))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    check('Echap : mode cercle desarme', !(await shapesArmed()))

    // --- 2. Rectangle : 4 points, 2 triangles, outil desarme ---
    await armShape('rect')
    check('outil arme : classe shapes-armed', await shapesArmed())
    check('outil arme : libellé rectangle', (await shapesText()) === 'rectangle')
    check('panneau ferme apres armement', !(await panelVisible()))
    await drawShape2Clicks(500, 400, 700, 550)
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
    await drawShape2Clicks(500, 400, 700, 600)  // dx=200, dy=200 -> cote = 200
    info = await sceneInfo()
    check('carre cree : 4 points', info.points === 4)
    check('carre : cotes egaux', info.pointList.length === 4 &&
        Math.abs((info.pointList[1].x - info.pointList[0].x) - (info.pointList[3].y - info.pointList[0].y)) < 0.01)

    // --- 5. Hexagone : 7 points, 6 triangles, orientation par souris
    // (le sommet 0 du polygone pointe vers le curseur, comme le
    // cercle) ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('hexa')
    await drawShape2Clicks(500, 400, 600, 400)
    info = await sceneInfo()
    check('hexagone cree : 7 points (centre + 6)', info.points === 7)
    check('hexagone cree : 6 triangles', info.tris === 6)
    // Drag horizontal : offset = 0, le sommet 0 (pointList[1]) doit
    // avoir la meme y modele que le centre (vertex 0 vers la droite).
    const hexaOrientation = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        if (pl.length < 2) return null
        return { v0y: pl[1].y, centerY: pl[0].y }
    }, SCENE_STORAGE_KEY)
    check('hexagone : sommet 0 oriente vers la souris (meme y que le centre)',
        hexaOrientation !== null && Math.abs(hexaOrientation.v0y - hexaOrientation.centerY) < 5)

    // --- 5b. Triangle : la forme est composee d'UN SEUL triangle
    // (3 sommets, pas d'eventail depuis un centre — evolution « la
    // forme triangle doit être composée d'un seul triangle au lieu
    // de trois »). Geste en 2 clics inchange, sommet 0 vers la souris.
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('tri')
    await drawShape2Clicks(500, 400, 600, 400)
    info = await sceneInfo()
    check('triangle cree : 3 points (pas de centre)', info.points === 3)
    check('triangle cree : 1 seul triangle', info.tris === 1)
    check('outil desarme apres creation du triangle', !(await shapesArmed()))
    // Drag horizontal (offset = 0) : triangle equilateral inscrit dans
    // un cercle de rayon 100 -> cotes ~173.2, et le sommet 0 (angle 0)
    // est le sommet le plus a droite (oriente vers la souris).
    const triGeo = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        if (pl.length < 3) return null
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
        return { s01: d(pl[0], pl[1]), s12: d(pl[1], pl[2]), s20: d(pl[2], pl[0]), v0x: pl[0].x, v1x: pl[1].x, v2x: pl[2].x }
    }, SCENE_STORAGE_KEY)
    check('triangle : equilateral (3 cotes egaux)',
        triGeo !== null && Math.abs(triGeo.s01 - triGeo.s12) < 0.5 && Math.abs(triGeo.s12 - triGeo.s20) < 0.5)
    check('triangle : sommet 0 oriente vers la souris (le plus a droite)',
        triGeo !== null && triGeo.v0x > triGeo.v1x && triGeo.v0x > triGeo.v2x)

    // --- 6. Etoile (mode 3 clics, evolution : meme logique que le
    // cercle + profondeur des branches au 3e clic) : 11 points, 10
    // triangles, orientation par souris (1er pic vers le curseur) et
    // profondeur reglee par la distance du 3e clic ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('star')
    check('mode etoile : bouton #shapes arme + libellé', await shapesArmed() && (await shapesText()) === 'étoile')
    check('mode etoile : panneau ferme', !(await panelVisible()))
    // Geste : 1er clic = centre (500,400) ; mouvement vers (600,400)
    // = rayon 100 px + angle (1er pic a droite) ; 2e clic = verrouille
    // rayon + angle ; mouvement vers (540,400) = profondeur des
    // branches (40/100 = ratio 0.4) ; 3e clic = valide.
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(600, 400, { steps: 4 })
    await page.mouse.up()
    await page.mouse.down()      // 2e clic : verrouille rayon + angle
    await page.mouse.up()
    await page.mouse.move(540, 400, { steps: 4 })
    await page.mouse.down()      // 3e clic : valide avec profondeur ~0.4
    await page.mouse.up()
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('etoile cree : 11 points (centre + 10 sommets)', info.points === 11)
    check('etoile cree : 10 triangles', info.tris === 10)
    check('mode etoile quitte apres la creation', !(await shapesArmed()))
    // Geometrie : 1er pic (pointList[1]) a ~1 x rayon du centre, 1er
    // sommet interieur (pointList[2]) a ~0.4 x rayon (profondeur du
    // 3e clic), et pic 0 sur la meme ligne que le centre (rayon
    // horizontal vers la droite = orientation par souris).
    const starGeo = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        if (pl.length < 3) return null
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
        return { outer: d(pl[1], pl[0]), inner: d(pl[2], pl[0]), outerY: pl[1].y, centerY: pl[0].y }
    }, SCENE_STORAGE_KEY)
    check('etoile : profondeur des branches ~0.4 (3e clic)',
        starGeo !== null && Math.abs(starGeo.inner / starGeo.outer - 0.4) < 0.15)
    check('etoile : 1er pic oriente vers la souris (meme y que le centre)',
        starGeo !== null && Math.abs(starGeo.outerY - starGeo.centerY) < 5)

    // --- 6b. Anneau (cercle perçé d'un trou, mode 3 clics, evolution
    // « création d'un cercle percé d'un trou ») : 48 points (2x24
    // cotes), 48 triangles, trou regle par la distance du 3e clic,
    // orientation par souris (sommet exterieur 0 vers le curseur) ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await armShape('annulus')
    check('mode anneau : bouton #shapes arme + libellé', await shapesArmed() && (await shapesText()) === 'anneau 24')
    check('mode anneau : panneau ferme', !(await panelVisible()))
    // Geste : 1er clic = centre (500,400) ; mouvement vers (600,400)
    // = rayon externe 100 px + angle (sommet 0 a droite) ; 2e clic =
    // verrouille rayon externe + angle ; mouvement vers (560,400) =
    // taille du trou (60/100 = ratio 0.6) ; 3e clic = valide.
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(600, 400, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    // (fix regression) la preview doit suivre le mousemove AVANT le
    // 2e clic. Sans la branche annulusMode dans resolveMouseMoveOnBoard,
    // le geste ne se deroulait pas visuellement (preview figee a rayon
    // 0 jusqu'au 2e/3e clic). Points d'echantillonnage HORS des axes
    // (l'axe X, COLOR_AXIS = #00A000, est lui-meme vert et passerait
    // le predicat a y=400 — faux positif) : sommet de la couronne
    // exterieure a 90° (500,300) et sommet du trou (ratio par defaut
    // 0.5) a 90° (500,350), tous deux dessines en vert
    // COLOR_CIRCLE_PREVIEW pendant le geste.
    check('anneau : preview rayon externe visible pendant le geste (pixels verts sur la couronne)',
        (await countGreenPixelsNear(page, 500, 300)) > 0)
    check('anneau : preview du trou visible pendant le geste (pixels verts au rayon interne)',
        (await countGreenPixelsNear(page, 500, 350)) > 0)
    await page.mouse.down()      // 2e clic : verrouille rayon externe + angle
    await page.mouse.up()
    await page.mouse.move(560, 400, { steps: 4 })
    await page.mouse.down()      // 3e clic : valide avec trou ~0.6
    await page.mouse.up()
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('anneau cree : 48 points (2x24 cotes)', info.points === 48)
    check('anneau cree : 48 triangles (2 par cote)', info.tris === 48)
    check('mode anneau quitte apres la creation', !(await shapesArmed()))
    // Geometrie : sommet exterieur 0 (pointList[0]) et sommet
    // interieur 0 (pointList[24]) partagent l'angle 0 (meme y, ligne
    // horizontale vers la droite = orientation par souris) ; le trou
    // mesure 100 - 60 = 40 (ratio 0.6 du 3e clic).
    const annGeo = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        if (pl.length < 25) return null
        return { gap: Math.abs(pl[0].x - pl[24].x), y0: pl[0].y, y24: pl[24].y }
    }, SCENE_STORAGE_KEY)
    check('anneau : trou ~0.6 du rayon externe (ecart radial ~40)',
        annGeo !== null && Math.abs(annGeo.gap - 40) < 2)
    check('anneau : sommet exterieur 0 oriente vers la souris (meme y que l\'interieur)',
        annGeo !== null && Math.abs(annGeo.y0 - annGeo.y24) < 5)

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
    // (evolution pointeur) : meme sans mouvement apres le 1er clic, la
    // croix blanche doit rester visible — le curseur est un overlay DOM
    // (#cursorOverlay) suivi par le mousemove (draw.js moveCursorOverlay) :
    // il ne vit plus dans le canvas, donc aucun repaint ne peut plus
    // l'effacer (renderTransient ne le peint plus). On verifie que
    // l'overlay est visible et centre sur la position du clic.
    const curs = await cursorOverlayState(page)
    check('pointeur visible apres le 1er clic forme sans mouvement (overlay DOM centre sur le clic)',
        curs !== null && curs.visible && Math.abs(curs.x - 500) <= 2 && Math.abs(curs.y - 400) <= 2)
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
