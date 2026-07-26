// ---------------------------------------------------------------
// convert.js
//
// Convertit des mesh depuis le format "alphabet2" vers le format
// JSON reconnu par le mesh-designer (cf. serializeState() dans
// main.js et importMeshFromText()).
//
// Format source "alphabet2" (un mesh par ligne):
//   "x1,y1;x2,y2;x3,y3;x4,y4;..."
//   Chaque triplet consecutif forme un triangle. Si la ligne se
//   termine par 1 ou 2 points, un triangle partiel est emis.
//
// Format JSON cible:
//   { "tris": [{"p1","p2","p3"}], "pointList": [{"x","y"}] }
// ---------------------------------------------------------------

// Renvoie { x, y } a partir d'un token "x,y" ou undefined si invalide.
parsePair = (token) => {
    let parts = token.split(',')
    if (parts.length !== 2) return undefined
    let x = Number(parts[0])
    let y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x: x, y: y }
}

// Insere/Trouve un point dans pointList (cle "x,y").
ensurePointIndex = (pointList, pointIndexByKey, x, y) => {
    let key = x + ',' + y
    let idx = pointIndexByKey.get(key)
    if (idx !== undefined) return idx
    idx = pointList.length
    pointList.push({ x: x, y: y })
    pointIndexByKey.set(key, idx)
    return idx
}

// Convertit UNE ligne alphabet2 en JSON {tris, pointList}.
convertAlphabet2LineToMesh = (line) => {
    let tris = []
    let pointList = []
    let pointIndexByKey = new Map()
    let buffer = []

    let cleaned = String(line).trim().replace(/^["']|["']$/g, '')
    if (!cleaned) return { tris: tris, pointList: pointList }

    let tokens = cleaned.split(';')
    for (let i = 0; i < tokens.length; i++) {
        let raw = tokens[i].trim().replace(/^["']|["']$/g, '')
        if (!raw) continue
        let p = parsePair(raw)
        if (!p) continue
        buffer.push(p)
        if (buffer.length === 3) {
            tris.push({
                p1: ensurePointIndex(pointList, pointIndexByKey, buffer[0].x, buffer[0].y),
                p2: ensurePointIndex(pointList, pointIndexByKey, buffer[1].x, buffer[1].y),
                p3: ensurePointIndex(pointList, pointIndexByKey, buffer[2].x, buffer[2].y)
            })
            buffer = []
        }
    }
    // Triangle partiel en queue (1 ou 2 points).
    if (buffer.length > 0) {
        let partial = {}
        partial.p1 = ensurePointIndex(pointList, pointIndexByKey, buffer[0].x, buffer[0].y)
        if (buffer.length >= 2) {
            partial.p2 = ensurePointIndex(pointList, pointIndexByKey, buffer[1].x, buffer[1].y)
        }
        tris.push(partial)
    }
    return { tris: tris, pointList: pointList }
}

// Convertit un texte multi-lignes en tableau de mesh JSON.
convertAlphabet2ToMeshes = (text) => {
    return String(text)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => convertAlphabet2LineToMesh(line))
}

// Fusionne plusieurs mesh JSON en un seul, en reconciliant les indices.
// Entree : tableau de { tris, pointList }.
// Sortie : { tris, pointList } unique.
mergeAlphabet2Meshes = (meshes) => {
    let tris = []
    let pointList = []
    meshes.forEach(m => {
        let offset = pointList.length
        if (Array.isArray(m.pointList)) {
            m.pointList.forEach(p => pointList.push({ x: Number(p.x), y: Number(p.y) }))
        }
        if (Array.isArray(m.tris)) {
            m.tris.forEach(t => {
                let nt = {}
                if (t.p1 !== undefined) nt.p1 = Number(t.p1) + offset
                if (t.p2 !== undefined) nt.p2 = Number(t.p2) + offset
                if (t.p3 !== undefined) nt.p3 = Number(t.p3) + offset
                tris.push(nt)
            })
        }
    })
    return { tris: tris, pointList: pointList }
}

// Lit un fichier alphabet2, le convertit, fusionne les mesh et
// appelle importMeshFromText (definie dans main.js) avec le JSON final.
importAlphabet2FromFile = (file) => {
    if (!file) return
    if (file.size === 0) {
        log('Import alphabet2 fail: file empty')
        return
    }
    let reader = new FileReader()
    reader.onload = (e) => {
        try {
            let text = String(e.target.result)
            // Heuristique alphabet2: il y a beaucoup de points-virgules
            // (separateurs de coordonnees). Si le fichier n'en a aucun,
            // ce n'est clairement pas le bon format.
            let semicolons = (text.match(/;/g) || []).length
            if (semicolons < 3) {
                log('Import alphabet2 fail: format inattendu (peu ou pas de ; separateurs)')
                return
            }
            let meshes = convertAlphabet2ToMeshes(text)
            if (!meshes.length) {
                log('Import alphabet2 fail: aucun mesh trouve')
                return
            }
            let merged = mergeAlphabet2Meshes(meshes)
            let json = JSON.stringify({ tris: merged.tris, pointList: merged.pointList })
            importMeshFromText(json)
            log('Import alphabet2 OK: ' + meshes.length + ' mesh(es), ' + merged.tris.length + ' triangles, ' + merged.pointList.length + ' sommets')
        } catch (err) {
            log('Import alphabet2 fail: ' + err.message)
        }
    }
    reader.onerror = () => log('Import alphabet2 fail: read error')
    reader.readAsText(file)
}

// Point d'entree "auto-import" depuis l'URL: ?autoimport=<base64-urlsafe>.
// Pratique pour les tests headless (le picker natif n'est pas scriptable).
autoImportAlphabet2FromUrl = () => {
    if (typeof window === 'undefined') return
    try {
        let params = new URLSearchParams(window.location.search)
        let encoded = params.get('autoimport')
        if (!encoded) return
        let text = atob(decodeURIComponent(encoded))
        let meshes = convertAlphabet2ToMeshes(text)
        if (!meshes.length) {
            log('Autoimport: empty')
            return
        }
        let merged = mergeAlphabet2Meshes(meshes)
        let json = JSON.stringify({ tris: merged.tris, pointList: merged.pointList })
        importMeshFromText(json)
        log('Autoimport: ' + meshes.length + ' mesh(es), ' + merged.tris.length + ' triangles')
    } catch (e) {
        log('Autoimport fail: ' + e.message)
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('load', autoImportAlphabet2FromUrl)
}
