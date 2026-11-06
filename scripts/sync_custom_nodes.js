// (fix 866) Self-heal for the studio's bundled custom nodes.
//
// install.ps1 copies "custom nodes\*" into <ComfyUI>\ComfyUI\custom_nodes only at
// install time, and the in-app updater (apply_update.ps1) never touches ComfyUI.
// Users who update in-app (e.g. to 7.1.11, which added MiniMaxStudioLoop) end up
// with workflows referencing nodes their ComfyUI has never imported:
//   HTTP 400 missing_node_type, class_type 'MiniMaxStudioLoop'.
//
// Fix: re-sync before EVERY ComfyUI launch. Called from electron/main.js
// (startComfy) and from start.bat. Runs from the freshly updated app files, so
// the fix itself travels inside the update zip - no reinstall needed.
//
// Strategy: for each folder in "<app>\custom nodes", compare a recursive
// content hash (relpath + bytes) with the copy in custom_nodes; when missing or
// different, replace the copy. Folders here are tiny (<150 KB total), so the
// hash is cheap and runs in milliseconds.
//
// Usage: node scripts\sync_custom_nodes.js [comfyRoot]
//        (omitted -> resolved from config\config.ini [comfy] comfy_dir,
//         then %COMFY_ROOT%, then 'ComfyUI-Easy-Install' - same rules as
//         electron/main.js (fix 567) and start.bat).

'use strict'

const { existsSync, readFileSync, readdirSync, statSync, rmSync, cpSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function resolveComfyRoot(appRoot) {
  let configured = ''
  try {
    let section = ''
    for (const line of readFileSync(path.join(appRoot, 'config', 'config.ini'), 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith(';')) continue
      const sec = /^\[([^\]]+)\]$/.exec(t)
      if (sec) { section = sec[1].toLowerCase(); continue }
      const eq = t.indexOf('=')
      if (section === 'comfy' && eq > 0 && t.slice(0, eq).trim().toLowerCase() === 'comfy_dir') {
        configured = t.slice(eq + 1).trim().replace(/"/g, '')
        break
      }
    }
  } catch { /* fall through to env/default */ }
  const raw = configured || (process.env.COMFY_ROOT || '').trim() || 'ComfyUI-Easy-Install'
  return path.resolve(appRoot, raw)
}

function dirHash(dir) {
  const h = crypto.createHash('sha256')
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name)
      if (statSync(p).isDirectory()) walk(p, rel + name + '/')
      else h.update(rel + name + ':').update(readFileSync(p))
    }
  }
  walk(dir, '')
  return h.digest('hex')
}

/**
 * Sync "<appRoot>\custom nodes\*" into "<comfyRoot>\ComfyUI\custom_nodes".
 * Returns the names of node packs that were (re)installed.
 * Never throws on a single pack - failures are reported on stderr.
 */
function syncStudioNodes(appRoot, comfyRoot) {
  const synced = []
  const srcRoot = path.join(appRoot, 'custom nodes')
  const dstRoot = path.join(comfyRoot, 'ComfyUI', 'custom_nodes')
  if (!existsSync(srcRoot) || !existsSync(dstRoot)) return synced
  for (const name of readdirSync(srcRoot)) {
    const src = path.join(srcRoot, name)
    try {
      if (!statSync(src).isDirectory()) continue
      const dst = path.join(dstRoot, name)
      if (existsSync(dst)) {
        let same = false
        try { same = dirHash(src) === dirHash(dst) } catch { same = false }
        if (same) continue
        rmSync(dst, { recursive: true, force: true })
      }
      cpSync(src, dst, { recursive: true })
      synced.push(name)
    } catch (err) {
      console.error(`[custom-nodes] ${name}: ${err && err.message ? err.message : err}`)
    }
  }
  return synced
}

module.exports = { syncStudioNodes, resolveComfyRoot }

if (require.main === module) {
  const appRoot = path.resolve(__dirname, '..')
  const comfyRoot = process.argv[2] || resolveComfyRoot(appRoot)
  const synced = syncStudioNodes(appRoot, comfyRoot)
  if (synced.length) console.log('[custom-nodes] installed: ' + synced.join(', '))
}
