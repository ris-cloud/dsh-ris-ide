/**
 * External-command probes for the test suite.
 *
 * The suite must not hard-depend on programs the CI pod may not have (Jenkins runs
 * the bare image: no git, no bash). A test that really exercises an external
 * program declares `{ skip: skipWithout(HAS_X, 'x') }` so it reports a skip with a
 * reason instead of failing with ENOENT — the assertion is never weakened, the
 * test simply does not run where its subject does not exist.
 */
import { spawnSync } from 'node:child_process'

/** True when `name` exists on PATH and exits 0 for `args`. */
export function hasCommand(name, args = ['--version']) {
  try {
    return spawnSync(name, args, { stdio: 'ignore', windowsHide: true }).status === 0
  } catch {
    return false
  }
}

export const HAS_GIT = hasCommand('git')
export const HAS_BASH = hasCommand('bash', ['-c', 'true'])
/** WSL 上把 Linux 路径翻成 Windows 形式要靠它；普通 Linux 用 lib 的测试接缝替代。 */
export const HAS_WSLPATH = hasCommand('wslpath', ['-w', '/tmp'])

/** node:test `skip` value: false when available, else the reason string. */
export function skipWithout(available, label) {
  return available === true ? false : `${label} is not installed`
}
