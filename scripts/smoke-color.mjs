// Smoke test : la suppression d'un sommet, d'un segment ou d'un
// triangle ne doit pas effacer la couleur (fill) des triangles
// survivants — playwright-core.
//
// Parcours : creer un rectangle (2 triangles) via le panneau #shapes,
// ouvrir le panneau #triangleColor (sans selection requise,
// evolution peinture), choisir le 2e swatch (orange FB8C00,
// distinct du 1er preset actif a l'ouverture) puis cliquer dans le
// triangle 0 pour le peindre. Pour chacun des 3 modes de suppression
// (sommet / segment / triangle), supprimer un element appartenant
// au triangle 1 (non colore) et verifier que le triangle 0 survit
// avec son fill. Un undo (Ctrl+Z) restaure le rectangle colore entre
// chaque scenario. Le panneau est ferme avant la phase de
// suppression pour ne pas detourner le clic gauche de selection
// vers paintTriangleAtCursor (cf. branche brushMode dans le
// mousedown handler global de main.js).
//
// Geometrie du rectangle (500,400) -> (700,550) en coords client.
// L'axe Y est INVERSE (modelToScreen flippe Y, DESIGN §2.1) : le
// modele de (500,400) est (-134.6, -3) et celui de (700,550) est
// (65.4, -153). Points (client -> modele) :
//   p0=(500,550)->(-134.6,-153)  p1=(700,550)->(65.4,-153)
//   p2=(700,400)->(65.4,-3)      p3=(500,400)->(-134.6,-3)
//   tri 0 = {0,1,2}  (triangle droit/bas)   tri 1 = {0,2,3} (gauche/haut)
//   diagonale partagee 0-2 : de (500,550) a (700,400).
// Le centre du rectangle (600,475) tombe EXACTEMENT sur la diagonale
// (ambigu entre les 2 tris) : on clique donc nettement A L'INTERIEUR
// d'un tri pour cibler de facon deterministe.
//   peindre tri 0 : clic (660,500)      (sous la diagonale, cote tri 0)
//   supprimer tri 1 : clic (567,450)    (au-dessus de la diagonale)
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-color.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// 2e preset du panneau de couleurs (TRIANGLE_COLOR_PRESETS[1], orange).
const COLORED_FILL = 'rgba(251, 140, 0, 0.45)'

// Snapshot lisible de la forme active (points + tris avec fill) depuis
// le localStorage de la page. Scene absente (= raw vide) => scene
// vide, pas un parseError (points -1).
const sceneInfo = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    if (!raw) return { points: 0, tris: [] }
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris)
                ? shape.tris.map(t => ({ p1: t.p1, p2: t.p2, p3: t.p3, fill: t.fill }))
                : [],
        }
    } catch (e) {
        return { points: -1, tris: [] }
    }
}, SCENE_STORAGE_KEY)

// Cycle le mode de selection de n crans (SELECTION_MODES =
// vertex -> segment -> triangle).
const cycleMode = async (n) => {
    for (let i = 0; i < n; i++) {
        await page.click('#selectionMode')
        await page.waitForTimeout(60)
    }
}

// Rectangle 2 coins (500,400) -> (700,550) via le panneau #shapes.
const createRect = async () => {
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.click('#shapesPanel button[data-shape="rect"]')
    await page.waitForTimeout(100)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(700, 550, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(150)
}

// (evolution peinture) Le panneau #triangleColor peut s'ouvrir sans
// selection ni mode triangle : le bouton n'est plus jamais disabled.
// A l'ouverture, le 1er preset est arme (swatch actif, brushMode =
// true, brushColor = preset[0].fill). Pour ce test on choisit
// explicitement le 2e preset (orange, distinct du rouge par defaut)
// pour verifier que le clic swatch met bien a jour brushColor et
// bascule le swatch actif. On peint ensuite tri 0 au clic gauche
// (le mousedown handler global aiguille vers paintTriangleAtCursor
// grace a brushMode). Le panneau est referme en sortie pour que les
// etapes suivantes (suppressions en mode vertex / segment /
// triangle) fonctionnent normalement : sinon le clic gauche de
// selection serait detourne vers le pinceau.
const colorTri0 = async () => {
    await page.click('#triangleColor')
    await page.waitForTimeout(100)
    check('panneau de couleurs ouvert', await page.locator('#triangleColorPanel').isVisible())

    // Bouton en etat "panel ouvert + pinceau arme" (les 2 classes
    // CSS attendues par updateColorButtonState).
    const btnClasses = await page.locator('#triangleColor').evaluate(el => el.className)
    check('bouton peinture en etat color-panel-open', /\bcolor-panel-open\b/.test(btnClasses))
    check('bouton peinture en etat color-active', /\bcolor-active\b/.test(btnClasses))

    // 1er swatch actif a l'ouverture (pre-armement).
    const firstSwatch = page.locator('#triangleColorSwatches .swatch').first()
    const firstActive = await firstSwatch.evaluate(el => el.classList.contains('swatch-active'))
    check('1er swatch actif a l\'ouverture', firstActive)

    // Cliquer le 2e swatch (orange) : on verifie que le clic
    // swatch met a jour brushColor et bascule l'etat actif. On
    // laisse Intentionally le panneau ouvert pour peindre.
    const swatches = await page.locator('#triangleColorSwatches .swatch').all()
    await swatches[1].click()
    await page.waitForTimeout(150)
    check('2e swatch actif apres clic', await swatches[1].evaluate(el => el.classList.contains('swatch-active')))
    check('1er swatch desactive apres clic', !(await swatches[0].evaluate(el => el.classList.contains('swatch-active'))))

    // Peindre tri 0 : clic gauche -> paintTriangleAtCursor ->
    // paintSingleTriangle -> t.fill = brushColor (orange FB8C00).
    await page.mouse.click(660, 500)
    await page.waitForTimeout(150)

    // Fermer le panneau via un nouveau toggle : le panneau se cache
    // et brushMode repasse a false (desarmement du pinceau).
    await page.click('#triangleColor')
    await page.waitForTimeout(80)
    check('panneau ferme apres toggle', await page.locator('#triangleColorPanel').evaluate(el => el.hidden))
    const classesAfterClose = await page.locator('#triangleColor').evaluate(el => el.className)
    check('bouton peinture : aucune classe active apres fermeture', !/\bcolor-(panel-open|active)\b/.test(classesAfterClose))
}

// Undo (Ctrl+Z) puis verifie que le rectangle colore (4 points) est
// restaure. Même chemin clavier que l'utilisateur.
const undoExpectRectRestored = async (label) => {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const info = await sceneInfo()
    check(label, info.points === 4)
}

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Etat initial + rectangle colore ---

    // Sanity : le bouton #triangleColor n'est plus jamais disabled,
    // même au démarrage (mode vertex par défaut + sélection vide).
    {
        const disabled = await page.locator('#triangleColor').evaluate(el => el.disabled)
        check('bouton peinture interactif au boot', !disabled)
    }

    let info = await sceneInfo()
    check('scene vide au depart', info.points === 0 && info.tris.length === 0)

    await createRect()
    info = await sceneInfo()
    check('rectangle cree : 4 points', info.points === 4)
    check('rectangle cree : 2 triangles', info.tris.length === 2)

    await colorTri0()
    info = await sceneInfo()
    check('triangle 0 colore : fill = orange (2e preset)', info.tris[0].fill === COLORED_FILL)
    check('triangle 1 non colore : pas de fill', info.tris[1].fill === undefined)

    // --- 2. Suppression d'un SOMMET (mode vertex) : le sommet p3
    // (500,400) n'appartient qu'au tri 1 (non colore). Le tri 0 colore
    // doit survivre avec son fill. Le tri 1 devient partiel (p3
    // retire, slots survivants 0/2) — le segment oppose reste visible
    // (regle §4.1 deleteSelectedPoint). ---
    await page.mouse.click(500, 400)
    await page.waitForTimeout(120)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('suppression sommet : 3 points restants', info.points === 3)
    check('suppression sommet : tri colore garde son fill', info.tris.some(t => t.fill === COLORED_FILL))

    await undoExpectRectRestored('undo sommet : rectangle colore restaure (4 points)')

    // --- 3. Suppression d'un SEGMENT (mode segment) : l'arete (2,3)
    // (client (700,400)-(500,400), clic au milieu (600,400)) n'appartient
    // qu'au tri 1 (non colore) -> il est retire, le tri 0 survit. ---
    await cycleMode(1)   // vertex -> segment
    await page.mouse.click(600, 400)
    await page.waitForTimeout(120)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('suppression segment : tri non colore supprime', info.tris.length === 1)
    check('suppression segment : tri colore garde son fill', info.tris[0].fill === COLORED_FILL)
    check('suppression segment : 3 points restants', info.points === 3)

    await undoExpectRectRestored('undo segment : rectangle colore restaure (4 points)')

    // --- 4. Suppression d'un TRIANGLE (mode triangle) : clic dans le
    // tri 1 (non colore, au-dessus de la diagonale) -> il est retire,
    // le tri 0 survit avec son fill. ---
    await cycleMode(1)   // segment -> triangle
    await page.mouse.click(567, 450)
    await page.waitForTimeout(120)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(150)
    info = await sceneInfo()
    check('suppression triangle : tri non colore supprime', info.tris.length === 1)
    check('suppression triangle : tri colore garde son fill', info.tris[0].fill === COLORED_FILL)
    check('suppression triangle : 3 points restants', info.points === 3)

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
