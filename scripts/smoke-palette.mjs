// Smoke test : la palette de couleurs est modifiable, enrichissable,
// conservee en localhost, et l'opacite du curseur est UNIQUE, persistee
// et appliquee a CHAQUE peinture (evolution « la palette de couleur
// peut être modifiée et enrichie ; elle est conservée en localhost » +
// « l'opacité choisie par l'utilisateur est conservée et appliquée à
// chaque fois que l'on peint un triangle ») — playwright-core.
//
// Parcours : contexte frais (aucune cle localStorage) -> 8 swatches par
// defaut, curseur d'opacite a 45%. Ajout d'une couleur custom via le
// picker + bouton Ajouter (9 swatches, cle meshesDesigner.colorPalette
// ecrite en liste d'hex). Edition d'un swatch au double-clic : le
// picker reflete sa couleur, une modif est visible EN DIRECT sur le
// swatch, Echap annule et restaure la couleur d'origine (le panneau
// reste ouvert, le pinceau est resynchronise). Pinceau direct : le
// curseur d'opacite arme le pinceau (bornes 0/45/80/100%). LA PEINTURE
// APPLIQUE L'OPACITE CHOISIE : apres avoir regle l'opacite a 60%, un
// clic sur un swatch ne change PAS le curseur, et un clic gauche sur
// un triangle le peint avec la couleur du swatch A 60%. Retrait d'un
// swatch au clic droit (8 swatches). Restauration des defauts (8
// presets d'origine). Persistance : une couleur ajoutee puis reload =
// 9 swatches au boot, dont la couleur ajoutee, et l'opacite de travail
// revient a la derniere valeur fixee MANUELLEMENT (un clic swatch /
// Echap ne l'ecrase pas). Migration : une ancienne cle (liste d'hex
// sans alpha) est lue avec le fill derive a l'opacite de travail.
//
// Les swatches sont construits au boot (buildColorSwatches appele par
// wireTriangleColorPanel), donc leur compte est lisible sans ouvrir le
// panneau ; l'ouverture via #triangleColor n'est necessaire que pour
// exercer les boutons Ajouter / Defauts / Reset et le curseur
// d'opacite.
//
// Le swatch affiche le fill (bg a l'opacite de travail courante) —
// les assertions de couleur de swatch sont donc des rgba(bg, alpha).
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-palette.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')
const PALETTE_KEY = 'meshesDesigner.colorPalette'
const ALPHA_KEY = 'meshesDesigner.colorAlpha'

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Compte les swatches presents dans le DOM (construits au boot, le
// panneau n'a pas besoin d'etre ouvert).
const swatchCount = () => page.locator('#triangleColorSwatches .swatch').count()

// Lit la cle localStorage de la palette : JSON parse ou null si la cle
// est absente / invalide.
const storedPalette = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch (e) { return null }
}, PALETTE_KEY)

// Lit la cle localStorage de l'opacite de travail (nombre [0,1] ou
// null si absente / invalide).
const storedAlphaPref = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch (e) { return null }
}, ALPHA_KEY)

// Set la valeur du picker (#triangleColorInput) et declenche l'evenement
// input (le handler de wireTriangleColorPanel repond au 'input' — on
// emprunte le meme chemin que l'utilisateur qui drague le picker natif,
// sans pouvoir piloter le popup natif du navigateur headless).
const setPicker = async (hex) => {
    await page.evaluate((value) => {
        const input = document.querySelector('#triangleColorInput')
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }, hex)
    await page.waitForTimeout(80)
}

// Set la valeur du curseur d'opacite (#colorAlpha, en pourcentage) et
// declenche l'evenement input (meme chemin que l'utilisateur qui
// drague le slider).
const setAlphaSlider = async (pct) => {
    await page.evaluate((value) => {
        const slider = document.querySelector('#colorAlpha')
        slider.value = String(value)
        slider.dispatchEvent(new Event('input', { bubbles: true }))
    }, pct)
    await page.waitForTimeout(80)
}

// Libelle % a cote du curseur d'opacite.
const alphaLabel = () => page.locator('#colorAlphaValue').textContent()

// Lit la couleur du disque du curseur pinceau : quand brushMode est
// actif, l'overlay DOM #cursorOverlay (evolution « pointeur hors
// canvas ») porte la classe .brush avec background = brushColor (rgba,
// draw.js syncCursorOverlay) — plus aucune lecture de pixels canvas
// (le curseur ne vit plus dans le canvas). On deplace la souris sur
// une zone vide du board (loin des axes #00A000 et du HUD DOM) pour
// repositionner l'overlay, puis on lit son backgroundColor et on
// re-projette le rgba sur fond noir (canal par canal alpha x rgb,
// arrondi) : MEME convention [r, g, b] que l'ancien getImageData,
// les bornes numeriques des checks ci-dessous restent valables.
// NOTE : chaque lecture utilise une POSITION DIFFERENTE pour forcer un
// mousemove reel (les positions tournent en interne) — l'overlay suit
// le pointeur et sa couleur est resynchronisee a chaque deplacement.
let cursorProbePos = 0
const brushCursorColor = async () => {
    cursorProbePos = (cursorProbePos + 1) % 4
    const spots = [[1100, 600], [1050, 650], [1000, 550], [1150, 500]]
    const [x, y] = spots[cursorProbePos]
    await page.mouse.move(x, y)
    await page.waitForTimeout(150)
    return page.evaluate(() => {
        const el = document.querySelector('#cursorOverlay')
        if (!el) return [0, 0, 0]
        const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
        if (!m) return [0, 0, 0]
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1
        return [Math.round(+m[1] * a), Math.round(+m[2] * a), Math.round(+m[3] * a)]
    })
}

// Rectangle 2 coins (500,400) -> (700,550) via le panneau #shapes,
// geste en 2 temps (meme pattern que smoke-color.mjs) : 1er clic =
// 1er coin, mouvement = taille, 2e clic = valide.
const createRect = async () => {
    await page.click('#shapes')
    await page.waitForTimeout(100)
    await page.click('#shapesPanel button[data-shape="rect"]')
    await page.waitForTimeout(100)
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(700, 550, { steps: 6 })
    await page.mouse.up()
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)
}

// Snapshot lisible du plan actif (points + fills des tris) depuis
// le localStorage de la page.
const sceneInfo = () => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    if (!raw) return { points: 0, tris: [] }
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.map(t => t.fill) : [],
        }
    } catch (e) {
        return { points: -1, tris: [] }
    }
}, SCENE_STORAGE_KEY)

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // --- 1. Etat initial (contexte frais) : 8 presets, cle absente,
    //        curseur d'opacite a 45% ---

    check('boot : 8 swatches par defaut', (await swatchCount()) === 8)
    check('boot : cle colorPalette absente en localStorage', (await storedPalette()) === null)

    await page.click('#triangleColor')
    await page.waitForTimeout(100)
    check('panneau ouvert', await page.locator('#triangleColorPanel').isVisible())
    check('curseur d\'opacite present et a 45%', await page.locator('#colorAlpha').inputValue() === '45' && (await alphaLabel()) === '45%')

    // --- 2. Ajout d'une couleur custom via le picker + Ajouter ---

    await setPicker('#123456')
    await page.click('#colorPaletteAdd')
    await page.waitForTimeout(120)
    check('Ajouter : 9 swatches', (await swatchCount()) === 9)

    const stored1 = await storedPalette()
    check('Ajouter : palette persistee (9 hex)', Array.isArray(stored1) && stored1.length === 9)
    check('Ajouter : couleur ajoutee en queue', Array.isArray(stored1) && stored1[8] === '#123456')

    // Le nouvel swatch est arme (pinceau sur la couleur ajoutee).
    const lastSwatch = page.locator('#triangleColorSwatches .swatch').last()
    check('Ajouter : nouveau swatch actif', await lastSwatch.evaluate(el => el.classList.contains('swatch-active')))

    // Dedup : re-ajouter la meme couleur = no-op arme (toujours 9).
    await page.click('#colorPaletteAdd')
    await page.waitForTimeout(120)
    check('Ajouter dedup : toujours 9 swatches', (await swatchCount()) === 9)

    // --- 3. Edition d'un swatch au double-clic : couleur en direct,
    //        Echap annule ---

    await lastSwatch.dblclick()
    await page.waitForTimeout(120)
    check('double-clic : mode edition (classe swatch-editing)', await lastSwatch.evaluate(el => el.classList.contains('swatch-editing')))
    const pickerValue = await page.locator('#triangleColorInput').inputValue()
    check('double-clic : picker reflete la couleur du swatch', pickerValue === '#123456')

    // Modifier la couleur : le swatch change EN DIRECT (WYSIWYG, a
    // l'opacite de travail courante 45%).
    await setPicker('#654321')
    const editedBg = await lastSwatch.evaluate(el => el.style.backgroundColor)
    check('edition : swatch mis a jour en direct (rgba(101, 67, 33, 0.45))', editedBg === 'rgba(101, 67, 33, 0.45)')

    // Echap annule : retour a la couleur d'origine, panneau toujours
    // ouvert. Le curseur d'opacite n'est PAS touche (opacite globale).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    const revertedBg = await lastSwatch.evaluate(el => el.style.backgroundColor)
    check("Echap : couleur d'origine restauree", revertedBg === 'rgba(18, 52, 86, 0.45)')
    check('Echap : panneau reste ouvert', await page.locator('#triangleColorPanel').isVisible())
    check('Echap : mode edition termine', !(await lastSwatch.evaluate(el => el.classList.contains('swatch-editing'))))
    const stored2 = await storedPalette()
    check('Echap : palette persistee sans la couleur annulee', Array.isArray(stored2) && stored2[8] === '#123456')

    // Echap resynchronise aussi le pinceau sur la couleur restauree
    // (fill derive alpha 0.45 de #123456 = rgb(8, 23, 39) sur fond
    // noir) : sans cette resync, le disque du curseur afficherait la
    // couleur annulee et le prochain clic gauche peindrait la mauvaise
    // couleur.
    const [br, bg, bb] = await brushCursorColor()
    check('Echap : pinceau resynchronise sur la couleur restauree', Math.abs(br - 8) <= 3 && Math.abs(bg - 23) <= 3 && Math.abs(bb - 39) <= 3)

    // --- 3bis. Pinceau direct : le curseur d'opacite arme le pinceau ---

    // Changer la couleur custom (hors edition) : le pinceau prend bg +
    // opacite de travail courante (45% a ce stade).
    await setPicker('#0000ff')
    let [dbr, dbg, dbb] = await brushCursorColor()
    check('pinceau direct : alpha de travail 0.45 applique', Math.abs(dbr - 0) <= 3 && Math.abs(dbg - 0) <= 3 && Math.abs(dbb - 115) <= 3)

    // Monter l'opacite a 80% : le pinceau suit sans toucher au picker.
    await setAlphaSlider(80)
    ;[dbr, dbg, dbb] = await brushCursorColor()
    check('pinceau direct : alpha 0.8 applique', Math.abs(dbr - 0) <= 3 && Math.abs(dbg - 0) <= 3 && Math.abs(dbb - 204) <= 3)

    // Bornes du curseur : 0% = transparent, 100% = opaque.
    await setAlphaSlider(0)
    check('curseur : borne basse 0%', await page.locator('#colorAlpha').inputValue() === '0' && (await alphaLabel()) === '0%')
    ;[dbr, dbg, dbb] = await brushCursorColor()
    check('pinceau direct : alpha 0 (transparent)', dbr <= 3 && dbg <= 3 && dbb <= 3)
    await setAlphaSlider(100)
    ;[dbr, dbg, dbb] = await brushCursorColor()
    check('pinceau direct : alpha 1 (opaque)', Math.abs(dbr - 0) <= 3 && Math.abs(dbg - 0) <= 3 && Math.abs(dbb - 255) <= 3)

    // Remettre a 45% (valeur neutre pour la suite).
    await setAlphaSlider(45)

    // --- 3ter. LA PEINTURE APPLIQUE L'OPACITE CHOISIE ---

    // Fermer le panneau (Echap, pas en edition) pour dessiner : le
    // pinceau desarme, les clics recreent des points.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    await createRect()
    const rectInfo = await sceneInfo()
    check('3ter : rectangle cree (4 points)', rectInfo.points === 4)

    // Ouvrir la palette, regler l'opacite a 60%, puis cliquer le 1er
    // swatch (rouge #E53935) : le curseur d'opacite DOIT rester a 60%
    // (le clic choisit la couleur, PAS l'opacite).
    await page.click('#triangleColor')
    await page.waitForTimeout(100)
    await setAlphaSlider(60)
    await page.locator('#triangleColorSwatches .swatch').first().click()
    await page.waitForTimeout(100)
    check('3ter : clic swatch ne change pas l\'opacite (60%)', await page.locator('#colorAlpha').inputValue() === '60' && (await alphaLabel()) === '60%')

    // Peindre le triangle sous le curseur : le fill doit etre la
    // couleur du swatch A 60% d'opacite (et non l'alpha par defaut).
    await page.mouse.click(550, 430)
    await page.waitForTimeout(200)
    const painted = await sceneInfo()
    check('3ter : triangle peint a 60% (rgba(229, 57, 53, 0.6))', painted.tris.includes('rgba(229, 57, 53, 0.6)'))
    check('3ter : opacite toujours a 60% apres peinture', await page.locator('#colorAlpha').inputValue() === '60')

    // --- 4. Retrait d'un swatch au clic droit ---

    await lastSwatch.click({ button: 'right' })
    await page.waitForTimeout(120)
    check('clic droit : 8 swatches', (await swatchCount()) === 8)
    const stored3 = await storedPalette()
    check('clic droit : couleur retiree de la palette persistee', Array.isArray(stored3) && stored3.length === 8 && !stored3.includes('#123456'))

    // --- 5. Restauration des defauts ---

    await setPicker('#abcdef')
    await page.click('#colorPaletteAdd')
    await page.waitForTimeout(120)
    await page.click('#colorPaletteRestore')
    await page.waitForTimeout(120)
    check('Defauts : retour a 8 swatches', (await swatchCount()) === 8)
    const stored4 = await storedPalette()
    check('Defauts : palette persistee = 8 presets', Array.isArray(stored4) && stored4.length === 8 && stored4[0] === '#E53935' && stored4[7] === '#FFFFFF')

    // --- 6. Persistance au reload : couleur ajoutee + opacite de
    //        travail ---

    await setPicker('#ff00aa')
    await setAlphaSlider(30)
    await page.click('#colorPaletteAdd')
    await page.waitForTimeout(120)
    check('avant reload : 9 swatches', (await swatchCount()) === 9)

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('reload : 9 swatches restaures', (await swatchCount()) === 9)
    const restoredBgs = await page.evaluate(() => Array.from(document.querySelectorAll('#triangleColorSwatches .swatch'))
        .map(el => el.style.backgroundColor))
    check('reload : couleur ajoutee presente (fill a l\'opacite 0.3)', restoredBgs.includes('rgba(255, 0, 170, 0.3)'))
    const stored5 = await storedPalette()
    check('reload : couleur ajoutee persistee', Array.isArray(stored5) && stored5[8] === '#ff00aa')
    // L'opacite de travail (reglee a 30% manuellement avant l'ajout)
    // est restauree au boot.
    check('reload : opacite de travail restauree (30%)', await page.locator('#colorAlpha').inputValue() === '30' && (await alphaLabel()) === '30%')

    // --- 6bis. Seul un reglage MANUEL du curseur est persiste ---

    // Re-ouvrir le panneau (ferme par le reload) : les clics sur
    // swatch exigent un element visible. Le slider, lui, reste lisible
    // meme panneau ferme (lecture de la valeur, pas de click).
    await page.click('#triangleColor')
    await page.waitForTimeout(100)

    // Reglage manuel : 60% est persiste (cle meshesDesigner.colorAlpha).
    await setAlphaSlider(60)
    check('6bis : reglage manuel persiste (0.6)', (await storedAlphaPref()) === 0.6)

    // Cliquer un swatch : la couleur change mais le curseur reste a 60%
    // et la preference persistee n'est pas ecrasee.
    await page.locator('#triangleColorSwatches .swatch').first().click()
    await page.waitForTimeout(100)
    check('6bis : clic swatch ne change pas l\'opacite (60%)', await page.locator('#colorAlpha').inputValue() === '60')
    check('6bis : clic swatch n\'ecrase pas la preference (0.6)', (await storedAlphaPref()) === 0.6)

    // Double-clic (mode edition) puis Echap : l'opacite reste 60% et la
    // preference persistee reste 0.6.
    await page.locator('#triangleColorSwatches .swatch').first().dblclick()
    await page.waitForTimeout(120)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    check('6bis : Echap ne change pas l\'opacite (60%)', await page.locator('#colorAlpha').inputValue() === '60')
    check('6bis : Echap ne persiste pas (0.6)', (await storedAlphaPref()) === 0.6)

    // Reload : l'opacite de travail revient au dernier reglage MANUEL
    // (60%).
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('6bis : reload restaure le reglage manuel (60%)', await page.locator('#colorAlpha').inputValue() === '60' && (await alphaLabel()) === '60%')

    // --- 7. Migration : ancienne cle (liste d'hex) ---

    // Une sauvegarde legacy (liste de strings hex) est lue au boot ;
    // le fill du swatch est derive a l'opacite de travail courante.
    await page.evaluate((key) => {
        localStorage.setItem(key, JSON.stringify(['#010203']))
    }, PALETTE_KEY)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('migration : 1 swatch restaure depuis la cle legacy', (await swatchCount()) === 1)
    const migratedBg = await page.locator('#triangleColorSwatches .swatch').first().evaluate(el => el.style.backgroundColor)
    check('migration : fill derive a l\'opacite de travail (rgba(1, 2, 3, 0.6))', migratedBg === 'rgba(1, 2, 3, 0.6)')
    // La preference d'opacite de travail n'est pas touchee par la
    // migration de la palette.
    check('migration : opacite de travail preservee (60%)', await page.locator('#colorAlpha').inputValue() === '60')

    // Ancienne cle de format intermediaire ({ bg, alpha }) : l'alpha
    // par swatch est ignore (l'opacite est globale, le fill est derive
    // a l'opacite de travail courante 60%).
    await page.evaluate((key) => {
        localStorage.setItem(key, JSON.stringify([{ bg: '#050607', alpha: 0.9 }]))
    }, PALETTE_KEY)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('migration : cle { bg, alpha } lue (alpha par swatch ignore)', (await swatchCount()) === 1)
    const migratedObjBg = await page.locator('#triangleColorSwatches .swatch').first().evaluate(el => el.style.backgroundColor)
    check('migration : fill a l\'opacite de travail (rgba(5, 6, 7, 0.6))', migratedObjBg === 'rgba(5, 6, 7, 0.6)')

    // --- 8. Robustesse du restore : valeur persistee invalide ou
    //        hors bornes ---

    // Valeur non-numerique : ignoree, defaut 45%.
    await page.evaluate((key) => { localStorage.setItem(key, 'abc') }, ALPHA_KEY)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('8 : valeur persistee invalide = defaut (45%)', await page.locator('#colorAlpha').inputValue() === '45')

    // Valeur hors [0,1] (cle bricolee) : clamp au boot (7 -> 100%).
    await page.evaluate((key) => { localStorage.setItem(key, '7') }, ALPHA_KEY)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)
    check('8 : valeur persistee hors bornes clamee (7 -> 100%)', await page.locator('#colorAlpha').inputValue() === '100')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
