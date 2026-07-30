// Rationale : voir DESIGN.md §3.2

import { log } from './log.js'
import { importMeshFromText } from './io.js'

export const parsePair = (token) => {
    let parts = token.split(',')
    if (parts.length !== 2) return undefined
    let x = Number(parts[0])
    let y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x: x, y: y }
}

export const ensurePointIndex = (pointList, pointIndexByKey, x, y) => {
    let key = x + ',' + y
    let idx = pointIndexByKey.get(key)
    if (idx !== undefined) return idx
    idx = pointList.length
    pointList.push({ x: x, y: y })
    pointIndexByKey.set(key, idx)
    return idx
}

export const convertMeshesLineToMesh = (line) => {
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
                p3: ensurePointIndex(pointList, pointIndexByKey, buffer[2].x, buffer[2].y),
            })
            buffer = []
        }
    }
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

export const convertMeshesToMeshes = (text) => {
    return String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => convertMeshesLineToMesh(line))
}

export const importMeshesFromFile = (file) => {
    if (!file) return
    if (file.size === 0) {
        log('Import meshes fail: file empty')
        return
    }
    let reader = new FileReader()
    reader.onload = (e) => {
        try {
            let text = String(e.target.result)
            let semicolons = (text.match(/;/g) || []).length
            if (semicolons < 3) {
                log('Import meshes fail: format inattendu (peu ou pas de ; separateurs)')
                return
            }
            let meshes = convertMeshesToMeshes(text)
            if (!meshes.length) {
                log('Import meshes fail: aucun mesh trouve')
                return
            }
            let shapePayload = meshes.map((m) => ({ tris: m.tris, pointList: m.pointList }))
            let json = JSON.stringify({ shapes: shapePayload, activeShapeIndex: 0 })
            importMeshFromText(json)
            let totalTris = meshes.reduce((acc, m) => acc + m.tris.length, 0)
            let totalPts = meshes.reduce((acc, m) => acc + m.pointList.length, 0)
            log('Import meshes OK: ' + meshes.length + ' forme(s), ' + totalTris + ' triangles, ' + totalPts + ' sommets')
        } catch (err) {
            log('Import meshes fail: ' + err.message)
        }
    }
    reader.onerror = () => log('Import meshes fail: read error')
    reader.readAsText(file)
}

export const autoImportMeshesFromUrl = () => {
    if (typeof window === 'undefined') return
    try {
        let params = new URLSearchParams(window.location.search)
        let encoded = params.get('autoimport')
        if (!encoded) return
        let text = atob(decodeURIComponent(encoded))
        let meshes = convertMeshesToMeshes(text)
        if (!meshes.length) {
            log('Autoimport: empty')
            return
        }
        let shapePayload = meshes.map((m) => ({ tris: m.tris, pointList: m.pointList }))
        let json = JSON.stringify({ shapes: shapePayload, activeShapeIndex: 0 })
        importMeshFromText(json)
        let totalTris = meshes.reduce((acc, m) => acc + m.tris.length, 0)
        log('Autoimport: ' + meshes.length + ' forme(s), ' + totalTris + ' triangles')
    } catch (e) {
        log('Autoimport fail: ' + e.message)
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('load', autoImportMeshesFromUrl)
}
