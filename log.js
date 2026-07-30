import { state } from './state.js'

export const log = (message) => {
    if (!state.messageLog) return
    let d = new Date()
    let pad = (n) => String(n).padStart(2, '0')
    let ts = '[' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ']'
    state.messageLog.innerText += '\n' + ts + ' ' + message
}

export const logBoth = (message) => {
    log(message)
    console.log(message)
}
