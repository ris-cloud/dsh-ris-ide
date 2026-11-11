// Per-resource lifecycle policy: whether each of the four things the daemon runs
// follows a dsh session. Following the daemon is NOT configurable: stopping the
// daemon always stops everything it supervises (m07741) - a resource that outlives
// its supervisor would have no page left to stop it.
//
// The defaults are the shape the product had before this setting existed: the
// proxy follows dsh (its lease keeps the tunnel alive) and programs/debug keep
// running when the last dsh window closes, because the maintenance page can be the
// only UI on the machine.
//
// Following dsh is two-sided: with `proxy.followDsh` on, the engine starts when a
// dsh attaches and the tunnel is torn down when the last one leaves. The start half
// is never an elevation request — an automatic start must not pop a password dialog
// (m13910) — so a bridge that needs root is only reported on the page.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Stored beside risd.json/proxy.json in the daemon's home. */
export const LIFECYCLE_FILENAME = 'risd-lifecycle.json'

/** The four resources the page lets you tune, in page order. */
export const LIFECYCLE_RESOURCES = ['daemon', 'proxy', 'programs', 'debug']

/** Defaults: everything follows dsh except programs/debug, which outlive the window. */
export const LIFECYCLE_DEFAULTS = {
  daemon: { followDsh: true },
  proxy: { followDsh: true },
  programs: { followDsh: false },
  debug: { followDsh: false },
}

/** Keys that used to be configurable and are now forced (m07741). */
const FORCED_KEYS = ['followDaemon']

/** @param home - daemon home directory. */
export function lifecyclePath(home) {
  return join(home, LIFECYCLE_FILENAME)
}

function bool(value) { return typeof value === 'boolean' ? value : undefined }

/**
 * Merge `input` over the defaults, keeping only known resources and booleans.
 * @param input - untrusted (file or request body).
 * @returns `{ value, errors, changed }`.
 */
export function normalizeLifecycle(input) {
  const errors = []
  const value = {}
  const seen = input !== null && typeof input === 'object' ? input : {}
  if (input !== undefined && input !== null && typeof input !== 'object') {
    errors.push('lifecycle 必须是对象')
  }
  for (const key of Object.keys(seen)) {
    if (LIFECYCLE_RESOURCES.includes(key)) continue
    // A payload for an unknown resource used to be saved as nothing at all.
    errors.push(`${key} 不是生命周期资源（可用：${LIFECYCLE_RESOURCES.join('/')}）`)
  }
  for (const resource of LIFECYCLE_RESOURCES) {
    const defaults = LIFECYCLE_DEFAULTS[resource]
    const given = seen[resource]
    if (given === undefined) { value[resource] = Object.assign({}, defaults); continue }
    if (given === null || typeof given !== 'object') {
      errors.push(`${resource} 必须是对象`)
      value[resource] = Object.assign({}, defaults)
      continue
    }
    const allowed = Object.keys(defaults)
    for (const key of Object.keys(given)) {
      if (allowed.includes(key) || FORCED_KEYS.includes(key)) continue
      // Silently ignoring an unknown key made a typo look saved (review A2-P2-5).
      errors.push(`${resource}.${key} 不是可配置项（只能配置 ${allowed.join('/')}）`)
    }
    for (const key of FORCED_KEYS) {
      if (given[key] !== undefined) {
        errors.push(`${resource}.${key} 不再支持：所有资源强制跟随 daemon（只能配置 followDsh）`)
      }
    }
    const merged = Object.assign({}, defaults)
    for (const key of Object.keys(defaults)) {
      const parsed = bool(given[key])
      if (given[key] === undefined) continue
      if (parsed === undefined) { errors.push(`${resource}.${key} 必须是 true/false`); continue }
      merged[key] = parsed
    }
    value[resource] = merged
  }
  return { value, errors, changed: errors.length === 0 }
}

/**
 * Merge a partial policy over the current one.
 *
 * `POST /v1/config` used to normalize the body alone, which silently reset the
 * other three resources to their defaults whenever a caller saved one checkbox
 * (review A2-P2-1).
 * @param current - the policy in force.
 * @param patch - only the resources/keys the caller means to change.
 * @returns a full policy object for {@link writeLifecycle}.
 */
export function mergeLifecycle(current, patch) {
  const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const next = {}
  for (const resource of LIFECYCLE_RESOURCES) {
    const defaults = LIFECYCLE_DEFAULTS[resource]
    const existing = base[resource] !== null && typeof base[resource] === 'object' && !Array.isArray(base[resource])
      ? base[resource]
      : {}
    next[resource] = Object.assign({}, defaults, existing)
  }
  if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      // An unknown resource is copied through on purpose: normalizeLifecycle is the
      // single validator and must be able to reject it with a message instead of
      // this merge silently dropping it (review A3-P1-2). Same for a non-object
      // resource value (`{proxy:true}`) and unknown inner keys.
      if (!LIFECYCLE_RESOURCES.includes(key)) { next[key] = value; continue }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(next[key], value)
      } else {
        next[key] = value
      }
    }
  }
  return next
}

/** Read the policy, tolerating a missing or broken file (defaults win). */
export function readLifecycle(home) {
  const path = lifecyclePath(home)
  if (!existsSync(path)) return { value: normalizeLifecycle({}).value, path, exists: false, errors: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const normalized = normalizeLifecycle(parsed !== null && typeof parsed === 'object' ? parsed : {})
    return { value: normalized.value, path, exists: true, errors: normalized.errors }
  } catch {
    return { value: normalizeLifecycle({}).value, path, exists: true, errors: ['lifecycle 文件无法解析，已按默认值运行'] }
  }
}

/**
 * Persist the policy atomically (tmp + rename, 0600).
 * @returns the normalized value actually written.
 */
export function writeLifecycle(home, input) {
  const normalized = normalizeLifecycle(input)
  if (normalized.changed !== true) return { value: readLifecycle(home).value, errors: normalized.errors }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = lifecyclePath(home)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(normalized.value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  return { value: normalized.value, errors: [] }
}
