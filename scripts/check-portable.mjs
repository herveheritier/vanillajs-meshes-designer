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
//      - autoimport ?autoimport=<base64> -> 2 plans parsés (exerce
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
import { fileURLToPath } from 'node:url'

import { createHarness } from './smoke_lib.mjs'
import { runPortableBrowserTest } from './portable-browser-test.mjs'

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
// édition, persistance, autoimport. Le parcours complet (canvas,
// toolbar, clic, zoom, rechargement, autoimport, favicon) est partagé
// avec check-artifact.mjs : voir portable-browser-test.mjs.
await runPortableBrowserTest(PORTABLE_PATH)
