'use strict';

// ---------------------------------------------------------------
// test.js
//
// Pure-Node smoke tests (no DOM, no browser). Covers les deux
// modules sans DOM/IO : geometry.js (math helpers) et history.js
// (cloneTriArray, cloneScene). Les autres modules touchent le DOM
// ou dependent de l'etat UI et ne sont pas testables en Node pur —
// ils sont smokes-testes visuellement dans le navigateur.
//
// Executer : `node test.js` depuis la racine du projet.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
function readSrc(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Sandbox : vm.createContext attache automatiquement les
// intrinsiques standard (Object, Array, Math, Map, ...). On
// declare juste les stubs DOM-/sidebar prealablement pour qu'un
// futur test puisse referencer un symbole absent sans crasher.
const sandbox = {
    confirm: () => false,
};
const ctx = vm.createContext(sandbox);

// Charge les modules dans l'ordre de dependance documente dans
// README. Les bindings `let` script-global persistent à travers
// les vm.runInContext successifs dans le meme realm (la "Script
// Global Lexical Environment" du realm est partagee entre scripts).
vm.runInContext(readSrc('constants.js'),  ctx, { filename: 'constants.js' });
vm.runInContext(readSrc('state.js'),      ctx, { filename: 'state.js' });
vm.runInContext(readSrc('geometry.js'),   ctx, { filename: 'geometry.js' });
vm.runInContext(readSrc('history.js'),    ctx, { filename: 'history.js' });

// probe : execute une expression dans le meme realm. Retourne la
// valeur brute (objet, array, primitif) — pas de stringification,
// on compare avec deepEq cote hote.
// IMPORTANT : pour muter un binding `let` script-global depuis
// l'exterieur, on WRAPPE dans une IIFE — sans IIFE, un top-level
// `shapes = [...]` creerait une nouvelle propriete globalThis au
// lieu d'ecraser le binding let.
function probe(expr) {
    return vm.runInContext(expr, ctx, { filename: '<probe>' });
}

// deepEq : compare a et b structurellement. Pour les primitifs,
// `a === b` (qui considere +0 et -0 egaux, comme attendu
// mathematiquement) PLUS un cas special NaN : la spec dit
// NaN !== NaN, mais il est bien plus utile de considerer deux
// NaN comme egaux dans une assertion structurelle. Recursion sur
// arrays/objects. Retourne un booleen.
function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (a === null || b === null) return false;
    const aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) return false;
    if (aIsArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEq(a[k], b[k])) return false;
    return true;
}

// resetState : reinitialise les bindings `let` script-global
// que les tests vont muter (activeGrid, GRID_STEP, ctx.*), pour
// que les tests soient order-independent. Les fonctions ne sont
// pas touchees ; ce ne sont que les bindings d'etat. On WRAPPE
// dans une IIFE pour pouvoir assigner aux `let` du realm.
const resetState = () => probe(`(() => {
    activeGrid = false;
    GRID_STEP = DEFAULT_GRID_STEP;
    ctx.center = { x: 0, y: 0 };
    ctx.viewCenter = { x: 0, y: 0 };
    ctx.zoomLevel = 1;
    ctx.rotationTracking = 0;
})()`);

const tests = [];
function test(name, fn) {
    // Wrap fn : chaque test reinitialise l'etat partage mute (ctx,
    // activeGrid, GRID_STEP) avant de s'executer. Les tests deviennent
    // ainsi order-independent : pas de leak entre tests, pas de
    // comportement dependant de l'ordre du tableau.
    tests.push({ name, fn: () => { resetState(); fn(); } });
}
function assertEq(actual, expected, msg) {
    if (!deepEq(actual, expected)) {
        throw new Error(msg + ': attendu ' + JSON.stringify(expected) + ', recu ' + JSON.stringify(actual));
    }
}

// ============================================================
// geometry.js
// ============================================================

test('modelToScreen identite a zoom=1, viewCenter=(0,0)', () => {
    const r = probe(`(() => { ctx.center = { x: 0, y: 0 }; ctx.viewCenter = { x: 0, y: 0 }; ctx.zoomLevel = 1; return modelToScreen({ x: 7, y: 3 }); })()`);
    // Y inverse : model.y > 0 => screen.y < 0
    assertEq(r, { x: 7, y: -3 }, 'modelToScreen devrait translater +X/-Y');
});

test('modelToScreen avec zoom et viewCenter', () => {
    const r = probe(`(() => { ctx.center = { x: 200, y: 150 }; ctx.viewCenter = { x: 5, y: -3 }; ctx.zoomLevel = 2; return modelToScreen({ x: 7, y: 4 }); })()`);
    // x = 200 + (7-5)*2 = 204 ; y = 150 - (4-(-3))*2 = 150 - 14 = 136
    assertEq(r, { x: 204, y: 136 }, 'zoom 2x, viewCenter (5,-3)');
});

test('screenToModel ∘ modelToScreen = identite (round-trip)', () => {
    const r = probe(`(() => { ctx.center = { x: 200, y: 150 }; ctx.viewCenter = { x: 5, y: -3 }; ctx.zoomLevel = 2; return screenToModel(modelToScreen({ x: 7, y: 4 })); })()`);
    assertEq(r, { x: 7, y: 4 }, 'round-trip devrait etre identite');
});

test('modelToScreen refuse les entrees nulles', () => {
    assertEq(probe('modelToScreen(null)'),      undefined, 'null renvoie undefined');
    assertEq(probe('modelToScreen(undefined)'), undefined, 'undefined renvoie undefined');
});

test('snapToGrid noop si activeGrid = false', () => {
    // activeGrid let est false par defaut (state.js init)
    const r = probe('snapToGrid({ x: 17, y: 23 })');
    assertEq(r, { x: 17, y: 23 }, 'snap inactif = pas de modif');
});

test('snapToGrid quantize a GRID_STEP', () => {
    const r = probe(`(() => { activeGrid = true; GRID_STEP = 32; return snapToGrid({ x: 17, y: 23 }); })()`);
    // round(17/32)*32 = round(0.531)*32 = 1*32 = 32
    assertEq(r, { x: 32, y: 32 }, 'snap positif');
});

test('snapToGrid coordonnees negatives', () => {
    const r = probe(`(() => { activeGrid = true; GRID_STEP = 32; return snapToGrid({ x: -17, y: -23 }); })()`);
    // round(-17/32)*32 = -1*32 = -32
    assertEq(r, { x: -32, y: -32 }, 'snap negatif');
});

test('snapToGrid pas personnalise', () => {
    const r = probe(`(() => { activeGrid = true; GRID_STEP = 8; return snapToGrid({ x: 13, y: -3 }); })()`);
    // round(13/8)*8 = 16 ; round(-3/8)*8 = 0
    assertEq(r, { x: 16, y: 0 }, 'GRID_STEP=8 : bord bas reste a 0');
});

test('snapToGrid point deja aligne', () => {
    const r = probe(`(() => { activeGrid = true; GRID_STEP = 32; return snapToGrid({ x: 32, y: -32 }); })()`);
    assertEq(r, { x: 32, y: -32 }, 'point deja aligne ne bouge pas');
});

test('adjacentPoints tolerance', () => {
    const r = probe(`(() => [adjacentPoints({x:0,y:0},{x:0.005,y:0.005},0.01), adjacentPoints({x:0,y:0},{x:1,y:0},0.5), adjacentPoints({x:0,y:0},{x:0,y:0},0.01)])()`);
    assertEq(r, [true, false, true], 'epsilon < tol donne adjacent');
});

test('adjacentPoints epsilon diagonal pile', () => {
    // d == tolerance : NOT adjacent (distance hypot(0.01, 0.01) = sqrt(2)*0.01 ≈ 0.01414 > 0.01)
    const r = probe('adjacentPoints({x:0,y:0},{x:0.01,y:0.01},0.01)');
    assertEq(r, false, 'epsilon diagonal pile = tol ne suffit pas');
});

test('scalarProduct squared norm', () => {
    const r = probe('scalarProduct({x:3,y:4},{x:0,y:0},{x:3,y:4})');
    assertEq(r, 25, 'ps(v,v) = |v|² = 9+16 = 25');
});

test('scalarProduct orthogonal => 0', () => {
    const r = probe('scalarProduct({x:1,y:0},{x:0,y:0},{x:0,y:1})');
    assertEq(r, 0, 'vecteurs orthogonaux => ps = 0');
});

test('computeOrthogonalProjection point sur la ligne', () => {
    const r = probe('computeOrthogonalProjection({x: 5, y: 0}, {x: 0, y: 0}, {x: 10, y: 0})');
    assertEq(r, { x: 5, y: 0 }, 'point sur le segment projette sur lui-meme');
});

test('computeOrthogonalProjection cas perpendiculaire general', () => {
    // (5, 3) projete sur l'axe x (0,0)-(10,0) = (5, 0)
    const r = probe('computeOrthogonalProjection({x: 5, y: 3}, {x: 0, y: 0}, {x: 10, y: 0})');
    assertEq(r, { x: 5, y: 0 }, 'drop la composante y perpendiculaire');
});

test('isInsideSegmentByDot bornes strictes', () => {
    const r = probe(`(() => [isInsideSegmentByDot({x: -1, y: 0}, {x: 0, y: 0}, {x: 10, y: 0}), isInsideSegmentByDot({x: 5, y: 0}, {x: 0, y: 0}, {x: 10, y: 0}), isInsideSegmentByDot({x: 11, y: 0}, {x: 0, y: 0}, {x: 10, y: 0})])()`);
    assertEq(r, [false, true, false], 'segment [0..10] sur x, y=0');
});

test('isInsideSegmentByDot endpoints inclusifs', () => {
    const r = probe(`(() => [isInsideSegmentByDot({x: 0, y: 0}, {x: 0, y: 0}, {x: 10, y: 0}), isInsideSegmentByDot({x: 10, y: 0}, {x: 0, y: 0}, {x: 10, y: 0})])()`);
    assertEq(r, [true, true], 'endpoints firstPoint et secondPoint inclus');
});

// ============================================================
// history.js : cloneTriArray / cloneScene
// ============================================================

test('cloneTriArray produit une COPIE INDEPENDANTE des points', () => {
    const r = probe(`(() => {
        const orig = [{ p1: {x:1,y:1}, p2: {x:2,y:2}, p3: {x:3,y:3} }];
        const cloned = cloneTriArray(orig);
        cloned[0].p1.x = 999;
        return {
            origP1X: orig[0].p1.x,
            clonedP1X: cloned[0].p1.x,
            isSameRef: orig[0].p1 === cloned[0].p1,
        };
    })()`);
    assertEq(r.origP1X, 1, 'original intact apres mutation du clone');
    assertEq(r.clonedP1X, 999, 'clone prend la mutation');
    assertEq(r.isSameRef, false, 'clone doit etre une nouvelle reference');
});

test('cloneTriArray preserve le PARTAGE intra-triangle', () => {
    const r = probe(`(() => {
        const shared = { x: 7, y: 8 };
        const orig = [{ p1: shared, p2: shared, p3: shared }];
        const cloned = cloneTriArray(orig);
        return {
            shareInClone: cloned[0].p1 === cloned[0].p2 && cloned[0].p1 === cloned[0].p3,
            newRefForShared: cloned[0].p1 !== shared,
            valuesMatch: cloned[0].p1.x === 7 && cloned[0].p1.y === 8 && cloned[0].p2.x === 7 && cloned[0].p3.x === 7,
        };
    })()`);
    assertEq(r.shareInClone, true, 'p1/p2/p3 partagent une nouvelle ref dans le clone');
    assertEq(r.newRefForShared, true, 'la ref partagee d\'origine n\'est pas partagee apres clonage');
    assertEq(r.valuesMatch, true, 'les valeurs x,y sont recopiees');
});

test('cloneTriArray preserve les triangles partiels (p2===undefined)', () => {
    const r = probe(`(() => {
        const orig = [{ p1: {x:1,y:1}, p2: undefined, p3: undefined }];
        const cloned = cloneTriArray(orig);
        return {
            p1X: cloned[0].p1.x,
            p1Y: cloned[0].p1.y,
            p2Undefined: cloned[0].p2 === undefined,
            p3Undefined: cloned[0].p3 === undefined,
            p1IsNew: cloned[0].p1 !== orig[0].p1,
        };
    })()`);
    assertEq(r.p1X, 1, 'p1.x preserve');
    assertEq(r.p1Y, 1, 'p1.y preserve');
    assertEq(r.p2Undefined, true, 'p2 absent preserve');
    assertEq(r.p3Undefined, true, 'p3 absent preserve');
    assertEq(r.p1IsNew, true, 'p1 est bien une nouvelle ref');
});

test('cloneScene isole les formes entre elles', () => {
    const r = probe(`(() => {
        const sharedPt = { x: 1, y: 1 };
        const orig = [
            { triangles: [{ p1: sharedPt, p2: sharedPt, p3: sharedPt }] },
            { triangles: [{ p1: sharedPt, p2: sharedPt, p3: sharedPt }] },
        ];
        const cloned = cloneScene(orig);
        cloned[0].triangles[0].p1.x = 999;
        return {
            orig0P1X: orig[0].triangles[0].p1.x,
            orig1P1X: orig[1].triangles[0].p1.x,
            cloned0P1X: cloned[0].triangles[0].p1.x,
            cloned1P1X: cloned[1].triangles[0].p1.x,
            shape0NewRef: cloned[0].triangles[0].p1 !== sharedPt,
            shape1NewRef: cloned[1].triangles[0].p1 !== sharedPt,
            shapesIsolated: cloned[0].triangles[0].p1 !== cloned[1].triangles[0].p1,
        };
    })()`);
    assertEq(r.orig0P1X, 1, 'forme 0 d\'origine intouchee');
    assertEq(r.orig1P1X, 1, 'forme 1 d\'origine intouchee (pas de fuite cross-shape)');
    assertEq(r.cloned0P1X, 999, 'clone prend la mutation sur la forme 0');
    assertEq(r.cloned1P1X, 1, 'forme 1 du clone isolee');
    assertEq(r.shape0NewRef, true, 'forme 0 sur nouvelles refs');
    assertEq(r.shape1NewRef, true, 'forme 1 sur nouvelles refs');
    assertEq(r.shapesIsolated, true, 'forme 0 et 1 du clone independantes');
});

test('cloneScene input vide', () => {
    const r = probe('cloneScene([])');
    assertEq(r, [], 'cloneScene([]) renvoie []');
});

test('cloneScene preserve le compte de triangles par forme', () => {
    const r = probe(`(() => {
        const orig = [
            { triangles: [{ p1: {x:1,y:1}, p2:{x:2,y:2}, p3:{x:3,y:3} }, { p1: {x:4,y:4}, p2:undefined, p3:undefined }] },
            { triangles: [] },
        ];
        const cloned = cloneScene(orig);
        return {
            shape0Count: cloned[0].triangles.length,
            shape0Idx1IsPartial: cloned[0].triangles[1].p2 === undefined,
            shape1Empty: cloned[1].triangles.length === 0,
        };
    })()`);
    assertEq(r.shape0Count, 2, 'count de triangles de la forme 0');
    assertEq(r.shape0Idx1IsPartial, true, 'triangle partiel (p2 undefined) preserve');
    assertEq(r.shape1Empty, true, 'forme vide reste vide');
});

// ============================================================
// Run
// ============================================================

let passed = 0;
let failed = 0;
for (const t of tests) {
    try {
        t.fn();
        console.log('  PASS  ' + t.name);
        passed++;
    } catch (e) {
        console.error('  FAIL  ' + t.name + ' — ' + e.message);
        failed++;
    }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed (' + tests.length + ' total)');
process.exit(failed === 0 ? 0 : 1);
