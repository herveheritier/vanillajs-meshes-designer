// portable-browser-test.mjs — parcours navigateur file:// PARTAGÉ entre
// check-portable.mjs (fichier généré localement) et check-artifact.mjs
// (artefact publié par la CI).
//
// Un seul endroit pour le test navigateur de la version portable : si un
// check évolue (nouveau bouton toolbar, nouveau comportement), les deux
// scripts en bénéficient sans duplication.
//
// Le parcours prouve que le fichier fonctionne en double-clic, sans
// serveur :
//   1. chargement file:// (canvas + toolbar) ;
//   2. clic gauche -> création de point, scène persistée (localStorage) ;
//   3. molette -> zoom (zoomDisplay change, polling) ;
//   4. rechargement -> scène restaurée (persistance) ;
//   5. autoimport ?autoimport=<base64> -> 2 formes parsées (exerce en
//      direct le regex à guillemets de convert.js) ;
//   6. favicon.svg résolu depuis assets/ (dossier à côté du fichier) ;
//   - zéro erreur JS sur tout le parcours.
//
// Même harnais que les smoke tests (smoke_lib.mjs : launchBrowser,
// createHarness, attachErrorCollector, CHROMIUM_PATH).

import { pathToFileURL } from 'node:url'

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

// Texte meshes pour l'autoimport : 2 formes de 3 points, encodé comme le
// fait convert.js (`atob(decodeURIComponent(encoded))`).
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n'
const AUTOIMPORT_PARAM = encodeURIComponent(Buffer.from(MESHES_TEXT, 'utf8').toString('base64'))

// Lance le parcours navigateur complet sur un fichier portable donné.
// Crée son propre harnais (check/finish) : le verdict sort en
// process.exitCode via finish(), comme les smoke tests.
export const runPortableBrowserTest = async (htmlPath) => {
    const { check, finish } = createHarness()
    const browser = await launchBrowser()
    try {
        // 1 — Chargement file://, canvas + toolbar.
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        const errors = attachErrorCollector(page)
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
        await page.waitForSelector('#board')
        const toolbarIds = ['#grid', '#export', '#importMeshes', '#importJson', '#undo', '#redo']
        const toolbarCount = await page.locator(toolbarIds.join(', ')).count()
        check('1. chargement file:// : canvas présent', true)
        check('1. toolbar complète présente (' + toolbarCount + '/6 boutons)', toolbarCount === 6)

        // 2 — Clic gauche dans le vide : crée un point, persiste.
        await page.mouse.click(640, 400)
        const pointPersisted = await page.waitForFunction((key) => {
            try {
                const s = JSON.parse(localStorage.getItem(key) || '{}')
                return Array.isArray(s.shapes) && s.shapes.length === 1 &&
                    Array.isArray(s.shapes[0].pointList) && s.shapes[0].pointList.length >= 1
            } catch (e) { return false }
        }, SCENE_STORAGE_KEY, { timeout: 8000 })
            .then(() => true)
            .catch(() => false)
        check('2. clic -> point créé et persisté dans localStorage', pointPersisted)

        // 3 — Molette : zoom (polling, pas de sleep arbitraire).
        const zoomBefore = await page.locator('#zoomDisplay').textContent()
        await page.mouse.move(640, 400)
        await page.mouse.wheel(0, -120)
        const zoomChanged = await page.waitForFunction(
            (before) => document.querySelector('#zoomDisplay').textContent.trim() !== before,
            zoomBefore.trim(),
            { timeout: 4000 },
        ).then(() => true).catch(() => false)
        const zoomAfter = await page.locator('#zoomDisplay').textContent()
        check('3. molette -> zoom effectif (' + zoomBefore.trim() + ' -> ' + zoomAfter.trim() + ')', zoomChanged)

        // 4 — Rechargement : scène restaurée (persistance).
        await page.reload({ waitUntil: 'load' })
        await page.waitForSelector('#board')
        const restored = await page.waitForFunction((key) => {
            try {
                const s = JSON.parse(localStorage.getItem(key) || '{}')
                return Array.isArray(s.shapes) && s.shapes.length === 1 &&
                    Array.isArray(s.shapes[0].pointList) && s.shapes[0].pointList.length >= 1
            } catch (e) { return false }
        }, SCENE_STORAGE_KEY, { timeout: 8000 })
            .then(() => true)
            .catch(() => false)
        check('4. rechargement : scène restaurée depuis localStorage', restored)
        check('4. aucune erreur JS sur le parcours principal', errors.length === 0)
        if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
        await page.close()

        // 5 — Autoimport ?autoimport= (exerce les regex de convert.js).
        const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        const errors2 = attachErrorCollector(page2)
        await page2.goto(pathToFileURL(htmlPath).href + '?autoimport=' + AUTOIMPORT_PARAM, { waitUntil: 'load' })
        const imported = await page2.waitForFunction((key) => {
            try {
                const s = JSON.parse(localStorage.getItem(key) || '{}')
                return Array.isArray(s.shapes) && s.shapes.length === 2 &&
                    s.shapes[0].pointList.length === 3 && s.shapes[1].pointList.length === 3
            } catch (e) { return false }
        }, SCENE_STORAGE_KEY, { timeout: 8000 })
            .then(() => true)
            .catch(() => false)
        check('5. autoimport file:// -> 2 formes de 3 points (regex convert.js exercés)', imported)
        check('5. aucune erreur JS sur la page autoimport', errors2.length === 0)
        if (errors2.length) console.error('ERREURS JS:\n' + errors2.join('\n'))
        await page2.close()

        // 6 — Favicon résolu : assets/ doit être à côté du fichier.
        const faviconOk = await browser.newPage({ viewport: { width: 1280, height: 800 } })
            .then((p) => p.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
                .then(() => p.evaluate(() => {
                    const link = document.querySelector('link[rel="icon"]')
                    if (!link) return 'absent'
                    const img = new Image()
                    img.src = link.href
                    return new Promise((resolve) => {
                        img.onload = () => resolve('ok')
                        img.onerror = () => resolve('echec')
                    })
                }))
                .finally(() => p.close()))
        check('6. favicon.svg résolu (assets/ à côté du fichier)', faviconOk === 'ok')
    } catch (err) {
        check('parcours sans exception', false)
        console.error('EXCEPTION:', err.message)
    }
    await browser.close()
    finish()
}
