#!/usr/bin/env node
// ============================================================================
// build-portable.mjs — Option A de PORTABILITE.md : fabrique un
// `meshes-portable.html` autonome, ouvrable en double-clic (zéro
// serveur, zéro toolchain, transportable sur clé USB).
//
// Principe :
//   1. Lit main.html et extrait les <script type="module" src="...">
//      DANS L'ORDRE des tags (ordre déjà topologique : bas niveau
//      vers haut niveau — voir le commentaire de main.html).
//   2. Concatène ces modules dans le même ordre en supprimant les
//      imports/exports (machine à états ligne par ligne, voir
//      stripModule) ET les commentaires (stripJsComments, §2.2 —
//      allègement du fichier portable ; les sources restent
//      commentées). Clé de voûte : un <script type="module"> INLINE
//      n'est pas soumis au CORS file:// (rien n'est fetché) — c'est
//      exactement le blocage décrit en §1.1 de PORTABILITE.md.
//   3. Injecte un shim localStorage (Firefox lève SecurityError sur
//      file://, §1.2) en tête du script fusionné.
//   4. Recopie main.html sans les tags <script src=...> + un unique
//      <script type="module"> inline contenant tout, puis copie le
//      dossier assets/ à côté du fichier généré (favicon.svg et
//      meshes d'exemple — §2.3). Les commentaires HTML et CSS de la
//      page sont aussi retirés (stripHtmlComments / stripCssComments),
//      et les lignes vides laissées par ces retraits sont comprimées
//      (removeBlankLinesJs / removeBlankLinesPlain) : le portable est
//      dense, sans altérer ni l'ASI du JS ni le corps des templates.
//   5. Auto-validation : node --check sur CHAQUE module strippé (si le
//      strip de commentaires a cassé une chaîne/un regex, l'erreur est
//      attribuée au bon fichier) puis sur le script fusionné complet.
//
// Les sources multi-fichiers restent canoniques ; ce script est un
// artefact de build et ne modifie JAMAIS les sources de l'app.
//
// Usage :
//   node scripts/build-portable.mjs                  # -> meshes-portable.html
//   node scripts/build-portable.mjs --out dist/      # -> dist/meshes-portable.html (+ dist/assets/)
//   node scripts/build-portable.mjs --no-assets      # ne copie pas assets/
//   node scripts/build-portable.mjs --keep-markers   # garde banner + noms de modules (debug)
// Par défaut tous les commentaires (JS/CSS/HTML) sont retirés.
//
// Raccourci npm optionnel (à ajouter dans package.json si souhaité) :
//   "build:portable": "node scripts/build-portable.mjs"
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ===== Constantes =====

// Racine du projet : ce script vit dans scripts/, la racine est au-dessus.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HTML_SOURCE = path.join(PROJECT_ROOT, 'main.html')
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'meshes-portable.html')
const ASSETS_SOURCE = path.join(PROJECT_ROOT, 'assets')

// Tag de script module externe. L'ordre d'apparition dans main.html
// EST l'ordre de concaténation (topologique, cf. commentaire du bloc
// scripts dans main.html). On recrée une instance de regex à chaque
// usage : un regex global porte un lastIndex mutable, dangereux à
// réutiliser tel quel.
const MODULE_TAG_RE = /<script\s+type="module"\s+src="([^"]+)"\s*><\/script>/g

// Collisions de noms top-level APRÈS fusion (les modules partagent un
// seul scope : deux `const` du même nom seraient une SyntaxError).
// Carte de renommage : fichier -> [{ from, to }], appliquée par
// remplacement de mot (\b) sur la déclaration ET ses références dans
// ce fichier uniquement.
//
// Vérifié dans les sources actuelles :
//   - activeShape : `const activeShape = () => state.shapes[...]`
//     déclaré à l'identique dans editor.js ET merge.js. On renomme
//     merge.js (le second dans l'ordre de concaténation) en
//     `_activeShapeMerge` — attention : `_activeShape` est déjà pris
//     par geometry.js (l.54), d'où le suffixe complet.
// Aucune autre collision top-level connue — une détection automatique
// (voir collectTopLevelDecls) fait échouer le build si un nouveau
// doublon apparaît.
const COLLISION_RENAMES = {
    'merge.js': [{ from: 'activeShape', to: '_activeShapeMerge' }],
}

// Shim localStorage, placé en tête du script fusionné. Firefox lève
// SecurityError à l'accès à localStorage sur un document file:// ;
// Chrome/Edge/Safari : accès normal, le shim ne fait rien de visible.
// Si l'accès lève, on shadowe la propriété par un stockage mémoire
// (non persistant — acceptable pour la version portable sans serveur).
// L'IIFE évite de polluer le scope fusionné (aucune binding top-level).
// Le commentaire d'en-tête n'est conservé qu'avec --keep-markers.
const SHIM_HEADER_COMMENT = '// ===== Shim localStorage (Firefox / file://) =====\n'
const LOCAL_STORAGE_SHIM = `
(() => {
    let backing = null
    try {
        const probe = window.localStorage
        const k = '__meshes_portable_probe__'
        probe.setItem(k, '1')
        probe.removeItem(k)
        backing = probe
    } catch (_) {
        const mem = new Map()
        backing = {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
            clear: () => mem.clear(),
            key: (i) => (i < 0 || i >= mem.size ? null : Array.from(mem.keys())[i]),
            get length() { return mem.size },
        }
    }
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => backing,
    })
})()
`

// ===== Strip des commentaires JS =====
//
// Retire les commentaires `//` et `/* */` du code source : ce sont le
// journal de design du projet, inutiles dans la version portable
// (l'allègement est le but de ce script). Le strip est lexicalement
// conscient (états string/template/regex) : une `/` de division n'est
// pas un commentaire, les `//` d'une URL dans une chaîne non plus, et
// le regex de convert.js (`replace(/^[\"']|[\"']$/g, '')`) contient
// des guillemets.
//
// La seule vraie difficulté est l'ambiguïté regex-vs-division : une
// `/` ouvre un regex si elle suit un token « position opérande »
// (opérateur, `(`, `,`, `=`, `return`, `typeof`, …), une division si
// elle suit un atome (identifiant, nombre, `)`, `]`, `}`…). C'est
// l'heuristique classique des minifieurs ; vérifiée sur les regex des
// sources (tous après `(`) et leurs divisions (toutes après un
// nombre). Cas exotique non couvert (regex après `)` dans `if (x)
// /re/`) : absent des sources ; le node --check par module (build)
// fait échouer le build si un strip cassait la syntaxe.
//
// Règle de remplacement sûre : un commentaire est équivalent à du
// whitespace pour le lexer JS, le remplacer par RIEN peut fusionner
// des tokens (`a/*c*/b` → `ab`). On remplace donc un commentaire par
// un espace, ou par les retours-ligne qu'il contenait : sémantique
// identique (dont la règle ASI de `return`) et numérotation des
// lignes préservée pour le débogage.
// Helpers lexicaux partagés par stripJsComments et
// removeBlankLinesJs (même heuristique regex-vs-division, définitions
// uniques au niveau module).
const isIdentStart = (c) => /[A-Za-z_$]/.test(c)
const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c)
const isDigit = (c) => c >= '0' && c <= '9'
// Mots-clés « position opérande » : une `/` qui les suit peut ouvrir
// un regex (return /re/, typeof …). Les autres mots (this, true,
// identifiants…) sont des atomes -> la `/` suivante est une division.
const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'do', 'else', 'case', 'yield', 'await', 'throw',
    'extends', 'super',
])

const stripJsComments = (source, regexCollector) => {
    let out = ''
    let i = 0
    const n = source.length
    // Texte du regex en cours (pour la garde de préservation : les
    // regex extraits de la source doivent survivre verbatim dans le
    // module strippé, sinon échec fort du build — cf. build).
    let regexBuf = ''
    // Pile de contextes ; le sommet est le contexte actif.
    //   codeTop : code de module (le `}` y est un token banal)
    //   expr    : interpolation de template ${...} (brace > 0,
    //             `}` décrémente puis pop à 0)
    //   tmpl    : corps d'un template literal
    //   str     : chaîne (quote dans ctx.quote)
    //   regex   : regex literal
    // Chaque contexte codeTop/expr porte regexAllowed : la `/`
    // suivante peut-elle ouvrir un regex ?
    const stack = [{ mode: 'codeTop', regexAllowed: true }]
    const top = () => stack[stack.length - 1]

    while (i < n) {
        const c = source[i]
        const ctx = top()
        if (ctx.mode === 'codeTop' || ctx.mode === 'expr') {
            // Fin d'interpolation : `}` ferme le contexte expr.
            if (ctx.mode === 'expr' && c === '}') {
                ctx.brace--
                if (ctx.brace === 0) stack.pop()
                out += c
                i++
                continue
            }
            if (ctx.mode === 'expr' && c === '{') {
                ctx.brace++
                out += c
                i++
                continue
            }
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
                out += c
                i++
                continue
            }
            if (c === '/' && source[i + 1] === '/') {
                // Commentaire de ligne : texte retiré, retour-ligne
                // conservé (séparateur de tokens + sémantique ASI).
                while (i < n && source[i] !== '\n') i++
                continue
            }
            if (c === '/' && source[i + 1] === '*') {
                // Commentaire bloc : on garde ses retours-ligne (un
                // espace sinon) pour ne jamais fusionner deux tokens.
                i += 2
                let nl = ''
                while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
                    if (source[i] === '\n') nl += '\n'
                    i++
                }
                i += 2
                out += nl.length ? nl : ' '
                continue
            }
            if (c === "'" || c === '"') {
                ctx.regexAllowed = false // une chaîne est un atome
                stack.push({ mode: 'str', quote: c })
                out += c
                i++
                continue
            }
            if (c === '`') {
                ctx.regexAllowed = false // un template est un atome
                stack.push({ mode: 'tmpl' })
                out += c
                i++
                continue
            }
            if (c === '/') {
                if (ctx.regexAllowed) {
                    ctx.regexAllowed = false // le regex sera un atome
                    stack.push({ mode: 'regex' })
                    out += c
                    regexBuf = c
                    i++
                    continue
                }
                // Division : opérateur binaire -> position opérande.
                ctx.regexAllowed = true
                out += c
                i++
                continue
            }
            if (isIdentStart(c)) {
                let j = i + 1
                while (j < n && isIdentPart(source[j])) j++
                const word = source.slice(i, j)
                out += word
                ctx.regexAllowed = REGEX_KEYWORDS.has(word)
                i = j
                continue
            }
            if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
                let j = i
                while (j < n && isDigit(source[j])) j++
                if (source[j] === '.') {
                    j++
                    while (j < n && isDigit(source[j])) j++
                }
                if (source[j] === 'e' || source[j] === 'E') {
                    let k = j + 1
                    if (source[k] === '+' || source[k] === '-') k++
                    if (isDigit(source[k])) {
                        j = k
                        while (j < n && isDigit(source[j])) j++
                    }
                }
                out += source.slice(i, j)
                ctx.regexAllowed = false // un nombre est un atome
                i = j
                continue
            }
            if (c === ')' || c === ']' || c === '}') {
                ctx.regexAllowed = false // atome -> la `/` suivante divise
                out += c
                i++
                continue
            }
            if ((c === '+' || c === '-') && source[i + 1] === c) {
                ctx.regexAllowed = false // ++ / -- : atome (i++ / 2)
                out += c + c
                i += 2
                continue
            }
            // Autres ponctuations/opérateurs : position opérande.
            ctx.regexAllowed = true
            out += c
            i++
            continue
        }
        if (ctx.mode === 'str') {
            if (c === '\\') {
                out += c
                if (i + 1 < n) out += source[i + 1]
                i += 2
                continue
            }
            out += c
            if (c === ctx.quote) stack.pop()
            i++
            continue
        }
        if (ctx.mode === 'tmpl') {
            if (c === '\\') {
                out += c
                if (i + 1 < n) out += source[i + 1]
                i += 2
                continue
            }
            if (c === '`') {
                out += c
                stack.pop()
                i++
                continue
            }
            if (c === '$' && source[i + 1] === '{') {
                out += '${'
                stack.push({ mode: 'expr', brace: 1, regexAllowed: true })
                i += 2
                continue
            }
            out += c
            i++
            continue
        }
        if (ctx.mode === 'regex') {
            if (c === '\\') {
                out += c
                regexBuf += c
                if (i + 1 < n) {
                    out += source[i + 1]
                    regexBuf += source[i + 1]
                }
                i += 2
                continue
            }
            if (c === '[') {
                // Classe de caractères : une `/` n'y ferme pas le regex.
                let j = i + 1
                while (j < n && source[j] !== ']') {
                    if (source[j] === '\\') j++
                    j++
                }
                out += source.slice(i, j + 1)
                regexBuf += source.slice(i, j + 1)
                i = j + 1
                continue
            }
            if (c === '/') {
                out += c
                regexBuf += c
                if (regexCollector) regexCollector.push(regexBuf)
                regexBuf = ''
                stack.pop()
                i++
                continue
            }
            if (c === '\n') {
                // Un regex ne contient pas de retour-ligne : notre
                // heuristique a pris une division pour un regex. On
                // abandonne le mode regex (le parent a déjà
                // regexAllowed = false posé à l'ouverture) et on
                // reprend en code : le contenu déjà recopié est du
                // texte brut, inoffensif.
                regexBuf = ''
                stack.pop()
                continue
            }
            out += c
            regexBuf += c
            i++
            continue
        }
        // Sécurité : mode inconnu -> recopie brute.
        out += c
        i++
    }
    return out
}

// ===== Compression des lignes vides =====
//
// Les commentaires retirés par les strippers laissent des suites de
// retours-ligne (remplacement par les retours-ligne du commentaire,
// cf. ci-dessus) ; les séparateurs de modules et le retrait des tags
// en ajoutent. Le fichier produit gardait ainsi la structure de lignes
// très aérée des sources — inutile pour la version portable. On
// compresse chaque suite de lignes vides (retours-ligne consécutifs,
// éventuellement séparés par des espaces/tabs) en UN seul
// retour-ligne.
//
// Sûreté JS (removeBlankLinesJs) : jamais plus d'un retour-ligne
// entre deux lignes non vides => la règle ASI (`return`, `break`,
// `++`/`--`) n'est jamais déclenchée en plus et deux tokens ne
// fusionnent jamais. Le scan est lexicalement conscient (même pile de
// contextes et même heuristique regex-vs-division que
// stripJsComments) pour ne JAMAIS toucher au corps d'un template
// literal multi-lignes — le shim localStorage en est un — ni aux
// chaînes. Un retour-ligne dans un regex n'existe pas : abandon du
// mode regex comme dans stripJsComments.
//
// Sûreté CSS/HTML (removeBlankLinesPlain) : sans effet de rendu —
// main.html ne contient ni <pre> ni <textarea>, ses chaînes CSS ne
// contiennent pas de retour-ligne littéral, et le seul white-space:
// pre-line (`.modal-info`) est alimenté par le JS (innerHTML), pas par
// des lignes vides du source HTML. Un regex simple suffit.
//
// Piège du regex naïf `\n[ \t]*\n+` : pour une SUITE de lignes
// vides avec indentation (`\n   \n   \n`), chaque match ne consomme
// que la première ligne vide et la recherche reprend après lui — la
// dernière ligne vide de la suite (et ses espaces) survit. Le groupe
// `(?:[ \t]*\n)+` avale au contraire TOUTE la suite en un seul match.
// Le trim final `[ \t]+\r?$` élimine les résidus de fin de ligne
// (dont la ligne d'espaces en fin de fichier, qui n'a pas de `\n`
// suivant).
//
// Fins de ligne : les sources sont en LF (vérifié sur main.html et
// les modules) mais les `\r?` tolèrent un CRLF éventuel et
// normalisent la sortie en LF — même défense que stripModule
// (`.replace(/\r$/, '')`).
const removeBlankLinesJs = (code) => {
    let out = ''
    let i = 0
    const n = code.length
    // Même pile de contextes que stripJsComments (codeTop/expr/tmpl/
    // str/regex).
    const stack = [{ mode: 'codeTop', regexAllowed: true }]
    const top = () => stack[stack.length - 1]

    while (i < n) {
        const c = code[i]
        const ctx = top()
        if (ctx.mode === 'codeTop' || ctx.mode === 'expr') {
            if (ctx.mode === 'expr' && c === '}') {
                ctx.brace--
                if (ctx.brace === 0) stack.pop()
                out += c
                i++
                continue
            }
            if (ctx.mode === 'expr' && c === '{') {
                ctx.brace++
                out += c
                i++
                continue
            }
            if (c === '\n') {
                // Normalisation CRLF : un `\r` de fin de ligne déjà émis
                // (jamais en contexte code hors fin de ligne) est retiré
                // pour que la sortie soit uniformément en LF.
                if (out.endsWith('\r')) out = out.slice(0, -1)
                // Ligne vide : on garde UN retour-ligne et on avale
                // les retours-ligne suivants (espaces/tabs, ou `\r`
                // d'un CRLF éventuel, entre eux). Le retour-ligne d'un
                // code non vide, lui, est conservé tel quel (ASI).
                out += '\n'
                let j = i + 1
                while (j < n) {
                    let k = j
                    while (k < n && (code[k] === ' ' || code[k] === '\t' || code[k] === '\r')) k++
                    if (code[k] === '\n') {
                        j = k + 1
                        continue
                    }
                    break
                }
                i = j
                continue
            }
            if (c === ' ' || c === '\t' || c === '\r') {
                out += c
                i++
                continue
            }
            if (c === '/' && code[i + 1] === '/') {
                // Commentaire de ligne (marqueurs --keep-markers) :
                // recopié verbatim, le retour-ligne de fin est traité
                // par la compression ci-dessus.
                while (i < n && code[i] !== '\n') {
                    out += code[i]
                    i++
                }
                continue
            }
            if (c === '/' && code[i + 1] === '*') {
                // Commentaire bloc (défensif — les strippers les ont
                // déjà retirés) : avalé jusqu'à `*/`, remplacé par un
                // espace pour ne jamais fusionner deux tokens.
                i += 2
                while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
                i += 2
                out += ' '
                continue
            }
            if (c === "'" || c === '"') {
                ctx.regexAllowed = false // une chaîne est un atome
                stack.push({ mode: 'str', quote: c })
                out += c
                i++
                continue
            }
            if (c === '`') {
                ctx.regexAllowed = false // un template est un atome
                stack.push({ mode: 'tmpl' })
                out += c
                i++
                continue
            }
            if (c === '/') {
                if (ctx.regexAllowed) {
                    ctx.regexAllowed = false
                    stack.push({ mode: 'regex' })
                    out += c
                    i++
                    continue
                }
                // Division : opérateur binaire -> position opérande.
                ctx.regexAllowed = true
                out += c
                i++
                continue
            }
            if (isIdentStart(c)) {
                let j = i + 1
                while (j < n && isIdentPart(code[j])) j++
                const word = code.slice(i, j)
                out += word
                ctx.regexAllowed = REGEX_KEYWORDS.has(word)
                i = j
                continue
            }
            if (isDigit(c) || (c === '.' && isDigit(code[i + 1]))) {
                let j = i
                while (j < n && isDigit(code[j])) j++
                if (code[j] === '.') {
                    j++
                    while (j < n && isDigit(code[j])) j++
                }
                if (code[j] === 'e' || code[j] === 'E') {
                    let k = j + 1
                    if (code[k] === '+' || code[k] === '-') k++
                    if (isDigit(code[k])) {
                        j = k
                        while (j < n && isDigit(code[j])) j++
                    }
                }
                out += code.slice(i, j)
                ctx.regexAllowed = false // un nombre est un atome
                i = j
                continue
            }
            if (c === ')' || c === ']' || c === '}') {
                ctx.regexAllowed = false // atome -> la `/` suivante divise
                out += c
                i++
                continue
            }
            if ((c === '+' || c === '-') && code[i + 1] === c) {
                ctx.regexAllowed = false // ++ / -- : atome (i++ / 2)
                out += c + c
                i += 2
                continue
            }
            // Autres ponctuations/opérateurs : position opérande.
            ctx.regexAllowed = true
            out += c
            i++
            continue
        }
        if (ctx.mode === 'str') {
            if (c === '\\') {
                out += c
                if (i + 1 < n) out += code[i + 1]
                i += 2
                continue
            }
            out += c
            if (c === ctx.quote) stack.pop()
            i++
            continue
        }
        if (ctx.mode === 'tmpl') {
            // Corps du template recopié VERBATIM : les retours-ligne
            // (et les lignes vides) y sont du contenu, pas du format.
            if (c === '\\') {
                out += c
                if (i + 1 < n) out += code[i + 1]
                i += 2
                continue
            }
            if (c === '`') {
                out += c
                stack.pop()
                i++
                continue
            }
            if (c === '$' && code[i + 1] === '{') {
                out += '${'
                stack.push({ mode: 'expr', brace: 1, regexAllowed: true })
                i += 2
                continue
            }
            out += c
            i++
            continue
        }
        if (ctx.mode === 'regex') {
            if (c === '\\') {
                out += c
                if (i + 1 < n) out += code[i + 1]
                i += 2
                continue
            }
            if (c === '[') {
                // Classe de caractères : une `/` n'y ferme pas le regex.
                let j = i + 1
                while (j < n && code[j] !== ']') {
                    if (code[j] === '\\') j++
                    j++
                }
                out += code.slice(i, j + 1)
                i = j + 1
                continue
            }
            if (c === '/') {
                out += c
                stack.pop()
                i++
                continue
            }
            if (c === '\n') {
                // Un regex ne contient pas de retour-ligne : notre
                // heuristique a pris une division pour un regex. On
                // abandonne (comme stripJsComments).
                stack.pop()
                continue
            }
            out += c
            i++
            continue
        }
        // Sécurité : mode inconnu -> recopie brute.
        out += c
        i++
    }
    return out
}

const removeBlankLinesPlain = (text) =>
    text
        .replace(/\r?\n(?:[ \t]*\r?\n)+/g, '\n')
        .replace(/[ \t]+\r?$/gm, '')

// ===== Strip des commentaires CSS (bloc <style>) =====
// `/* ... */` retirés avec conscience des chaînes CSS ('...' / "...")
// qui peuvent légalement contenir `/*`. Même règle de remplacement
// sûre que pour le JS : un espace, ou les retours-ligne s'il y en
// avait (jamais rien — `.a/*c*/.b` n'équivaut pas à `.a.b`).
//
// Suivi de la PROFONDEUR d'imbrication : selon le spec CSS les
// commentaires ne s'imbriquent pas (le premier `*/` ferme), mais
// main.html contient un cas documentaire « /* @apply */ » à
// l'intérieur d'un commentaire. Si on fermait au premier `*/`, la
// queue du commentaire redeviendrait du code avec une apostrophe non
// balancée (`d'ou la duplication.`), ce qui désynchroniserait l'état
// de chaîne. On s'arrête donc à la `*/` qui ramène la profondeur à
// 0 — fidèle à l'intention de l'auteur et au rendu effectif du
// navigateur.
const stripCssComments = (css) => {
    let out = ''
    let i = 0
    const n = css.length
    while (i < n) {
        const c = css[i]
        if (c === '/' && css[i + 1] === '*') {
            let depth = 1
            i += 2
            let nl = ''
            while (i < n && depth > 0) {
                if (css[i] === '/' && css[i + 1] === '*') depth++
                else if (css[i] === '*' && css[i + 1] === '/') depth--
                else if (css[i] === '\n') nl += '\n'
                i++
            }
            i++ // consomme la `*` de la `*/` de fermeture (la `/` au tour suivant)
            out += nl.length ? nl : ' '
            continue
        }
        if (c === "'" || c === '"') {
            // Chaîne CSS : recopiée telle quelle (peut contenir /*).
            let j = i + 1
            while (j < n && css[j] !== c) {
                if (css[j] === '\\') j++
                j++
            }
            out += css.slice(i, j + 1)
            i = j + 1
            continue
        }
        out += c
        i++
    }
    return out
}

// ===== Strip des commentaires HTML =====
// `<!-- ... -->` retirés (espace ou retours-ligne conservés). Le
// contenu de <script> et <style> est recopié verbatim : le JS est
// encore externe à ce stade du build, le CSS est traité par
// stripCssComments.
const stripHtmlComments = (html) => {
    let out = ''
    let i = 0
    const n = html.length
    while (i < n) {
        const lower = html.slice(i, i + 8).toLowerCase()
        if (lower.startsWith('<script') || lower.startsWith('<style')) {
            const closeTag = lower.startsWith('<script') ? '</script>' : '</style>'
            const end = html.toLowerCase().indexOf(closeTag, i + 8)
            if (end === -1) {
                out += html.slice(i)
                break
            }
            const fullEnd = end + closeTag.length
            out += html.slice(i, fullEnd)
            i = fullEnd
            continue
        }
        if (html[i] === '<' && html[i + 1] === '!' && html[i + 2] === '-' && html[i + 3] === '-') {
            // Commentaire HTML : texte retiré, retours-ligne conservés.
            let j = i + 4
            let nl = ''
            while (j + 2 < n && !(html[j] === '-' && html[j + 1] === '-' && html[j + 2] === '>')) {
                if (html[j] === '\n') nl += '\n'
                j++
            }
            i = Math.min(j + 3, n)
            out += nl.length ? nl : ' '
            continue
        }
        out += html[i]
        i++
    }
    return out
}

// ===== Strip des imports/exports (machine à états ligne par ligne) =====
//
// S'applique APRÈS stripJsComments (voir build) : le code est déjà
// débarassé de ses commentaires, ce strip ne traite que les
// déclarations import/export.
//
// États :
//   - importBuffer : un import multi-lignes (`import {\n ... } from`)
//     est accumulé jusqu'à sa ligne de fermeture, puis jeté entier.
//   - inExportBlock : un ré-export multi-lignes `export {` (jamais vu
//     dans les sources, géré par robustesse).
//
// Règles :
//   - import mono-ligne sans `as` -> supprimé (la binding est déjà
//     définie par le module source, concaténé avant dans l'ordre
//     topologique).
//   - import mono-ligne avec `as` (ex. geometry.js l.53
//     `import { state as _stateForShape }`) -> `const _stateForShape =
//     state` : le renommage local doit survivre au strip.
//   - export const/let/var/function/class/async -> retrait du mot
//     `export` (la binding reste partagée par le scope fusionné).
//   - ré-export `export { A, B }` -> retrait de `export` : le résidu
//     `{ A, B }` est un bloc d'expression inoffensif (cas connus :
//     TAU dans geometry.js, cloneShape dans history.js — aucun
//     `export ... from` inter-fichier ne subsiste).
const stripModule = (fileName, source) => {
    // 1) Renommages de collision connus (boundary \b), appliqués sur
    //    le fichier brut — déclaration et références confondues.
    for (const { from, to } of (COLLISION_RENAMES[fileName] || [])) {
        source = source.replace(new RegExp('\\b' + from + '\\b', 'g'), to)
    }

    const lines = source.split('\n')
    const out = []
    let importBuffer = null     // lignes d'un import multi-lignes en cours
    let inExportBlock = false   // ré-export multi-lignes `export {`

    const isImportStart = (line) => /^\s*import\b/.test(line)
    const isExportStart = (line) => /^\s*export\b/.test(line)
    // Un import est complet sur la ligne s'il contient le spécificateur
    // module (`} from '...'`, ou `from '...'` pour un import sans
    // accolades — default/star, aucun dans les sources actuelles) ou se
    // termine par `;`.
    const importCompleteOnLine = (line) =>
        /}\s*from\s*['"]/.test(line) ||
        /from\s*['"]/.test(line) ||
        /;\s*$/.test(line)

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')

        // Import multi-lignes en cours : on avale tout jusqu'à la
        // fermeture. Un renommage `as` multi-lignes n'est pas géré —
        // on échoue explicitement plutôt que de perdre silencieusement
        // un alias (aucun cas dans les sources actuelles).
        if (importBuffer) {
            importBuffer.push(line)
            if (importCompleteOnLine(line)) {
                const text = importBuffer.join(' ')
                if (/\bas\b/.test(text)) {
                    throw new Error(
                        fileName + ': renommage `as` dans un import multi-lignes non géré : ' +
                        text.trim())
                }
                importBuffer = null
            }
            continue
        }

        if (isImportStart(line)) {
            if (!importCompleteOnLine(line)) {
                importBuffer = [line]
                continue
            }
            // Import mono-ligne. Avec renommage `as` : on émet
            // `const alias = nom` (les noms simples sont déjà des
            // bindings du scope fusionné, rien à émettre).
            const spec = line.match(/^\s*import\s*\{([^}]*)\}\s*from/)
            if (spec && /\bas\b/.test(spec[1])) {
                const decls = spec[1].split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
                    const m = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
                    if (!m) {
                        throw new Error(fileName + ': spécificateur d\'import inattendu : `' + item + '`')
                    }
                    return 'const ' + m[2] + ' = ' + m[1]
                })
                out.push(...decls)
            }
            continue
        }

        if (isExportStart(line)) {
            const indent = line.match(/^\s*/)[0]
            const rest = line.trimStart()

            // export default : aucun dans les sources actuelles ; on
            // accepte uniquement les formes nommées (function/class)
            // et on échoue sinon.
            if (rest.startsWith('export default ')) {
                const def = rest.slice('export default '.length)
                if (/^(async\s+)?function\b|^class\b/.test(def)) {
                    out.push(indent + def)
                } else {
                    throw new Error(fileName + ': export default non nommé non géré : ' + rest)
                }
                continue
            }

            // Ré-export `export {` (mono-ligne : `{ A, B }` résiduel,
            // bloc d'expression inoffensif). Un renommage `as` dans un
            // ré-export n'est pas géré -> échec explicite.
            if (/^\s*export\s*\{/.test(line)) {
                if (/\bas\b/.test(line)) {
                    throw new Error(fileName + ': ré-export `as` non géré : ' + rest)
                }
                if (!line.includes('}')) inExportBlock = true
                out.push(indent + rest.slice('export '.length))
                continue
            }

            // export const/let/var/function/class/async -> retrait du
            // mot `export` : la déclaration devient locale au scope
            // fusionné, partagée par tous les modules.
            out.push(indent + rest.slice('export '.length))
            continue
        }

        // Lignes de continuation d'un ré-export multi-lignes.
        if (inExportBlock) {
            out.push(rawLine)
            if (line.includes('}')) inExportBlock = false
            continue
        }

        out.push(rawLine)
    }

    return out.join('\n')
}

// ===== Détection des collisions top-level =====
// Le scope fusionné ne supporte pas deux bindings du même nom
// (SyntaxError). On scane les déclarations top-level (colonne 0) de
// chaque section strippée et on fait échouer le build au moindre
// doublon : le développeur doit alors ajouter l'entrée dans
// COLLISION_RENAMES. (Les déclarations imbriquées sont indentées et
// ne matchent pas la regex.)
const collectTopLevelDecls = (code) => {
    const decls = []
    for (const line of code.split('\n')) {
        const m = line.match(/^(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/)
        if (m) decls.push(m[1])
    }
    return decls
}

const assertNoTopLevelCollision = (sections) => {
    const seen = new Map() // nom -> fichiers déclarants
    for (const { fileName, code } of sections) {
        for (const name of collectTopLevelDecls(code)) {
            if (!seen.has(name)) seen.set(name, [])
            seen.get(name).push(fileName)
        }
    }
    const collisions = [...seen.entries()].filter(([, files]) => files.length > 1)
    if (collisions.length > 0) {
        for (const [name, files] of collisions) {
            console.error('COLLISION top-level : `' + name + '` déclaré dans ' + files.join(', '))
        }
        throw new Error('Collisions de bindings top-level après fusion — ajoutez une entrée dans COLLISION_RENAMES.')
    }
}

// ===== Garde : aucun import/export résiduel =====
// Un `import`/`export` non strippé resterait du code module VALIDE
// (node --check ne le verrait pas), tout en trahissant une faille du
// strip. On échoue FORT avec fichier + ligne plutôt que de livrer un
// portable incomplètement fusionné. (Les commentaires sont déjà
// retirés par stripJsComments, donc aucune ligne de commentaire ne
// peut déclencher un faux positif.)
const assertNoResidualImportExport = (sections) => {
    for (const { fileName, code } of sections) {
        code.split('\n').forEach((line, i) => {
            if (/^\s*(import|export)\b/.test(line)) {
                throw new Error(
                    fileName + ' l.' + (i + 1) + ' : `' + line.trim() +
                    '` non strippé — mot-clé dans une chaîne/template/regex ou ' +
                    'marqueur de commentaire dans une chaîne ? Vérifiez le strip.')
            }
        })
    }
}

// ===== Copie récursive du dossier assets/ =====
const copyDir = (src, dest) => {
    if (!fs.existsSync(src)) return
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name)
        const d = path.join(dest, entry.name)
        if (entry.isDirectory()) copyDir(s, d)
        else fs.copyFileSync(s, d)
    }
}

// ===== Auto-validation : node --check sur le script fusionné =====
// Parse syntaxique uniquement (les globals navigateur — window,
// document, localStorage — ne sont jamais exécutées par --check).
const validateScriptSyntax = (outPath) => {
    const output = fs.readFileSync(outPath, 'utf8')
    const m = output.match(/<script type="module">([\s\S]*?)<\/script>/)
    if (!m) throw new Error('Script inline introuvable dans ' + outPath)
    const tmp = path.join(os.tmpdir(), 'meshes-portable-check-' + process.pid + '.mjs')
    fs.writeFileSync(tmp, m[1])
    const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' })
    fs.unlinkSync(tmp)
    if (r.status !== 0) {
        console.error('SYNTAXE INVALIDE dans le script fusionné :')
        console.error(r.stderr || r.stdout)
        throw new Error('Le script généré ne passe pas node --check.')
    }
}

// ===== Point d'entrée =====

const printUsage = () => {
    console.log(`Usage : node scripts/build-portable.mjs [options]
  Fabrique meshes-portable.html (Option A de PORTABILITE.md) :
  fusion de tous les modules .js de main.html en un script inline
  unique, sans serveur, ouvrable en double-clic. Tous les
  commentaires (JS, CSS, HTML) sont retirés et les lignes vides
  comprimées pour alléger le fichier.

Options :
  --out <chemin>   Fichier de sortie (défaut : meshes-portable.html
                   à la racine). Avec un slash final (--out dist/),
                   écrit <dossier>/meshes-portable.html.
  --no-assets      Ne copie pas le dossier assets/ à côté du fichier.
  --keep-markers   Conserve les marqueurs de débogage (banner + nom
                   de chaque module + en-tête du shim). Par défaut ils
                   sont retirés comme les autres commentaires.
  -h, --help       Affiche cette aide.`)
}

const parseArgs = (argv) => {
    let outPath = DEFAULT_OUTPUT
    let copyAssets = true
    let keepMarkers = false
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--out') {
            outPath = argv[++i]
            if (outPath === undefined) throw new Error('--out attend un chemin.')
        } else if (a.startsWith('--out=')) {
            outPath = a.slice('--out='.length)
        } else if (a === '--no-assets') {
            copyAssets = false
        } else if (a === '--keep-markers') {
            keepMarkers = true
        } else if (a === '--help' || a === '-h') {
            printUsage()
            process.exit(0)
        } else {
            throw new Error('Argument inconnu : ' + a + ' (voir --help)')
        }
    }
    if (outPath.endsWith('/') || outPath.endsWith(path.sep)) {
        outPath = path.join(outPath, 'meshes-portable.html')
    }
    return { outPath, copyAssets, keepMarkers }
}

const build = (outPath, copyAssets, keepMarkers) => {
    if (!fs.existsSync(HTML_SOURCE)) {
        throw new Error('main.html introuvable : ' + HTML_SOURCE)
    }
    // Allègement de la page : commentaires HTML retirés, puis
    // commentaires CSS du bloc <style> (le JS est encore externe à ce
    // stade — il sera traité module par module plus bas).
    let html = fs.readFileSync(HTML_SOURCE, 'utf8')
    html = stripHtmlComments(html)
    html = html.replace(/<style>([\s\S]*?)<\/style>/g, (full, css) =>
        '<style>' + stripCssComments(css) + '</style>')
    // Lignes vides de la page (head, CSS, corps) : sans effet de
    // rendu (pas de <pre>/<textarea> dans main.html, cf.
    // removeBlankLinesJs), on les comprime — le portable devient
    // dense. Les tags modules sont mono-lignes et survivent tels
    // quels à l'extraction ci-dessous.
    html = removeBlankLinesPlain(html)

    // 1) Tags modules, dans l'ordre d'apparition (ordre topologique).
    const tags = []
    const tagRe = new RegExp(MODULE_TAG_RE.source, 'g')
    let m
    while ((m = tagRe.exec(html)) !== null) {
        tags.push({ src: m[1], index: m.index })
    }
    if (tags.length === 0) {
        throw new Error('Aucun <script type="module" src=...> trouvé dans ' + HTML_SOURCE)
    }

    // 2) Lecture + strip de chaque module, dans l'ordre. Les
    //    commentaires JS sont retirés avant le strip des
    //    imports/exports (celui-ci voit alors du code nu).
    const sections = []
    for (const { src } of tags) {
        const filePath = path.resolve(path.dirname(HTML_SOURCE), src)
        const fileName = path.basename(filePath)
        if (!fs.existsSync(filePath)) {
            throw new Error('Module introuvable : ' + filePath)
        }
        const original = fs.readFileSync(filePath, 'utf8')
        // Garde de préservation : chaque regex de la source doit
        // survivre VERBATIM dans le module strippé. Si le strip de
        // commentaires l'a altéré (heuristique regex-vs-division
        // trompée), le build échoue ici — la dernière direction de
        // corruption silencieuse est fermée.
        const regexes = []
        const cleaned = stripJsComments(original, regexes)
        for (const re of regexes) {
            if (!cleaned.includes(re)) {
                throw new Error(
                    fileName + ': regex `' + re + '` altéré par le strip de commentaires.')
            }
        }
        sections.push({
            fileName,
            code: stripModule(fileName, cleaned),
        })
    }

    // 2bis) Validation syntaxique de chaque module strippé : si le
    // strip de commentaires a cassé une chaîne/un regex (heuristique
    // regex-vs-division), l'erreur est attribuée au bon fichier.
    for (const { fileName, code } of sections) {
        const tmp = path.join(os.tmpdir(), 'meshes-module-' + process.pid + '-' + fileName + '.mjs')
        fs.writeFileSync(tmp, code)
        const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' })
        fs.unlinkSync(tmp)
        if (r.status !== 0) {
            console.error('SYNTAXE INVALIDE après strip de ' + fileName + ' :')
            console.error(r.stderr || r.stdout)
            throw new Error('Le strip de commentaires a cassé ' + fileName + '.')
        }
    }

    // 3) Gardes : pas de collision de bindings top-level après fusion,
    //    et aucun import/export résiduel (sinon échec fort du build).
    assertNoTopLevelCollision(sections)
    assertNoResidualImportExport(sections)

    // 4) Assemblage du script fusionné. Séparateurs de module (nom du
    //    fichier) seulement avec --keep-markers : par défaut tout
    //    commentaire disparaît du portable.
    const merged = sections
        .map(({ fileName, code }) =>
            keepMarkers ? '\n// ===== ' + fileName + ' =====\n' + code : '\n' + code)
        .join('')
        // Échappement défensif : la séquence `</script>` dans une
        // chaîne du code fusionné fermerait prématurément le tag
        // inline dans le navigateur (le build passerait — node --check
        // ne voit pas ce cas — mais l'app casserait). `<\/script` est
        // strictement équivalent à `</script` en valeur dans les
        // chaînes et regex JS. Aucune occurrence dans les sources
        // actuelles — garde pour l'avenir.
        .replaceAll('</script', '<\\/script')

    // 5) Page : main.html sans les tags modules + un script inline.
    const banner = keepMarkers
        ? '// ============================================================\n' +
          '// Fichier GÉNÉRÉ par scripts/build-portable.mjs — ne pas éditer.\n' +
          '// Sources canoniques : les modules .js du projet (ordre\n' +
          '// topologique conservé, imports/exports supprimés). Relancer\n' +
          '// le script pour régénérer.\n' +
          '// ============================================================'
        : ''
    // Compression des lignes vides du script fusionné : les
    // commentaires retirés et les séparateurs de modules laissent des
    // suites de retours-ligne. removeBlankLinesJs est lexicalement
    // conscient (même heuristique que stripJsComments) : les retours-
    // ligne du corps d'un template literal (le shim) restent intacts
    // et jamais plus d'un retour-ligne ne sépare deux lignes de code
    // (ASI préservée).
    const scriptContent =
        banner + '\n' +
        (keepMarkers ? SHIM_HEADER_COMMENT : '') +
        LOCAL_STORAGE_SHIM + '\n' +
        merged + '\n'
    const cleanedScript = removeBlankLinesJs(scriptContent)
        // Extrémités du script : le `\n` de tête (entre le tag et le
        // shim) et celui de fin (avant `</script>`) feraient une ligne
        // vide en première/dernière ligne du script inline.
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
    const inlineScript =
        '<script type="module">' + cleanedScript + '</script>'
    const firstTagIndex = tags[0].index
    const rest = html
        .slice(firstTagIndex)
        .replace(new RegExp(MODULE_TAG_RE.source, 'g'), '')
    // Le retrait des tags laisse les lignes qu'ils occupaient (leur
    // indentation seule) : re-compression du corps HTML.
    const cleanedRest = removeBlankLinesPlain(rest)
    const output = html.slice(0, firstTagIndex) + inlineScript + cleanedRest

    // 6) Écriture + copie de assets/ à côté du fichier. Copie
    //    uniquement si le dossier de sortie DIFFÈRE de la racine :
    //    dans le cas par défaut (sortie à la racine), le dossier
    //    assets/ y est déjà, une copie sur soi-même serait inutile.
    const outDir = path.dirname(outPath)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(outPath, output)
    let assetsCopied = false
    if (copyAssets && fs.existsSync(ASSETS_SOURCE) && outDir !== PROJECT_ROOT) {
        copyDir(ASSETS_SOURCE, path.join(outDir, 'assets'))
        assetsCopied = true
    }

    // 7) Auto-validation syntaxique du script fusionné.
    validateScriptSyntax(outPath)

    // 8) Résumé.
    console.log('=== build-portable ===')
    console.log('Modules concaténés (' + sections.length + ') : ' +
        sections.map((s) => s.fileName).join(', '))
    console.log('Collisions de bindings top-level : aucune')
    console.log('Sortie : ' + outPath + ' (' + output.length + ' octets)')
    console.log('assets/ copié : ' + (assetsCopied ? 'oui' : 'non (déjà présent à la racine)'))
    console.log('Validation node --check : OK')
}

let args
try {
    args = parseArgs(process.argv.slice(2))
} catch (e) {
    console.error('build-portable : ' + e.message)
    console.error('Lancez avec --help pour l\'usage.')
    process.exit(1)
}

try {
    build(args.outPath, args.copyAssets, args.keepMarkers)
} catch (e) {
    console.error('build-portable : ÉCHEC — ' + e.message)
    process.exit(1)
}
