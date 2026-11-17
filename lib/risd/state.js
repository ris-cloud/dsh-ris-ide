/**
 * risd — persistent state (`<home>/risd.json`) and the spawn lock.
 *
 * The DAEMON is the only writer. Plugins and the CLI only read: a missing or
 * unparseable file simply means "no daemon", never an error. The token in this
 * file is the only credential the daemon accepts, which is why the file is
 * written 0600 into a 0700 directory and replaced atomically (tmp + rename) —
 * a reader must see either the old state or the new one, never half of each.
 *
 * @module dsh-risd/state
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { proxyHomeDir } from '../proxy.js'

/** API contract version. Bumped only on a breaking `/v1` change. */
export const RISD_API_VERSION = 1
export const RISD_STATE_FILENAME = 'risd.json'
export const RISD_LOCK_FILENAME = 'risd.spawn.lock'
/** A spawn lock older than this is stale: the process that took it is gone. */
export const SPAWN_LOCK_STALE_MS = 10_000
export const DEFAULT_RISD_PORT = 11082

/**
 * Where the daemon keeps its state, honouring the same home override the proxy
 * engine uses (`DSH_RIS_IDE_PROXY_HOME`), so tests and odd setups only ever
 * have to set one variable.
 * @param home - explicit home; defaults to the machine-level proxy home.
 * @returns absolute directory.
 */
export function risdHomeDir(home = proxyHomeDir()) {
  // `process.env.X = undefined` stores the STRING "undefined" (Node coerces), so a
  // CLI run without --home used to plant `<cwd>/undefined/` and the plugin could
  // never find the daemon. Treat empty/non-string/"undefined" as "not given".
  if (typeof home !== 'string' || home === '' || home === 'undefined') return proxyHomeDir()
  return home
}

export function risdStatePath(home = proxyHomeDir()) {
  return join(home, RISD_STATE_FILENAME)
}

export function risdLockPath(home = proxyHomeDir()) {
  return join(home, RISD_LOCK_FILENAME)
}

/**
 * Read the daemon state file.
 * @param home - daemon home.
 * @returns the parsed state, or null when absent/unreadable/corrupt.
 */
export function readRisdState(home = proxyHomeDir()) {
  try {
    const raw = JSON.parse(readFileSync(risdStatePath(home), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Atomically replace the state file (0600, directory 0700).
 * @param state - state to persist.
 * @param home - daemon home.
 */
export function writeRisdState(state, home = proxyHomeDir()) {
  const path = risdStatePath(home)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Remove the state file (shutdown, or cleaning up a failed start). */
export function removeRisdState(home = proxyHomeDir()) {
  rmSync(risdStatePath(home), { force: true })
}

/** 32 random bytes as hex: enough entropy that the token never needs rotating. */
export function newRisdToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Take the spawn lock (`O_EXCL`) so two dsh instances racing to start risd do
 * not both fork a server. The lock is advisory — daemon-side EADDRINUSE is what
 * makes single-instance hold — it only avoids the useless double spawn.
 * @param home - daemon home.
 * @param ownerPid - the process taking the lock.
 * @returns true when this process now holds the lock.
 */
export function acquireSpawnLock(home = proxyHomeDir(), ownerPid = process.pid) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(risdLockPath(home), 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: ownerPid, at: new Date().toISOString() })}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

export function releaseSpawnLock(home = proxyHomeDir()) {
  rmSync(risdLockPath(home), { force: true })
}

/**
 * Age of the current spawn lock.
 * @param home - daemon home.
 * @returns milliseconds since the lock was last written, or null when absent.
 */
export function spawnLockAgeMs(home = proxyHomeDir()) {
  try {
    return Math.max(0, Date.now() - statSync(risdLockPath(home)).mtimeMs)
  } catch {
    return null
  }
}

/**
 * Remove the spawn lock if nobody has refreshed it for `staleMs`.
 * @returns true when a stale lock was removed.
 */
export function dropStaleSpawnLock(home = proxyHomeDir(), staleMs = SPAWN_LOCK_STALE_MS) {
  const age = spawnLockAgeMs(home)
  if (age === null || age < staleMs) return false
  releaseSpawnLock(home)
  return true
}
