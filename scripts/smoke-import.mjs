// Smoke test des imports — playwright-core.
//
// Parcours :
//   A. Import « meshes » (texte) sur scène VIDE → REPLACE direct SANS
//      modale (isSceneEmpty, io.js) : 2 plans, nom adopté du fichier.
//   B. Import JSON sur scène NON vide → modale Remplacer/Fusionner,
//      radio par défaut = replace, validation → REPLACE (1 plan,
//      nom du fichier, undo réinitialisé).
//   C. Mutation (selectAll + Backspace) puis import JSON en mode
//      MERGE → plans additionnés, nom conservé, undo CONSERVÉ,
//      plan actif = le plan importé.
//
// Usage :
//   1. Lancer le serveur dev :  python3 test_server.py   (port 8000)
//   2. node scripts/smoke-import.mjs [baseUrl]

import { launchBrowser, createHarness, attachErrorCollector, hudHelpers, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

const BASE_URL = (process.argv[2] || 'http://localhost:8000/main.html').replace(/\/$/, '')

// Fichier « meshes » : 1 ligne = 1 plan, chaque triplet = 1 triangle.
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n'

const jsonScene = (name, x0) => JSON.stringify({
    format: 'meshes-designer',
    version: 1,
    name, // nom embarqué — doit perdre face au nom du fichier (REPLACE)
    shapes: [{
        pointList: [{ x: x0, y: 0 }, { x: x0 + 10, y: 0 }, { x: x0 + 5, y: 8.66 }],
        tris: [{ p1: 0, p2: 1, p3: 2 }],
    }],
    activeShapeIndex: 0,
})

const { check, finish } = createHarness()

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = attachErrorCollector(page)

// Déclenche le file picker (input créé dynamiquement par main.js) et
// pose le fichier → le change event lance import*FromFile.
const chooseFile = async (btnSelector, file) => {
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click(btnSelector),
    ])
    await chooser.setFiles(file)
}

const waitShapes = (n) => page.waitForFunction(
    ({ key, n }) => {
        try {
            const s = JSON.parse(localStorage.getItem(key) || '{}')
            return Array.isArray(s.shapes) && s.shapes.length === n
        } catch (e) { return false }
    },
    { key: SCENE_STORAGE_KEY, n },
    { timeout: 8000 },
)

// Snapshot lisible de la scène persistée.
const sceneSummary = () => page.evaluate((key) => {
    try {
        const s = JSON.parse(localStorage.getItem(key) || '{}')
        const shapes = Array.isArray(s.shapes) ? s.shapes.map((sh) => ({
            points: Array.isArray(sh.pointList) ? sh.pointList.length : 0,
            tris: Array.isArray(sh.tris) ? sh.tris.length : 0,
        })) : []
        return {
            shapes: shapes.length,
            activeShapeIndex: typeof s.activeShapeIndex === 'number' ? s.activeShapeIndex : -1,
            name: s.name || '',
            points: shapes.map((x) => x.points),
            tris: shapes.map((x) => x.tris),
        }
    } catch (e) {
        return { shapes: -1, activeShapeIndex: -1, name: '', points: [], tris: [] }
    }
}, SCENE_STORAGE_KEY)

const { undoCount, sceneDirty } = hudHelpers(page)

try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('#board')
    await page.waitForTimeout(400)

    // ===== Phase A — import meshes sur scène vide : REPLACE direct =====
    await chooseFile('#importMeshes', {
        name: 'monmesh.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(MESHES_TEXT, 'utf8'),
    })
    await waitShapes(2)
    check('A : scène vide → import direct SANS modale', !(await page.locator('#importModal').isVisible()))
    let s = await sceneSummary()
    check('A : 2 plans importés (3 pts / 1 tri chacun)',
        s.shapes === 2 && JSON.stringify(s.points) === '[3,3]' && JSON.stringify(s.tris) === '[1,1]')
    check('A : nom adopté du fichier (monmesh)', s.name === 'monmesh')
    check('A : undo vide après REPLACE', (await undoCount()) === '(0)')
    check('A : scène non marquée modifiée', (await sceneDirty()) === 'false')

    // ===== Phase B — import JSON sur scène non vide : modale REPLACE =====
    await chooseFile('#importJson', {
        name: 'mesh-b.json',
        mimeType: 'application/json',
        buffer: Buffer.from(jsonScene('embedded-name-b', 40), 'utf8'),
    })
    // La modale est-elle apparue ? waitForSelector ci-dessus échoue (timeout)
    // si le flux n'a pas abouti — on documente juste l'intention.
    await page.waitForSelector('#importModal', { state: 'visible', timeout: 8000 })
    check('B : radio par défaut = replace',
        await page.isChecked('input[name="importMode"][value="replace"]')
        && !(await page.isChecked('input[name="importMode"][value="merge"]')))
    await page.click('#importModalValidate')
    await page.waitForSelector('#importModal', { state: 'hidden' })
    await waitShapes(1)
    s = await sceneSummary()
    check('B : REPLACE → 1 plan (3 pts / 1 tri)',
        s.shapes === 1 && JSON.stringify(s.points) === '[3]' && JSON.stringify(s.tris) === '[1]')
    check('B : nom du fichier prioritaire (mesh-b)', s.name === 'mesh-b')
    check('B : undo réinitialisé après REPLACE', (await undoCount()) === '(0)')
    check('B : scène non marquée modifiée', (await sceneDirty()) === 'false')

    // ===== Phase C — mutation + import JSON en MERGE : undo conservé =====
    // Attention : supprimer TOUS les points (selectAll+Backspace)
    // re-viderait la scène → isSceneEmpty() court-circuite la modale
    // (REPLACE direct, undo écrasé). On garde donc la scène NON vide
    // via une rotation molette (selectAll + wheel) qui crée une entrée
    // undo sans toucher à la topologie.
    await page.click('#selectAll')
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, -120)
    await page.waitForFunction(() => document.querySelector('#undoCount').textContent === '(1)', null, { timeout: 3000 })
    s = await sceneSummary()
    check('C : rotation → 1 entrée undo, géométrie intacte (3 pts / 1 tri)',
        (await undoCount()) === '(1)' && JSON.stringify(s.points) === '[3]' && JSON.stringify(s.tris) === '[1]')

    await chooseFile('#importJson', {
        name: 'mesh-c.json',
        mimeType: 'application/json',
        buffer: Buffer.from(jsonScene('embedded-name-c', 60), 'utf8'),
    })
    await page.waitForSelector('#importModal', { state: 'visible', timeout: 8000 })
    await page.check('input[name="importMode"][value="merge"]')
    await page.click('#importModalValidate')
    await page.waitForSelector('#importModal', { state: 'hidden' })
    await waitShapes(2)
    s = await sceneSummary()
    check('C : MERGE → 2 plans (3 pts + 3 pts)',
        s.shapes === 2 && JSON.stringify(s.points) === '[3,3]' && JSON.stringify(s.tris) === '[1,1]')
    check('C : plan actif = plan importé (index 1)', s.activeShapeIndex === 1)
    check('C : compteur 2/2', (await page.locator('#shapeLabel').textContent()) === '2/2')
    check('C : nom préservé par MERGE (mesh-b)', s.name === 'mesh-b')
    check('C : undo CONSERVÉ par MERGE', (await undoCount()) === '(1)')
    check('C : scène non marquée modifiée', (await sceneDirty()) === 'false')

    check('aucune erreur JS sur tout le parcours', errors.length === 0)
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
} catch (err) {
    check('parcours sans exception', false)
    console.error('EXCEPTION:', err.message)
    if (errors.length) console.error(errors.join('\n'))
}

await browser.close()
finish()
