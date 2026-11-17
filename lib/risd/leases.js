/**
 * risd — session leases.
 *
 * A lease says "a live dsh process is using the proxy". It replaces the old
 * "the proxy lives exactly as long as dsh" binding: the daemon polls each
 * ownerPid every 3s, so Ctrl+C, SIGKILL, a crash and a hot reload all collapse
 * into the same observation — the pid is gone — and every teardown decision
 * (keepPolicy=session) becomes a consequence of that, not of catching an exit
 * signal.
 *
 * Identity is `(ownerPid, sessionId, cwd)` so a session can re-acquire after a
 * reconnect without duplicating itself; the id is random because it is what the
 * plugin sends back on release.
 *
 * @module dsh-risd/leases
 */
import { randomUUID } from 'node:crypto'
import { pidAlive } from '../proxy.js'

export const LEASE_POLL_MS = 3000

function keyOf(ownerPid, sessionId, cwd) {
  return `${ownerPid}\u0000${sessionId ?? ''}\u0000${cwd ?? ''}`
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/**
 * @param options - `{ pollMs, alive, onGone }`; `alive` is injectable for tests.
 * @returns the registry: `acquire / release / list / snapshot / sweep / start / stop`.
 */
export function createLeaseRegistry({ pollMs = LEASE_POLL_MS, alive = pidAlive, onGone = () => {} } = {}) {
  /** @type {Map<string, object>} */
  const byId = new Map()
  /** @type {Map<string, object>} */
  const byKey = new Map()
  let timer = null

  function drop(lease) {
    byId.delete(lease.id)
    byKey.delete(lease.key)
  }

  function sweep(now = Date.now()) {
    const gone = []
    for (const lease of byId.values()) {
      if (!alive(lease.ownerPid)) {
        drop(lease)
        gone.push(lease)
      }
    }
    for (const lease of gone) {
      try {
        onGone(lease)
      } catch {
        /* a callback must not break the sweep */
      }
    }
    return gone
  }

  return {
    /**
     * Create (or refresh) the lease for one owner/session/workspace.
     * @param input - `{ ownerPid, sessionId?, cwd? }`.
     * @returns the lease (a copy).
     */
    acquire({ ownerPid, sessionId = null, cwd = null }, now = Date.now()) {
      const key = keyOf(ownerPid, sessionId, cwd)
      const existing = byKey.get(key)
      if (existing !== undefined) {
        existing.heartbeatAt = iso(now)
        return { ...existing }
      }
      const lease = {
        id: randomUUID(),
        key,
        ownerPid,
        sessionId,
        cwd,
        createdAt: iso(now),
        heartbeatAt: iso(now),
      }
      byId.set(lease.id, lease)
      byKey.set(key, lease)
      return { ...lease }
    },

    /** @returns true when a lease with that id existed. */
    release(id) {
      const lease = byId.get(String(id))
      if (lease === undefined) return false
      drop(lease)
      return true
    },

    list() {
      return [...byId.values()].map((lease) => ({ ...lease }))
    },

    count() {
      return byId.size
    },

    sweep,

    start() {
      if (timer === null) {
        timer = setInterval(() => sweep(), pollMs)
        timer.unref?.()
      }
      return timer
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
