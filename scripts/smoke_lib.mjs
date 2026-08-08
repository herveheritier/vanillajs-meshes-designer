// Harnais partagé des smoke tests (smoke-preview.mjs, smoke-edit.mjs…).
// playwright-core est une devDependency pinnée 1.49.1 (engines ≥ 18) :
// elle reste compatible avec le Node 24 LTS de ce poste et les 6 suites
// passent dessus — pas de raison de monter tant que tout est vert.

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

// Compte les pixels VERTS (r < 100, g > 150, b < 100) dans une fenêtre
// 16×16 autour de la position CSS (x, y) du canvas. Sert aux checks
// « la prévisualisation du geste (cercle / étoile / anneau / formes)
// est visible pendant le déroulement des actions » : COLOR_CIRCLE_PREVIEW
// = rgba(0, 255, 0, 0.8) sur fond noir, dessiné par drawRadialBase /
// strokeScreenPolyline (renderTransient). La croix blanche du curseur
// (COLOR_CURSOR = #FFFFFF) ne compte pas.
// PRECONDITIONS : (1) réticule désactivé (COLOR_RETICLE = #FFFFFF,
// même règle que countWhitePixelsNear) — jamais activé par les suites ;
// (2) échantillonner HORS des axes : COLOR_AXIS = #00A000 (vert opaque,
// g=160) satisfait aussi le prédicat, donc un point posé sur l'axe X ou
// Y compterait des pixels d'axe même sans aucune preview (faux positif).
// Le cyan de la selection-box (rgba(0,255,255,0.15) sur noir -> b≈38)
// matcherait aussi, mais la box n'est jamais armée pendant un geste de
// construction. (Le curseur, lui, est un overlay DOM depuis l'evolution
// « pointeur hors canvas » : plus aucune croix blanche dans le canvas.)
export const countGreenPixelsNear = (page, cssX, cssY) => page.evaluate(({ x, y }) => {
    const board = document.querySelector('#board')
    const ctx = board.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(x * dpr)
    const py = Math.round(y * dpr)
    const img = ctx.getImageData(px - 8, py - 8, 16, 16).data
    let green = 0
    for (let i = 0; i < img.length; i += 4) {
        if (img[i] < 100 && img[i + 1] > 150 && img[i + 2] < 100) green++
    }
    return green
}, { x: cssX, y: cssY })

// Etat de l'overlay curseur DOM (#cursorOverlay, evolution « pointeur
// hors canvas ») : le curseur applicatif ne vit plus dans le canvas —
// c'est un element position fixed suivi par le mousemove (draw.js
// moveCursorOverlay). Sert aux checks « le pointeur est visible apres
// un 1er clic sans mouvement » : visible + centre en coords viewport.
// null si l'element est absent.
export const cursorOverlayState = (page) => page.evaluate(() => {
    const el = document.querySelector('#cursorOverlay')
    if (!el) return null
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    }
})
