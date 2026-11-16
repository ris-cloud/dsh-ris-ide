/**
 * risd — `risd.log`, the daemon's only output channel.
 *
 * The daemon may be started detached by a plugin that immediately forgets about
 * it, so it cannot rely on stdio: it appends one line per event and rotates the
 * file once it passes `maxBytes`. Writes are synchronous and best-effort — a
 * daemon that cannot log must still serve.
 *
 * @module dsh-risd/log
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { proxyHomeDir } from '../proxy.js'

export const RISD_LOG_FILENAME = 'risd.log'
export const RISD_LOG_MAX_BYTES = 10 * 1024 * 1024

export function risdLogPath(home = proxyHomeDir()) {
  return join(home, RISD_LOG_FILENAME)
}

/**
 * @param home - daemon home.
 * @param options - `{ maxBytes }`.
 * @returns `{ path, info, warn, error }` — line-oriented, never throws.
 */
export function createRisdLogger(home = proxyHomeDir(), { maxBytes = RISD_LOG_MAX_BYTES } = {}) {
  const path = risdLogPath(home)

  function rotate() {
    try {
      if (statSync(path).size < maxBytes) return
      rmSync(`${path}.1`, { force: true })
      renameSync(path, `${path}.1`)
    } catch {
      /* no file yet / rotate raced another writer: the append below is what matters */
    }
  }

  function write(level, message) {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      // The home may not exist yet on a first start; without this the first lines
      // vanished silently (review A-P2-12).
      mkdirSync(home, { recursive: true, mode: 0o700 })
      rotate()
      appendFileSync(path, line, { mode: 0o600 })
    } catch {
      /* logging must never take the daemon down */
    }
  }

  return {
    path,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
