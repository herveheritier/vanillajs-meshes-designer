// Module log.js : helper `log(message)` pour la console de l'app.
// Feuille pure (deps minimales : state pour le DOM ref messageLog,
// rien d'autre). Aucune raison d'importer autre chose, c'est le
// bas de la pile de dependances.
//
// Pourquoi l'avoir extrait de main.js : convert.js avait besoin de
// `log` (utilise dans plusieurs chemins d'import), donc main.js
// faisait `export { log, importMeshFromText }` pour le servir. Cette
// re-export creait une dep circulaire convert.js -> main.js (rompue
// uniquement parce que les fonctions referencees sont appelees dans
// des corps de fonction, jamais au top-level du module). En
// extrayant `log` dans sa propre feuille, convert.js peut
// l'importer directement, et la surface du cycle se reduit a
// `importMeshFromText` (le prochain candidat a extraire dans un
// futur commit).

import { state } from './state.js'

export const log = (message) => {
    if (!state.messageLog) return
    // Prefixe chaque entree avec un timestamp [HH:MM:SS]. padStart
    // assure 2 chiffres pour heures/minutes/secondes (0-23, 0-59,
    // 0-59). Pas de locale : le format est stable et comparable
    // d'une session a l'autre, contrairement a toLocaleTimeString
    // qui depend de la locale de l'utilisateur.
    let d = new Date()
    let pad = (n) => String(n).padStart(2, '0')
    let ts = '[' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ']'
    state.messageLog.innerText += '\n' + ts + ' ' + message
}