// Smoke test de la fusion par déplacement (2e fonction du bouton
// Fusionner) — playwright-core.
//
// Evolution « le bouton de fusion de points doit avoir une 2ème
// fonction qui est utilisable si et seulement si un seul point est
// sélectionné ; dans ce cas le déplacement puis le relâchement du
// point sélectionné va entrainer sa fusion avec le point le plus
// proche dont la distance est inférieure à une limite prédéfinie »
// (cf. DESIGN.md §7.11 — limite réglable à la molette sur le bouton,
// 20 px par défaut à l'écran).
//
// Parcours :
//   B. Armement + fusion réussie : scène seedée de 4 points / 2 tris,
//      clic sur un point (sélection unique) puis clic sur #mergePoints
//      → le bouton passe en .merge-armed (accent vert), pas de modale,
//      log explicatif. Clic droit + drag du point vers un autre point
//      (relâchement dans le rayon) → pendant le drag l'anneau orange
//      de la cible est visible ; au relâchement le point est fusionné
//      avec la cible (4 → 3 points, 2 tris conservés), le mode est
//      désarmé, et Ctrl+Z ×2 ramène à l'état d'origine.
//   C. Relâchement hors limite : drag vers une zone vide → simple
//      déplacement (toujours 4 points), le mode RESTE armé ; re-clic
//      sur #mergePoints → VERROUILLE le mode (évolution : cycle armé →
//      verrouillé → désarmé), un autre clic → désarmé.
//   D. Conflit topologique : drag d'un point vers un autre point du
//      MÊME triangle → modale d'erreur de fusion, aucun merge (4
//      points), la sélection utilisateur est restaurée.
//   E. Rayon réglable à la molette : mode armé, molette ×3 sur le
//      bouton Fusionner (20 → 26 px, libellé « 26px ») puis drag du
//      point à ~21 px de la cible — hors du défaut 20 px mais dans le
//      nouveau rayon → la fusion s'opère (preuve que la molette change
//      la limite effective).
//   E2. Persistance : nouveau chargement → le rayon 26 px est restauré
//      depuis localStorage et réaffiché sur le bouton.
//   F. Verrouillage (évolution) : scène 5 points / 3 tris — armement
//      puis clic = verrou (classe .merge-locked + icône cadenas
//      visible, log « verrouillée ») ; fusion réussie alors que le
//      mode est verrouillé → il RESTE armé et verrouillé (une 2e
//      fusion sur une autre cible s'enchaîne sans réarmer) ; re-clic
//      sur le bouton verrouillé → désarmé + déverrouillé ; re-armement
//      + verrouillage puis sélection multi-points (Shift+clic) →
//      déverrouillé ET désarmé.
//
// Le seed passe par page.addInitScript (localStorage écrit AVANT le
// boot de l'app), même pattern que smoke-multipoint.mjs.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-mergedrop.mjs [baseUrl]
//
// Harnais partagé dans smoke_lib.mjs ; base URL = 1er argument.

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Scène : 4 points / 2 tris. p0 (0,0) et p3 (100,100) sont dans des
// triangles DIFFÉRENTS (ils partagent l'arête p1-p2) — la fusion
// p0↔p3 n'est pas un conflit topologique, contrairement à p0↔p1 (même
// triangle T1). viewCenter (0,0) + zoom 1 : (0,0) se projette au
// CENTRE du canvas, (100,100) en centre+(100,-100), (100,0) en
// centre+(100,0).
const SCENE = {
    format: 'meshes-designer', version: 1, name: 'drop-merge',
    activeGrid: false, GRID_STEP: 32,
    shapes: [{
        pointList: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }],
        tris: [{ p1: 0, p2: 1, p3: 2 }, { p1: 3, p2: 1, p3: 2 }],
    }],
    activeShapeIndex: 0, zoomLevel: 1, viewCenter: { x: 0, y: 0 },
}

const seedScene = (page, scene) => page.addInitScript(({ key, value }) => {
    try { localStorage.setItem(key, value) } catch (e) { /* ignore */ }
}, { key: SCENE_STORAGE_KEY, value: JSON.stringify(scene) })

// Centre du canvas en CSS px (= position modèle (0,0) avec le seed).
const canvasCenter = (page) => page.evaluate(() => {
    const rect = document.querySelector('#board').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
})

// Compte les pixels ORANGE (#FFA500 = 255,165,0) dans une fenêtre
// 48×48 autour de la position CSS (x, y) — sert à vérifier que
// l'anneau orange de la cible apparaît pendant le drag armé (même
// prédicat serré que smoke-multipoint.mjs, pas de faux positif du
// rendu normal).
const countOrangePixelsNear = (page, cssX, cssY) => page.evaluate(({ x, y }) => {
    const board = document.querySelector('#board')
    const ctx = board.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(x * dpr)
    const py = Math.round(y * dpr)
    const img = ctx.getImageData(px - 24, py - 24, 48, 48).data
    let orange = 0
    for (let i = 0; i < img.length; i += 4) {
        const r = img[i]
        const g = img[i + 1]
        const b = img[i + 2]
        if (r > 230 && g > 130 && g < 190 && b < 60) orange++
    }
    return orange
}, { x: cssX, y: cssY })

// Info sommaire de la forme active depuis le localStorage : compte de
// points / triangles + position du point 0 (le survivant attendu).
const sceneInfo = (page) => page.evaluate((key) => {
    const raw = localStorage.getItem(key) || ''
    try {
        const s = JSON.parse(raw)
        const shape = (s.shapes && s.shapes[0]) || {}
        const p0 = (Array.isArray(shape.pointList) && shape.pointList[0]) || null
        return {
            points: Array.isArray(shape.pointList) ? shape.pointList.length : 0,
            tris: Array.isArray(shape.tris) ? shape.tris.length : 0,
            p0x: p0 ? Math.round(p0.x) : null,
            p0y: p0 ? Math.round(p0.y) : null,
        }
    } catch (e) {
        return { points: -1, tris: -1, p0x: null, p0y: null }
    }
}, SCENE_STORAGE_KEY)

const { check, finish } = createHarness()

const browser = await launchBrowser()

try {
    // ============ B. Armement + fusion réussie (relâchement dans le rayon) ============
    const pageB = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsB = attachErrorCollector(pageB)
    const { undoCount } = hudHelpers(pageB)
    const selectionCount = () => pageB.locator('#selectionCount').textContent()
    const mergeArmed = () => pageB.locator('#mergePoints.merge-armed').count()
    await seedScene(pageB, SCENE)
    await pageB.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageB.waitForSelector('#board')
    await pageB.waitForTimeout(400)

    let info = await sceneInfo(pageB)
    check('B : scène seedée chargée (4 pts / 2 tris)', info.points === 4 && info.tris === 2)
    const center = await canvasCenter(pageB)

    // Sélection unique de p0 (mode vertex par défaut : clic sur le point).
    await pageB.mouse.click(center.x, center.y)
    await pageB.waitForTimeout(150)
    check('B : clic sur p0 → sélection unique (1)', (await selectionCount()) === '1')

    // Clic sur #mergePoints : arme la fusion par déplacement (2e fonction).
    await pageB.click('#mergePoints')
    await pageB.waitForTimeout(150)
    check('B : bouton en .merge-armed', (await mergeArmed()) === 1)
    check('B : pas de modale d\'erreur', await pageB.locator('#mergeErrorModal').evaluate((el) => el.hidden))
    const logText = await pageB.locator('#messageLog').textContent()
    check('B : log explicatif de l\'armement', logText.includes('Fusion par déplacement armée'))

    // Drag droit de p0 vers la cible p3 (centre+(100,-100)), relâchement
    // dans le rayon (≈7 px < 20 px). On vérifie l'anneau orange de la
    // cible PENDANT le drag (bouton encore enfoncé).
    const target = { x: center.x + 95, y: center.y - 95 }
    await pageB.mouse.move(center.x, center.y)
    await pageB.mouse.down({ button: 'right' })
    await pageB.mouse.move(target.x, target.y, { steps: 8 })
    await pageB.waitForTimeout(150)
    const ringVisible = (await countOrangePixelsNear(pageB, center.x + 100, center.y - 100)) > 0
    await pageB.mouse.up({ button: 'right' })
    await pageB.waitForTimeout(200)
    check('B : anneau orange sur la cible pendant le drag', ringVisible)

    info = await sceneInfo(pageB)
    check('B : fusion au relâchement (4 → 3 pts, 2 tris)', info.points === 3 && info.tris === 2)
    check('B : le survivant est à la position de la cible (100,100)', info.p0x === 100 && info.p0y === 100)
    check('B : sélection = survivant (1)', (await selectionCount()) === '1')
    check('B : mode désarmé après fusion', (await mergeArmed()) === 0)
    check('B : 2 entrées undo (déplacement + fusion)', (await undoCount()) === '(2)')

    // Annulabilité : Ctrl+Z retire la fusion, Ctrl+Z retire le déplacement.
    await pageB.keyboard.press('Control+z')
    await pageB.waitForTimeout(150)
    info = await sceneInfo(pageB)
    check('B : undo ×1 → 4 pts (fusion retirée)', info.points === 4)
    await pageB.keyboard.press('Control+z')
    await pageB.waitForTimeout(150)
    info = await sceneInfo(pageB)
    check('B : undo ×2 → p0 revenu à (0,0)', info.points === 4 && info.p0x === 0 && info.p0y === 0)
    check('B : undoCount (0) après 2 undos', (await undoCount()) === '(0)')
    await pageB.close()

    // ============ C. Relâchement hors limite → simple déplacement, mode conservé ============
    const pageC = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsC = attachErrorCollector(pageC)
    const { undoCount: undoCountC } = hudHelpers(pageC)
    const selectionCountC = () => pageC.locator('#selectionCount').textContent()
    const mergeArmedC = () => pageC.locator('#mergePoints.merge-armed').count()
    await seedScene(pageC, SCENE)
    await pageC.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageC.waitForSelector('#board')
    await pageC.waitForTimeout(400)
    const centerC = await canvasCenter(pageC)

    await pageC.mouse.click(centerC.x, centerC.y)
    await pageC.waitForTimeout(150)
    check('C : sélection unique (1)', (await selectionCountC()) === '1')
    await pageC.click('#mergePoints')
    await pageC.waitForTimeout(150)
    check('C : mode armé', (await mergeArmedC()) === 1)

    // Drag loin de tout point (cible vide) → pas de fusion, mode conservé.
    const far = { x: centerC.x - 250, y: centerC.y - 150 }
    await pageC.mouse.move(centerC.x, centerC.y)
    await pageC.mouse.down({ button: 'right' })
    await pageC.mouse.move(far.x, far.y, { steps: 8 })
    await pageC.mouse.up({ button: 'right' })
    await pageC.waitForTimeout(200)
    info = await sceneInfo(pageC)
    check('C : relâchement hors limite → 4 pts (pas de fusion)', info.points === 4)
    check('C : point déplacé vers la zone vide (≈(-250, 150))', info.p0x === -250 && info.p0y === 150)
    check('C : mode TOUJOURS armé', (await mergeArmedC()) === 1)
    check('C : 1 seule entrée undo (le déplacement)', (await undoCountC()) === '(1)')

    // Re-clic sur le bouton → VERROUILLE (évolution : cycle armé →
    // verrouillé → désarmé) : le mode reste armé, le verrou s'active.
    const mergeLockedC = () => pageC.locator('#mergePoints.merge-locked').count()
    await pageC.click('#mergePoints')
    await pageC.waitForTimeout(150)
    check('C : re-clic → verrouillé (toujours armé)', (await mergeArmedC()) === 1 && (await mergeLockedC()) === 1)
    // Un autre clic sur le bouton verrouillé → désarmé (cycle complet).
    await pageC.click('#mergePoints')
    await pageC.waitForTimeout(150)
    check('C : clic sur verrouillé → désarmé', (await mergeArmedC()) === 0 && (await mergeLockedC()) === 0)
    await pageC.close()

    // ============ D. Conflit topologique (cible dans le MÊME triangle) ============
    const pageD = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsD = attachErrorCollector(pageD)
    const selectionCountD = () => pageD.locator('#selectionCount').textContent()
    await seedScene(pageD, SCENE)
    await pageD.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageD.waitForSelector('#board')
    await pageD.waitForTimeout(400)
    const centerD = await canvasCenter(pageD)

    await pageD.mouse.click(centerD.x, centerD.y)
    await pageD.waitForTimeout(150)
    await pageD.click('#mergePoints')
    await pageD.waitForTimeout(150)

    // Drag de p0 vers p1 (centre+(100,0)) : même triangle T1 → refus.
    const conflictTarget = { x: centerD.x + 95, y: centerD.y }
    await pageD.mouse.move(centerD.x, centerD.y)
    await pageD.mouse.down({ button: 'right' })
    await pageD.mouse.move(conflictTarget.x, conflictTarget.y, { steps: 8 })
    await pageD.mouse.up({ button: 'right' })
    await pageD.waitForTimeout(200)
    const modalVisible = await pageD.locator('#mergeErrorModal').evaluate((el) => !el.hidden)
    check('D : modale d\'erreur de fusion (conflit topologique)', modalVisible)
    const modalText = await pageD.locator('#mergeErrorModalInfo').textContent()
    check('D : message « Fusion impossible »', modalText.includes('Fusion impossible'))
    info = await sceneInfo(pageD)
    check('D : aucun merge (4 pts)', info.points === 4)
    check('D : sélection utilisateur restaurée (1)', (await selectionCountD()) === '1')
    await pageD.click('#mergeErrorModalClose')
    await pageD.waitForTimeout(100)
    check('D : modale fermée', await pageD.locator('#mergeErrorModal').evaluate((el) => el.hidden))
    await pageD.close()

    // ============ E. Rayon réglable à la molette sur le bouton ============
    const pageE = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsE = attachErrorCollector(pageE)
    const mergeArmedE = () => pageE.locator('#mergePoints.merge-armed').count()
    const mergeDropTextE = () => pageE.locator('#mergeDropText').textContent()
    await seedScene(pageE, SCENE)
    await pageE.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageE.waitForSelector('#board')
    await pageE.waitForTimeout(400)
    const centerE = await canvasCenter(pageE)

    await pageE.mouse.click(centerE.x, centerE.y)
    await pageE.waitForTimeout(150)
    await pageE.click('#mergePoints')
    await pageE.waitForTimeout(150)
    check('E : mode armé (défaut 20px affiché)', (await mergeArmedE()) === 1 && (await mergeDropTextE()) === '20px')

    // Molette ×3 (deltaY < 0 = +2 px par cran) → 20 + 6 = 26 px.
    await pageE.hover('#mergePoints')
    await pageE.mouse.wheel(0, -100)
    await pageE.mouse.wheel(0, -100)
    await pageE.mouse.wheel(0, -100)
    await pageE.waitForTimeout(150)
    check('E : molette ×3 → libellé « 26px »', (await mergeDropTextE()) === '26px')

    // Drag de p0 à ~21 px de p3 (centre+(100,-100)) : hors du défaut
    // 20 px, dans le nouveau rayon 26 px → la fusion s'opère.
    const wideTarget = { x: centerE.x + 115, y: centerE.y - 115 }
    await pageE.mouse.move(centerE.x, centerE.y)
    await pageE.mouse.down({ button: 'right' })
    await pageE.mouse.move(wideTarget.x, wideTarget.y, { steps: 8 })
    await pageE.mouse.up({ button: 'right' })
    await pageE.waitForTimeout(200)
    info = await sceneInfo(pageE)
    check('E : fusion à ~21 px (rayon élargi, 4 → 3 pts)', info.points === 3 && info.tris === 2)
    check('E : survivant à la position de la cible (100,100)', info.p0x === 100 && info.p0y === 100)
    check('E : mode désarmé après fusion', (await mergeArmedE()) === 0)

    // ============ E2. Persistance du rayon au rechargement ============
    // Reload de la MÊME page (browser.newPage() = contexte isolé, le
    // localStorage n'est pas partagé entre pages) : le seed addInitScript
    // ré-exécute la scène SCENE sur la navigation, et le rayon 26 px
    // persisté par la molette doit être restauré au boot.
    await pageE.reload({ waitUntil: 'networkidle' })
    await pageE.waitForSelector('#board')
    await pageE.waitForTimeout(400)
    const centerE2 = await canvasCenter(pageE)

    await pageE.mouse.click(centerE2.x, centerE2.y)
    await pageE.waitForTimeout(150)
    await pageE.click('#mergePoints')
    await pageE.waitForTimeout(150)
    check('E2 : rayon 26 px restauré au rechargement', (await mergeDropTextE()) === '26px')
    await pageE.close()

    // ============ F. Verrouillage du mode (évolution) ============
    // Scène 5 points / 3 tris : p0 (0,0) et p3 (100,100) ne partagent
    // aucun triangle (fusion 1 OK), p4 (80,0) ne partage aucun triangle
    // avec p1 (100,0) (fusion 2 OK — à ~20 px, dans le rayon).
    const SCENE_LOCK = {
        format: 'meshes-designer', version: 1, name: 'lock-merge',
        activeGrid: false, GRID_STEP: 32,
        shapes: [{
            pointList: [
                { x: 0, y: 0 },     // p0 : déplacé vers p3 (fusion 1)
                { x: 100, y: 0 },   // p1 : cible 2
                { x: 0, y: 100 },   // p2
                { x: 100, y: 100 }, // p3 : cible 1 (triangle différent de p0)
                { x: 80, y: 0 },    // p4 : 20 px de p1 → cible 2
            ],
            tris: [
                { p1: 0, p2: 1, p3: 2 }, // T1 : p0,p1,p2
                { p1: 3, p2: 1, p3: 2 }, // T2 : p3,p1,p2
                { p1: 4, p2: 3, p3: 2 }, // T3 : p4,p3,p2 (p4 ∉ triangle de p1)
            ],
        }],
        activeShapeIndex: 0, zoomLevel: 1, viewCenter: { x: 0, y: 0 },
    }
    const pageF = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errorsF = attachErrorCollector(pageF)
    const selectionCountF = () => pageF.locator('#selectionCount').textContent()
    const mergeArmedF = () => pageF.locator('#mergePoints.merge-armed').count()
    const mergeLockedF = () => pageF.locator('#mergePoints.merge-locked').count()
    const lockIconVisibleF = () => pageF.locator('#mergeLockIcon').isVisible()
    await seedScene(pageF, SCENE_LOCK)
    await pageF.goto(BASE_URL, { waitUntil: 'networkidle' })
    await pageF.waitForSelector('#board')
    await pageF.waitForTimeout(400)
    const centerF = await canvasCenter(pageF)

    // Sélection de p0 puis armement (clic 1).
    await pageF.mouse.click(centerF.x, centerF.y)
    await pageF.waitForTimeout(150)
    check('F : sélection unique (1)', (await selectionCountF()) === '1')
    await pageF.click('#mergePoints')
    await pageF.waitForTimeout(150)
    check('F : mode armé (pas encore verrouillé)', (await mergeArmedF()) === 1 && (await mergeLockedF()) === 0)
    check('F : cadenas masqué hors verrouillage', !(await lockIconVisibleF()))

    // Clic 2 → verrouillage : classe .merge-locked + cadenas visible.
    await pageF.click('#mergePoints')
    await pageF.waitForTimeout(150)
    check('F : clic 2 → mode verrouillé', (await mergeArmedF()) === 1 && (await mergeLockedF()) === 1)
    check('F : cadenas visible quand verrouillé', await lockIconVisibleF())
    const logTextF = await pageF.locator('#messageLog').textContent()
    check('F : log de verrouillage', logTextF.includes('verrouillée'))

    // Fusion 1 (p0 → p3) alors que le mode est verrouillé : le mode
    // RESTE armé ET verrouillé (5 → 4 points).
    const targetF1 = { x: centerF.x + 95, y: centerF.y - 95 }
    await pageF.mouse.move(centerF.x, centerF.y)
    await pageF.mouse.down({ button: 'right' })
    await pageF.mouse.move(targetF1.x, targetF1.y, { steps: 8 })
    await pageF.mouse.up({ button: 'right' })
    await pageF.waitForTimeout(200)
    info = await sceneInfo(pageF)
    check('F : fusion 1 verrouillée (5 → 4 pts)', info.points === 4 && info.tris === 3)
    check('F : mode TOUJOURS armé et verrouillé après fusion', (await mergeArmedF()) === 1 && (await mergeLockedF()) === 1)

    // Fusion 2 ENCHAÎNÉE sans réarmer : sélection de p4 (80,0) puis
    // drag vers p1 (100,0), relâchement à ~2 px → fusion (4 → 3 pts).
    const p4Screen = { x: centerF.x + 80, y: centerF.y }
    await pageF.mouse.click(p4Screen.x, p4Screen.y)
    await pageF.waitForTimeout(150)
    check('F : p4 sélectionné (1)', (await selectionCountF()) === '1')
    const targetF2 = { x: centerF.x + 98, y: centerF.y }
    await pageF.mouse.move(p4Screen.x, p4Screen.y)
    await pageF.mouse.down({ button: 'right' })
    await pageF.mouse.move(targetF2.x, targetF2.y, { steps: 8 })
    await pageF.mouse.up({ button: 'right' })
    await pageF.waitForTimeout(200)
    info = await sceneInfo(pageF)
    check('F : fusion 2 enchaînée (4 → 3 pts)', info.points === 3 && info.tris === 3)
    check('F : toujours armé et verrouillé après la 2e fusion', (await mergeArmedF()) === 1 && (await mergeLockedF()) === 1)

    // Re-clic sur le bouton verrouillé → désarmé + déverrouillé.
    await pageF.click('#mergePoints')
    await pageF.waitForTimeout(150)
    check('F : clic sur verrouillé → désarmé', (await mergeArmedF()) === 0 && (await mergeLockedF()) === 0)
    check('F : cadenas masqué après désarmement', !(await lockIconVisibleF()))

    // Re-armement + verrouillage puis sélection multi-points
    // (Shift+clic) → déverrouillé ET désarmé.
    await pageF.mouse.click(centerF.x + 100, centerF.y - 100)
    await pageF.waitForTimeout(150)
    await pageF.click('#mergePoints')
    await pageF.waitForTimeout(100)
    await pageF.click('#mergePoints')
    await pageF.waitForTimeout(100)
    check('F : re-verrouillé avant multi-sélection', (await mergeArmedF()) === 1 && (await mergeLockedF()) === 1)
    await pageF.keyboard.down('Shift')
    await pageF.mouse.click(centerF.x + 100, centerF.y)
    await pageF.keyboard.up('Shift')
    await pageF.waitForTimeout(200)
    check('F : sélection multi-points (2)', (await selectionCountF()) === '2')
    check('F : multi-points → déverrouillé ET désarmé', (await mergeArmedF()) === 0 && (await mergeLockedF()) === 0)
    await pageF.close()

    check('aucune erreur JS sur tout le parcours', errorsB.length === 0 && errorsC.length === 0 && errorsD.length === 0 && errorsE.length === 0 && errorsF.length === 0)
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
}

await browser.close()
finish()
