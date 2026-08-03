#!/usr/bin/env node
// check-artifact.mjs — test navigateur de l'ARTEFACT PUBLIÉ (CI) ou d'un
// fichier portable local, en file://.
//
// C'est le complément de check-portable.mjs (qui rebuild puis valide le
// fichier généré) : ici on teste un fichier TEL QU'IL SORT de la CI —
// l'artefact `meshes-portable` téléchargé depuis GitHub Actions — ou
// un meshes-portable.html déjà présent sur le disque. Le test prouve
// que le fichier fonctionne vraiment en double-clic, sans serveur :
// chargement file://, canvas + toolbar, édition (point persisté),
// zoom molette, rechargement (persistance), autoimport (exerce les
// regex de convert.js), favicon résolu depuis assets/.
//
// Modes :
//   node scripts/check-artifact.mjs                 # télécharge le dernier
//                                                    # artefact CI de master
//   node scripts/check-artifact.mjs --out-dir <dir> # extraction dans <dir>
//                                                    # (défaut : temp)
//   node scripts/check-artifact.mjs <fichier.html>  # teste un fichier local
//   node scripts/check-artifact.mjs --keep          # ne nettoie pas le temp
//   node scripts/check-artifact.mjs --repo <slug>   # surcharge le repo
//   node scripts/check-artifact.mjs -h | --help
//
// Prérequis mode CI : `gh` CLI authentifié + `unzip`. Le repo est dérivé
// du remote git (--repo pour surcharger). Même harnais que les smoke
// tests (scripts/smoke_lib.mjs, playwright-core, CHROMIUM_PATH).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPortableBrowserTest } from './portable-browser-test.mjs'

// Racine du projet : ce script vit dans scripts/, la racine est au-dessus.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Nom de l'artefact publié par la CI (step upload-artifact de check.yml).
const ARTIFACT_NAME = 'meshes-portable'

// ===== Helpers =====

// Message dédié quand un binaire requis (gh, unzip) est introuvable :
// spawnSync renvoie status null + error.code ENOENT dans ce cas, et la
// branche `status !== 0` seule afficherait un message trompeur.
const toolMissing = (r) => r.error && r.error.code === 'ENOENT'

// Repo GitHub dérivé du remote `origin` (ou --repo).
const repoSlug = () => {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
    })
    if (r.status !== 0) return null
    const url = r.stdout.trim()
    const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
    return m ? m[1] + '/' + m[2] : null
}

// Dernier run CI réussi de la branche master + id de l'artefact.
// Piège gh api : des `-f` sans `--method GET` transforment la requête en
// POST (404). On porte donc la query dans l'URL directement.
const latestArtifactId = (slug) => {
    const run = spawnSync('gh', [
        'api', 'repos/' + slug + '/actions/runs?branch=master&status=success&per_page=1',
        '-q', '.workflow_runs[0].id',
    ], { encoding: 'utf8' })
    if (toolMissing(run)) {
        throw new Error('gh CLI introuvable — installe gh et authentifie-toi, ou passe un fichier .html en argument.')
    }
    if (run.status !== 0 || !run.stdout.trim()) {
        throw new Error('gh : run master réussi introuvable (' + (run.stderr || '').trim() + ')')
    }
    const runId = run.stdout.trim()
    const art = spawnSync('gh', [
        'api', 'repos/' + slug + '/actions/runs/' + runId + '/artifacts',
        '-q', '.artifacts[] | select(.name == "' + ARTIFACT_NAME + '") | .id',
    ], { encoding: 'utf8' })
    // Garde null : un échec gh peut laisser stdout null — le split lèverait
    // un TypeError au lieu du message propre ci-dessous.
    const ids = (art.stdout || '').trim().split('\n').filter(Boolean)
    if (art.status !== 0 || ids.length === 0) {
        throw new Error('gh : artefact `' + ARTIFACT_NAME + '` introuvable sur le run ' + runId)
    }
    return ids[ids.length - 1] // dernier publié (peut y en avoir plusieurs)
}

// Télécharge le zip de l'artefact dans le dossier de sortie, l'extrait,
// retourne le chemin du meshes-portable.html extrait. Le dossier de
// sortie est créé si besoin (cas --out-dir avec un chemin inexistant) ;
// la garde de nettoyage createdOutDir (module) est levée uniquement
// quand le script a créé le dossier lui-même (un --out-dir préexistant
// contient des fichiers de l'utilisateur, on ne le supprime jamais).
const downloadAndExtract = (slug, outDir) => {
    const artifactId = latestArtifactId(slug)
    const zipPath = path.join(outDir, 'artifact.zip')
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true })
        createdOutDir = true
    }
    console.log('Téléchargement de l\'artefact ' + ARTIFACT_NAME + ' (' + artifactId + ') depuis ' + slug + '…')
    const dl = spawnSync('gh', [
        'api', 'repos/' + slug + '/actions/artifacts/' + artifactId + '/zip',
    ], { encoding: 'buffer' })
    if (toolMissing(dl)) {
        throw new Error('gh CLI introuvable — installe gh et authentifie-toi, ou passe un fichier .html en argument.')
    }
    if (dl.status !== 0) {
        throw new Error('gh : téléchargement de l\'artefact échoué (' + (dl.stderr || '').toString().trim() + ')')
    }
    fs.writeFileSync(zipPath, dl.stdout)
    const unzip = spawnSync('unzip', ['-o', zipPath, '-d', outDir], { encoding: 'utf8' })
    if (toolMissing(unzip)) {
        throw new Error('unzip introuvable — installe-le, ou passe un fichier .html en argument.')
    }
    if (unzip.status !== 0) {
        throw new Error('unzip : extraction échouée (' + (unzip.stderr || '').trim() + ')')
    }
    return path.join(outDir, 'meshes-portable.html')
}

// ===== Point d'entrée =====
const printUsage = () => {
    console.log(`Usage : node scripts/check-artifact.mjs [options]
  Teste en file:// l'artefact portable meshes-portable (CI) ou un fichier
  local, sans serveur (canvas, édition, persistance, zoom, autoimport).

Options :
  (aucun argument)     Télécharge le dernier artefact CI de master (gh) et
                       le teste — prérequis : gh CLI authentifié + unzip.
  <fichier.html>       Teste un fichier portable local (idem --local).
  --local <fichier>    Alias explicite du mode fichier local.
  --out-dir <dir>      Dossier de téléchargement/extraction (défaut : temp).
  --keep               Ne supprime pas le dossier temp en fin de run.
  --repo <slug>        Surcharge le repo (défaut : remote git origin).
  -h, --help           Affiche cette aide.`)
}

const parseArgs = (argv) => {
    let htmlPath = null
    let outDir = null
    let keep = false
    let repo = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--out-dir') {
            outDir = argv[++i]
            if (outDir === undefined) throw new Error('--out-dir attend un chemin.')
        } else if (a === '--keep') {
            keep = true
        } else if (a === '--repo') {
            repo = argv[++i]
            if (repo === undefined) throw new Error('--repo attend un slug owner/repo.')
        } else if (a === '--local') {
            // Alias explicite du chemin positionnel : <fichier.html> et
            // --local <fichier.html> sont équivalents (le mode CI est le
            // défaut, ce flag rend le mode local auto-documenté).
            htmlPath = argv[++i]
            if (htmlPath === undefined) throw new Error('--local attend un chemin de fichier.')
        } else if (a === '-h' || a === '--help') {
            printUsage()
            process.exit(0)
        } else if (a.startsWith('-')) {
            throw new Error('Argument inconnu : ' + a + ' (voir --help)')
        } else {
            htmlPath = a
        }
    }
    return { htmlPath, outDir, keep, repo }
}

let args
try {
    args = parseArgs(process.argv.slice(2))
} catch (e) {
    console.error('check-artifact : ' + e.message)
    console.error('Lancez avec --help pour l\'usage.')
    process.exit(1)
}

// Mode CI (défaut) : télécharge le dernier artefact de master.
// Nettoyage final conditionné à DEUX gardes : le dossier n'est supprimé
// que s'il a été créé par ce script (createdOutDir) ET que --keep n'a
// pas été passé. Un --out-dir préexistant (dossier utilisateur) n'est
// jamais touché, même sans --keep.
//
// createdOutDir part à true par défaut : le temp par défaut est créé
// PAR CE SCRIPT (mkdtempSync juste en dessous) — downloadAndExtract ne
// peut pas le savoir car le dossier existe déjà à son appel. Seul un
// --out-dir explicite DÉJÀ EXISTANT force la garde à false.
let targetPath = args.htmlPath
let cleanupDir = null
let createdOutDir = false
if (!targetPath) {
    const slug = args.repo || repoSlug()
    if (!slug) {
        console.error('check-artifact : repo introuvable (remote origin ou --repo).')
        process.exit(1)
    }
    cleanupDir = args.outDir ? path.resolve(args.outDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'meshes-artifact-'))
    createdOutDir = true
    if (args.outDir && fs.existsSync(cleanupDir)) {
        // --out-dir explicite déjà existant : on ne le supprimera jamais.
        createdOutDir = false
    }
    try {
        targetPath = downloadAndExtract(slug, cleanupDir)
    } catch (e) {
        console.error('check-artifact : ' + e.message)
        if (cleanupDir && createdOutDir && !args.keep) {
            fs.rmSync(cleanupDir, { recursive: true, force: true })
        }
        process.exit(1)
    }
}

if (!fs.existsSync(targetPath)) {
    console.error('check-artifact : fichier introuvable : ' + targetPath)
    process.exit(1)
}

await runPortableBrowserTest(targetPath)

if (cleanupDir && createdOutDir && !args.keep) {
    fs.rmSync(cleanupDir, { recursive: true, force: true })
}
