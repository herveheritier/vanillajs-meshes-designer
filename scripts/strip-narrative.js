#!/usr/bin/env node

// scripts/strip-narrative.js
//
// Outil one-shot de la branche feature/cleaning : supprime les
// commentaires NARRATIFS d'un fichier .js, en preservant le
// sous-ensemble STRUCTURAL (convention du projet) :
//
//   - Dividers de section :    // ===== foo =====   /   // ----- foo -----
//   - Cross-refs vers DESIGN.md : // Rationale : voir DESIGN.md §X.Y
//   - Marqueurs fonctionnels :  try { ... } catch (e) { /* ignore */ }
//
// Tout autre commentaire est narrative (explication de pourquoi,
// contrat d'une fonction, dependance d'un module) et a deja ete
// RELOCATE vers DESIGN.md par le cleanup v1/v2, donc on peut
// l'ecraser dans la source.
//
// Blank-lines consecutives sont contractees a 1 max (les blocs
// narratifs droppes ne doivent pas laisser de grands gaps visuels).
//
// Les trailing inline `code() // explication` ne sont PAS touches
// ici (deux cas identifies dans state.js:48 et editor.js:385,
// traites au cas par cas dans le commit de leur fichier).
//
// Usage : node scripts/strip-narrative.js <file.js>

const fs = require('node:fs')

const arg = process.argv[2]
if (!arg) {
    console.error('Usage: node scripts/strip-narrative.js <file.js>')
    process.exit(1)
}

const RULE_DIVIDER = /^\s*\/\/\s*[=\-]{4,}/
const RULE_CROSSREF = /^\s*\/\/.*DESIGN\.md\s*§/
const RULE_PURE_COMMENT = /^\s*\/\//
const RULE_BLOCK_COMMENT_OPEN = /\/\*/
const RULE_BLOCK_COMMENT_CLOSE = /\*\//

const src = fs.readFileSync(arg, 'utf8')
const rawLines = src.split('\n')

// Classification par ligne.
// - 'KEEP' : on garde la ligne telle quelle
// - 'DROP' : ligne narrative, on la supprime
// - 'BLANK' : ligne vide, collapsee vers 1 max
// La detection de bloc /* ... */ reste simple : /* ignore */
// matche la regle block_open+close sur la meme ligne, reconnu
// comme KEEP explicitement avant la regle DROP genérique.
const classified = []
let inBlock = false
for (const line of rawLines) {
    if (inBlock) {
        classified.push('DROP')
        if (RULE_BLOCK_COMMENT_CLOSE.test(line)) inBlock = false
        continue
    }
    if (RULE_BLOCK_COMMENT_OPEN.test(line) && !/\/\* ignore \*\//.test(line)) {
        classified.push('DROP')
        if (!RULE_BLOCK_COMMENT_CLOSE.test(line.replace(/^\s*\/\*/, ''))) inBlock = true
        continue
    }
    // Bloc /* ignore */ inline dans un catch : conserver (regle
    // fonctionnelle). Detecte a la presence du marqueur exact sur
    // la ligne, avant la regle commentaire.
    if (/\/\* ignore \*\//.test(line)) {
        classified.push('KEEP')
        continue
    }
    if (RULE_PURE_COMMENT.test(line)) {
        if (RULE_DIVIDER.test(line) || RULE_CROSSREF.test(line)) {
            classified.push('KEEP')
        } else {
            classified.push('DROP')
        }
    } else {
        classified.push(line.trim() === '' ? 'BLANK' : 'KEEP')
    }
}

// Reconstruction avec collapse des BLANK consecutifs (max 1).
const out = []
let lastWasBlank = false
for (let i = 0; i < classified.length; i++) {
    const action = classified[i]
    const raw = rawLines[i]
    if (action === 'DROP') continue
    if (action === 'BLANK') {
        if (!lastWasBlank) {
            out.push('')
            lastWasBlank = true
        }
    } else {
        out.push(raw)
        lastWasBlank = false
    }
}

// Trim blank-lines en tete et queue (esthetique, pas de diff
// fonctionnel — evite que le fichier commence ou finisse par
// des blank-lines isolees apres un nettoyage massif).
while (out.length > 0 && out[0] === '') out.shift()
while (out.length > 0 && out[out.length - 1] === '') out.pop()

const finalText = out.join('\n') + '\n'
fs.writeFileSync(arg, finalText)

const dropped = classified.filter(a => a === 'DROP').length
console.log(arg + ': dropped ' + dropped + ' narrative lines')
