// Harnais partagé des smoke tests (smoke-preview.mjs, smoke-edit.mjs…).
// playwright-core est une devDependency pinnée 1.49.1 : les versions
// plus récentes exigent Node ≥ 20, ce poste est en Node 18.

import { chromium } from 'playwright-core'
import fs from 'node:fs'

// Exécutable Chromium : surchargeable via CHROMIUM_PATH (défaut :
// /usr/bin/chromium — le binaire installé sur ce poste Debian).
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium'

// Clé localStorage de la scène (constants.js SCENE_STORAGE_KEY) —
// centralisée ici : si la clé change, un seul endroit à mettre à jour.
export const SCENE_STORAGE_KEY = 'meshesDesigner.scene'

export const launchBrowser = () => chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
})

// Harness d'assertions : accumule PASS/FAIL, imprime, sort en exit code
// 0 (tout passe) ou 1 (échec). finish() doit être appelé en fin de test.
export const createHarness = () => {
    const results = []
    const check = (name, ok) => {
        results.push({ name, ok: !!ok })
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name)
    }
    const finish = () => {
        const failed = results.filter((r) => !r.ok)
        console.log('')
        console.log(failed.length === 0
            ? `TOUS LES TESTS PASSENT (${results.length})`
            : `${failed.length} TEST(S) EN ECHEC sur ${results.length}`)
        for (const f of failed) console.log('  - ' + f.name)
        // process.exitCode (pas process.exit) : laisse Node flusher le
        // stdout restant avant de sortir — exit() peut tronquer les
        // logs quand la sortie est pipée (npm run smoke).
        process.exitCode = failed.length === 0 ? 0 : 1
    }
    return { check, finish }
}

// Collecte les erreurs JS (pageerror + console.error) ; le test doit
// vérifier errors.length === 0 en fin de parcours.
export const attachErrorCollector = (page) => {
    const errors = []
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text())
    })
    return errors
}

// Lit le contenu d'un download Playwright en string. Retourne null si
// le téléchargement a été interrompu (download.path() = null) — le
// caller transforme ce null en FAIL explicite plutôt qu'en TypeError.
export const readDownload = async (download) => {
    const p = await download.path()
    if (p === null) return null
    return fs.readFileSync(p, 'utf8')
}

// Helpers HUD partagés par les suites (pill undo, statut dirty) —
// factorisés depuis smoke-edit/smoke-import pour éviter la duplication.
export const hudHelpers = (page) => ({
    undoCount: () => page.locator('#undoCount').textContent(),
    sceneDirty: () => page.locator('#sceneStatus').getAttribute('data-dirty'),
})
