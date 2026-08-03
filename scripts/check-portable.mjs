#!/usr/bin/env node
// check-portable.mjs — build + validation complète de la version portable.
//
// Ce script fabrique `meshes-portable.html` (scripts/build-portable.mjs,
// Option A de PORTABILITE.md) puis le VALIDE de deux façons :
//
//   1. Validation STATIQUE du fichier généré :
//      - node --check sur le script inline fusionné (syntaxe) ;
//      - aucun import/export résiduel (le strip doit être total) ;
//      - aucune ligne vide (les compresseurs removeBlankLines*) ;
//      - shim localStorage présent ;
//      - renommages de collisions appliqués (_stateForShape,
//        _activeShapeMerge) ;
//      - les regex des sources survivent byte-à-byte dans le fusionné
//        (garde indépendante de celle du build, axée sur le regex à
//        guillemets de convert.js — le cas le plus risqué du strip).
//
//   2. Test NAVIGATEUR via file:// (playwright-core, même harnais que
//      les smoke tests — smoke_lib.mjs) : c'est le seul test qui
//      prouve que le fichier portable fonctionne VRAIMENT double-clic,
//      sans serveur :
//      - chargement file:// (canvas + toolbar présents) ;
//      - clic gauche -> création de point, scène persistée (localStorage) ;
//      - molette -> zoom (zoomDisplay change) ;
//      - rechargement -> scène restaurée (persistance) ;
//      - autoimport ?autoimport=<base64> -> 2 formes parsées (exerce
//        en direct le regex à guillemets de convert.js) ;
//      - zéro erreur JS sur tout le parcours.
//
// Usage :
//   node scripts/check-portable.mjs
//   npm run check:portable
// Le fichier est REBUILT à chaque exécution : le check porte toujours
// sur un artefact frais, jamais sur un fichier obsolète.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { launchBrowser, createHarness, attachErrorCollector, SCENE_STORAGE_KEY } from './smoke_lib.mjs'

// Racine du projet : ce script vit dans scripts/, la racine est au-dessus.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORTABLE_PATH = path.join(PROJECT_ROOT, 'meshes-portable.html')

// ===== Phase 1 — Build frais =====
// stdio: 'inherit' : la sortie du build (modules concaténés, octets,
// validations internes) est affichée telle quelle ; on ne garde que le
// code de sortie.
const build = spawnSync(process.execPath, ['scripts/build-portable.mjs'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
})
if (build.status !== 0) {
    console.error('check-portable : le build portable a échoué (exit ' + build.status + ').')
    process.exit(build.status || 1)
}

const { check, finish } = createHarness()

// ===== Phase 2 — Validation statique du fichier généré =====
// Le check d'existence vient AVANT la lecture : si le fichier manquait
// (build OK mais sortie ailleurs), on produit un FAIL propre du harnais
// plutôt qu'un crash ENOENT brut.
const fileExists = fs.existsSync(PORTABLE_PATH)
check('fichier généré présent (' + PORTABLE_PATH + ')', fileExists)
if (!fileExists) {
    finish()
    process.exit(1)
}
const html = fs.readFileSync(PORTABLE_PATH, 'utf8')
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/)
const script = scriptMatch ? scriptMatch[1] : ''
check('script inline unique présent', !!scriptMatch)

// 2.1 node --check sur le script fusionné (parse syntaxique seul).
let syntaxOk = false
if (script) {
    const tmp = path.join(os.tmpdir(), 'meshes-portable-check-' + process.pid + '.mjs')
    fs.writeFileSync(tmp, script)
    const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' })
    fs.unlinkSync(tmp)
    syntaxOk = r.status === 0
    if (!syntaxOk) console.error(r.stderr || r.stdout)
}
check('script fusionné passe node --check', syntaxOk)

// 2.2 Aucun import/export résiduel (les commentaires étant strippés,
// un faux positif est improbable ; on échoue fort sinon).
const residual = script
    .split('\n')
    .filter((line) => /^\s*(import|export)\b/.test(line))
check('aucun import/export résiduel', residual.length === 0)

// 2.3 Aucune ligne vide dans le fichier entier (JS, CSS, HTML).
// Comme grep : un `\n` final ne crée pas de ligne — on retire une
// terminaison de fichier avant de découper, sinon le split produit une
// entrée vide fantôme après le dernier `\n`.
const blankLines = html.replace(/\n$/, '').split('\n').filter((line) => /^[ \t]*$/.test(line)).length
check('aucune ligne vide dans le fichier', blankLines === 0)

// 2.4 Shim localStorage présent en tête du script.
check('shim localStorage présent', script.includes("Object.defineProperty(window, 'localStorage'"))

// 2.5 Renommages de collisions appliqués par le build.
check('renommage _stateForShape appliqué', script.includes('_stateForShape'))
check('renommage _activeShapeMerge appliqué', script.includes('_activeShapeMerge'))

// 2.6 Les regex des sources survivent byte-à-byte. On extrait les regex
// du module convert.js (le plus à risque : le regex à guillemets
// `replace(/^[\"']|[\"']$/g, '')` désynchronisait jadis le strip) et
// on vérifie leur présence verbatim dans le fusionné.
// Fragilité latente assumée : l'heuristique d'extraction peut produire
// un faux positif sur une division (`a / b / c` -> `/ b /`), ce qui
// ferait échouer le check. convert.js n'a aucune division aujourd'hui
// (testé 4/4) — si un jour c'en est ajouté une, le check le signalera
// bruyamment et il faudra restreindre l'extraction.
const convertSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'convert.js'), 'utf8')
const sourceRegexes = [...convertSrc.matchAll(/\/(?:\\.|[^/\\\n])+\/[a-z]*/g)].map((m) => m[0])
const missingRegexes = sourceRegexes.filter((re) => !script.includes(re))
check('regex des sources présents verbatim (' + sourceRegexes.length + ' trouvés, ' +
    (sourceRegexes.length - missingRegexes.length) + ' conservés)',
    missingRegexes.length === 0)

// ===== Phase 3 — Test navigateur file:// =====
// Le portable doit fonctionner sans serveur : chargement file://,
// édition, persistance, autoimport. Même harnais que les smoke tests.
const MESHES_TEXT = '0,0;10,0;5,8.66\n20,0;30,0;25,8.66\n'
const AUTOIMPORT_PARAM = encodeURIComponent(Buffer.from(MESHES_TEXT, 'utf8').toString('base64'))

const browser = await launchBrowser()
try {
    // ===== 3a — Chargement file://, canvas + toolbar =====
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = attachErrorCollector(page)
    await page.goto(pathToFileURL(PORTABLE_PATH).href, { waitUntil: 'load' })
    await page.waitForSelector('#board')
    const toolbarIds = ['#grid', '#export', '#importMeshes', '#importJson', '#undo', '#redo']
    const toolbarCount = await page.locator(toolbarIds.join(', ')).count()
    check('3a. chargement file:// : canvas présent', true)
    check('3a. toolbar complète présente (' + toolbarCount + '/6 boutons)', toolbarCount === 6)

    // ===== 3b — Clic gauche dans le vide : crée un point, persiste =====
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
    check('3b. clic -> point créé et persité dans localStorage', pointPersisted)

    // ===== 3c — Molette : zoom (zoomDisplay change) =====
    // Polling de l'évolution de #zoomDisplay (waitForFunction) plutôt
    // qu'un waitForTimeout fixe : pas de fenêtre temporelle arbitraire,
    // le test passe dès que le zoom a effectivement changé.
    const zoomBefore = await page.locator('#zoomDisplay').textContent()
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, -120)
    const zoomChanged = await page.waitForFunction(
        (before) => document.querySelector('#zoomDisplay').textContent.trim() !== before,
        zoomBefore.trim(),
        { timeout: 4000 },
    ).then(() => true).catch(() => false)
    const zoomAfter = await page.locator('#zoomDisplay').textContent()
    check('3c. molette -> zoom effectif (' + zoomBefore.trim() + ' -> ' + zoomAfter.trim() + ')', zoomChanged)

    // ===== 3d — Rechargement : scène restaurée (persistance) =====
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
    check('3d. rechargement : scène restaurée depuis localStorage', restored)

    check('aucune erreur JS sur le parcours principal', errors.length === 0)
    if (errors.length) console.error('ERREURS JS:\n' + errors.join('\n'))
    await page.close()

    // ===== 3e — Autoimport ?autoimport= (exerce les regex de convert.js) =====
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors2 = attachErrorCollector(page2)
    await page2.goto(pathToFileURL(PORTABLE_PATH).href + '?autoimport=' + AUTOIMPORT_PARAM, { waitUntil: 'load' })
    const imported = await page2.waitForFunction((key) => {
        try {
            const s = JSON.parse(localStorage.getItem(key) || '{}')
            return Array.isArray(s.shapes) && s.shapes.length === 2 &&
                s.shapes[0].pointList.length === 3 && s.shapes[1].pointList.length === 3
        } catch (e) { return false }
    }, SCENE_STORAGE_KEY, { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
    check('3e. autoimport file:// -> 2 formes de 3 points (regex convert.js exercés)', imported)
    check('3e. aucune erreur JS sur la page autoimport', errors2.length === 0)
    if (errors2.length) console.error('ERREURS JS:\n' + errors2.join('\n'))
    await page2.close()
} catch (err) {
    check('parcours navigateur sans exception', false)
    console.error('EXCEPTION:', err.message)
}

await browser.close()
finish()
