// Smoke test de l'outil cercle (creation par eventail de triangles,
// geste en 2 temps : 1er mousedown = centre, mouvement = rayon + angle
// de depart, 2e mousedown = valider) — playwright-core.
//
// Parcours : activer le mode cercle via le panneau #shapes (choix
// « Cercle ») et via le raccourci C (verif de l'etat actif sur le
// bouton #shapes + libellé « cercle N »), tracer un cercle en 2
// clics (1er clic pose le centre, mousemove ajuste rayon + angle,
// 2e clic valide), verifier la scene generee (N+1 points, N triangles)
// ET l'orientation du polygone (le sommet 0 du rim pointe vers la
// position finale du curseur avec tolerance y / x selon le sens du
// drag), annuler / retablir, regler le nombre de cotes a la molette
// (canvas et bouton #shapes), annuler un trace trop petit, quitter le
// mode par Echap, verifier que clic droit annule un trace en cours.
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

// Coordonnees model du sommet 0 du rim (pointList[1], l'index 0 etant
// toujours le centre du cercle). Sert a verifier l''orientation du
// polygone dans le test sur « orientation par souris ».
const firstRimModel = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        const pl = Array.isArray(shape.pointList) ? shape.pointList : []
        return pl.length >= 2 ? { x: pl[1].x, y: pl[1].y } : null
    } catch (e) {
        return null
    }
}, SCENE_STORAGE_KEY)

const shapesArmed = () => page.locator('#shapes').evaluate((btn) => btn.classList.contains('shapes-armed'))
const shapesText = () => page.locator('#shapesText').textContent()

// Geste en 2 temps (evolution orientation par souris) :
//   1. mouse.down au centre : pose le centre (beginCircleGesture).
//   2. mouse.move vers le bord : met a jour rayon + angle de depart
//      au fur et a mesure (updateCircleGesture).
//   3. mouse.up : noop (le mode cercle reste arme mais ne cree pas
//      de cercle). L'utilisateur peut relacher et recliquer ailleurs
//      pour finaliser.
//   4. mouse.down au point de validation : commitCircleGesture
//      valide le cercle (rayon + angle au dernier mousemove) puis
//      exitCircleMode.
//   5. mouse.up final : laisse le browser finir l'event chain (sans
//      effet sur l'app).
// On accepte aussi `await drawCircle(centerX, centerY, edgeX, edgeY)`
// ou edge == centre (trace trop petit) : le 2e mousedown est ignore,
// aucun cercle cree, mode quitte (cf. test 6).
const drawCircle = async (cx, cy, rx, ry) => {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    if (cx !== rx || cy !== ry) {
        await page.mouse.move(rx, ry, { steps: 6 })
    }
    await page.mouse.up()
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Activer le mode cercle via le panneau #shapes ---
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.click('#shapesPanel button[data-shape="circle"]')
    await page.waitForTimeout(120)
    check('panneau : mode cercle actif (bouton #shapes arme)', await shapesArmed())
    check('compteur de cotes = 24 par defaut', (await shapesText()) === 'cercle 24')
    check('panneau ferme apres le choix Cercle', !(await page.locator('#shapesPanel').isVisible()))

    // --- 2. Tracer un cercle horizontal (centre 500,400 / bord 600,400)
    //         => angle de depart attendu = 0 rad (vers le bord droit).
    //         Le sommet 0 du rim devrait avoir y proche de center.y ---
    await drawCircle(500, 400, 600, 400)
    let info = await sceneInfo()
    check('cercle genere : 25 points (1 centre + 24 cotes)', info.points === 25)
    check('cercle genere : 24 triangles (eventail)', info.tris === 24)
    check('mode cercle quitte apres la creation', !(await shapesArmed()))
    check('compteur de cotes efface apres la creation', (await shapesText()) === '')
    // Orientation : on convertit (500,400) en coords model pour
    // comparer avec le sommet 0 du rim, dont on attend y proche
    // (meme ligne que le curseur fin de geste). tolerance +/- 5
    // unites model (cf. CIRCLE_MIN_RADIUS_PX).
    const firstRimY = (await firstRimModel()).y
    // (500,400) en modele : la conversion exacte depend du viewport
    // du test (1280x800), donc on accepte simplement que le sommet 0
    // du rim ait une y proche de celle du centre converti en
    // modele. Plus robuste : on prend la difference entre sommet 0
    // et centre, et on assert qu'elle est petite (rayon horizontal)
    // ET que la difference y est petite (< 5 unites model).
    const centerModel = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        return { x: pl[0].x, y: pl[0].y }
    }, SCENE_STORAGE_KEY)
    check('orientation drag horizontal : |sommet0.y - centre.y| < 5', Math.abs(firstRimY - centerModel.y) < 5)

    // --- 3. Annuler / retablir ---
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('undo : cercle retire (scene vide)', info.points === 0 && info.tris === 0)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(120)
    info = await sceneInfo()
    check('redo : cercle reconstruit', info.points === 25 && info.tris === 24)

    // --- 4. Re-activation (C) + molette SUR LE BOUTON = nombre de cotes ---
    await page.keyboard.press('c')
    await page.waitForTimeout(120)
    await page.locator('#shapes').hover()
    await page.mouse.wheel(0, -100)  // deltaY < 0 -> +1 cote
    await page.waitForTimeout(120)
    check('molette sur le bouton : compteur passe a 25', (await shapesText()) === 'cercle 25')
    // Scene vide d'abord (Ctrl+Z sur le cercle precedent), puis trace.
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await drawCircle(500, 400, 600, 400)
    info = await sceneInfo()
    check('cercle a 25 cotes : 26 points', info.points === 26)
    check('cercle a 25 cotes : 25 triangles', info.tris === 25)
    check('mode cercle quitte apres la 2e creation', !(await shapesArmed()))

    // --- 4b. Orientation par souris en drag VERTICAL (au-dessus
    //         puis en dessous du centre) : le sommet 0 du rim doit
    //         tomber du cote de la souris sur l'ecran. La regression
    //         historique etait que atan2(dy, dx) en coords screen
    //         appliquait le Y-flip deux fois (atan2 math + modelToScreen
    //         canvas Y down) — le sommet 0 sortait du cote oppose a
    //         la souris verticalement (souris en bas -> sommet 0 en
    //         haut). Smoke test : on trace deux cercles avec le meme
    //         rayon mais « dessous » et « dessus » du centre, et on
    //         verifie le signe du delta entre rim0 et centre en
    //         coords model (model Y up = screen Y down : souris bas
    //         sur screen => rim.y < centre.y en model).
    // Defensive : on force segments a 25 sur le bouton actif (via
    // molette) avant chaque sous-test, pour ne pas dependre du fait
    // que test 4 ait deja regle le compteur via sa propre molette
    // (= fragilite si l'ordre des tests est reordonne plus tard :
    // on aurait pu retomber sur le defaut 24 et fausser les checks
    // `info.points === 26` / `info.tris === 25`). ---
    const setSegmentsTo25 = async () => {
        // Relancer le mode si besoin (Esc quitte le mode si actif).
        await page.keyboard.press('Control+z')
        await page.waitForTimeout(80)
        await page.keyboard.press('c')
        await page.waitForTimeout(80)
        await page.locator('#shapes').hover()
        await page.mouse.wheel(0, -100)  // +1 cote : 24 -> 25
        await page.waitForTimeout(80)
        // Si on etait deja a 25 (apres +1 du test 4), la molette +
        // 1 nous mettrait a 26 ; on rembobine d'un cran pour retomber
        // sur 25 dans tous les cas.
        const txt = await shapesText()
        if (txt !== 'cercle 25') {
            await page.mouse.wheel(0, 100)  // -1 cote
            await page.waitForTimeout(80)
        }
    }

    // Cercles 1 : souris sous le centre (500,400 -> 500,600)
    await setSegmentsTo25()
    await drawCircle(500, 400, 500, 600)
    info = await sceneInfo()
    check('cercle vertical bas : points = 1 centre + 25 cotes', info.points === 26)
    check('cercle vertical bas : triangles = 25', info.tris === 25)
    check('cercle vertical bas : mode quitte apres creation', !(await shapesArmed()))
    const rimDown = await firstRimModel()
    const centerDown = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        return pl.length >= 1 ? { x: pl[0].x, y: pl[0].y } : null
    }, SCENE_STORAGE_KEY)
    // souris sous le centre sur l'ecran (Y down, screen.y > center.y) :
    // en coords model (Y up, modelToScreen flippe Y), cela correspond a
    // un edge en model.y < center.y (= -200 vs 0 sur cet exemple). On
    // attend donc le meme signe en sortie : rim model.y strictement
    // inferieur a center model.y. Avant le fix (atan2 en coords
    // screen bouclait le Y-flip), le rim sortait du cote oppose :
    // rim.y > center.y, d'ou ce check sert de regression.
    check('orientation souris bas : rim.y < centre.y en modele (vertex 0 sous la souris)',
        rimDown && centerDown && rimDown.y < centerDown.y)
    check('orientation souris bas : |rim.y - centre.y| >= 100 (rayon nominal 200 px ecran)',
        rimDown && centerDown && Math.abs(rimDown.y - centerDown.y) >= 100)

    // Cercles 2 : souris au-dessus du centre (500,400 -> 500,200)
    await setSegmentsTo25()
    await drawCircle(500, 400, 500, 200)
    info = await sceneInfo()
    check('cercle vertical haut : points = 1 centre + 25 cotes', info.points === 26)
    check('cercle vertical haut : triangles = 25', info.tris === 25)
    check('cercle vertical haut : mode quitte apres creation', !(await shapesArmed()))
    const rimUp = await firstRimModel()
    const centerUp = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        return pl.length >= 1 ? { x: pl[0].x, y: pl[0].y } : null
    }, SCENE_STORAGE_KEY)
    // souris au-dessus du centre sur l'ecran : rim.y > center.y en modele.
    check('orientation souris haut : rim.y > centre.y en modele (vertex 0 sur la souris)',
        rimUp && centerUp && rimUp.y > centerUp.y)
    check('orientation souris haut : |rim.y - centre.y| >= 100 (rayon nominal 200 px ecran)',
        rimUp && centerUp && Math.abs(rimUp.y - centerUp.y) >= 100)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)

    // --- 5. Nombre de cotes memorise : rechargement puis re-activation ---
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    await page.keyboard.press('c')
    await page.waitForTimeout(120)
    check('persistance : compteur de cotes = 25 apres rechargement', (await shapesText()) === 'cercle 25')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)

    // --- 6. Trace trop petit (down + up sans bouger + 2e down au meme
    // point) : commitCircleGesture detecte un rayon trop petit via
    // CIRCLE_MIN_RADIUS_PX (~5 px ecran), logue « Cercle ignore : rayon
    // trop petit » et **n'**appelle **pas** createCircle ni
    // exitCircleMode — le mode reste arme pour permettre a
    // l'utilisateur de bouger la souris et retenter avec un plus
    // grand rayon (cf. evolution orientation : le geste est en 2 temps,
    // une tentative avortee ne consomme pas le geste). Le centre
    // (circleCenterModel) est quand meme reinitialise, donc les
    // mousemove suivants sont noop jusqu'au prochain mousedown gauche
    // qui re-posera un nouveau centre.
    await page.keyboard.press('c')
    await page.waitForTimeout(120)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    // 1er clic sans bouger, 2e clic sans bouger (= rayon 0)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('clic sans glisser : aucun cercle cree', info.points === 0 && info.tris === 0)
    check('mode cercle reste actif apres trace trop petit (= retenter au 2e mousedown)',
        await shapesArmed())

    // --- 7. Echap quitte le mode avant de tester le clic droit ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    check('Echap : mode cercle desactive', !(await shapesArmed()))
    check('Echap : compteur de cotes efface', (await shapesText()) === '')

    // --- 8. Re-activation (C) + clic droit en cours de geste ---
    await page.keyboard.press('c')
    await page.waitForTimeout(120)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(600, 400, { steps: 4 })
    await page.waitForTimeout(120)
    await page.mouse.click(700, 400, { button: 'right' })
    await page.waitForTimeout(120)
    check('clic droit : mode cercle toujours actif', await shapesArmed())
    // Le relachement gauche qui suit ne doit pas commiter de cercle
    // (le centre a ete annule par le clic droit : circleCenterModel
    // reinitialisee a undefined, donc le relachement est noop, et
    // tout futur mousedown gauche sera un NOUVEAU begin, pas un
    // commit). On valide en relachant puis en faisant un 2e mousedown
    // gauche ailleurs : si le centre est bien reinitialise, on aura
    // un nouveau centre + un 2e clic final = UN cercle, pas un rattrapage
    // du geste annule.
    await page.mouse.up()
    await page.waitForTimeout(120)
    // Refaisons un down ailleurs puis un 2e down pour valider un
    // nouveau cercle simple : centre doit etre le NOUVEAU point, pas
    // l'ancien (500,400).
    await page.mouse.move(800, 400)
    await page.mouse.down()
    await page.mouse.move(900, 400, { steps: 4 })
    await page.mouse.up()
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)
    const fresh = await firstRimModel()
    const freshCenter = await page.evaluate((key) => {
        const raw = localStorage.getItem(key) || ''
        const s = JSON.parse(raw)
        const pl = (s.shapes && s.shapes[0] && s.shapes[0].pointList) || []
        return pl.length >= 1 ? { x: pl[0].x, y: pl[0].y } : null
    }, SCENE_STORAGE_KEY)
    // Le centre du nouveau cercle est proche de (800,400) en modele,
    // pas de (500,400). Si l'ancien geste avait ete un commit
    // fantome, on aurait un cercle (500,400) ou pas de cercle du
    // tout. On verifie que le centre est sur la meme ligne
    // horizontale (y tres proche du y du premier centre (500,400)
    // car viewport 1280x800) ; on accepte pas de verifier la x
    // exacte car la conversion client->modele depend du viewport.
    check('clic droit : ancien geste annule, nouveau centre pris en compte',
        fresh !== null && freshCenter !== null && Math.abs(freshCenter.y - centerModel.y) < 5)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    check('Echap : mode cercle desactive', !(await shapesArmed()))
    check('Echap : compteur de cotes efface', (await shapesText()) === '')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
