#!/usr/bin/env bash
#
# dsh-ris-ide — run a command with its output mirrored into a log file that
# the sidebar's `.log` viewer can follow live.
#
#   run-with-log.sh <log-name> <command> [args...]
#   run-with-log.sh ris-model java -cp "target/classes:$(cat target/cp.txt)" Main
#
# It prints one line BEFORE starting anything:
#
#   LOG_FILE=/abs/path/to/ris-model.log
#
# and that path is what you hand to the sidebar opener (the model tool
# `sidebar_open`, which opens it in the calling conversation's sidebar):
#   sidebar_open(target: '/abs/path/to/ris-model.log', title: 'ris-model 日志')
#
# Output is mirrored with `tee`, so the terminal session (and a background
# job's job_output) still see everything the service prints — the file is an
# addition, not a redirection. The file is created immediately (a `--- started
# ---` banner is written first), so the path already exists and is valid to open
# before the service prints its first line.
#
# Why a file at all: the sidebar's own file reader returns the file HEAD (first
# 512 KiB), so for a long-running log the newest lines would be missing; the
# sidebar viewer prefers this plugin's tail route (last N bytes) and falls back
# to the head reader only when the tail route is unavailable.
#
# Stop button: this script also writes `<log>.pid` — one line of
# `<servicePid> <wrapperPid> <epochMs> [<stopGraceMs>]`. The viewer's "停止服务" button POSTs
# `<page-base>/dsh-ris-ide/stop` with the log path; the host route reads that
# pidfile, verifies the PID really is this script, TERMs THIS wrapper, and this
# trap forwards the signal to the service child (TERM → 50×100 ms grace → KILL),
# removes the pidfile and exits. Nothing ever signals a PID the browser chose.
#
# Env:
#   DSH_LOG_DIR    directory for the log file (default: <cwd>/logs)
#   DSH_LOG_STAMP  1 = per-run file name `<name>-YYYYmmdd-HHMMSS.log`
#                  (default: one stable `<name>.log`, appended across runs)
#
# Exit status is the wrapped command's own.

set -uo pipefail

if [[ $# -lt 2 ]]; then
  printf 'usage: run-with-log.sh <log-name> <command> [args...]\n' >&2
  exit 2
fi

log_name="$1"
shift
log_dir="${DSH_LOG_DIR:-$PWD/logs}"
mkdir -p "$log_dir" || exit 1

if [[ "${DSH_LOG_STAMP:-0}" == "1" ]]; then
  log_file="$log_dir/${log_name}-$(date +%Y%m%d-%H%M%S).log"
else
  log_file="$log_dir/${log_name}.log"
fi
# Absolute, because the sidebar opener and the tail route must agree on the
# same path no matter what the current directory is later.
log_file="$(cd "$(dirname "$log_file")" && printf '%s/%s' "$PWD" "$(basename "$log_file")")"

printf -- '--- %s started %s ---\n' "$log_name" "$(date -Is 2>/dev/null || date)" >>"$log_file" || exit 1
printf 'LOG_FILE=%s\n' "$log_file"
printf -- '--- command: %s ---\n' "$*" >>"$log_file"

# Start the service in the background so we know ITS pid, and mirror its output
# through tee. The pidfile next to the log is what the plugin's stop button
# reads — one line: "<servicePid> <wrapperPid> <epochMs>".
"$@" > >(tee -a "$log_file") 2>&1 &
child=$!
pid_file="$log_file.pid"
# 4th field (optional): the stop grace the host should honor, so a per-program
# `stopGraceMs` from the generated config survives until the stop happens.
printf '%s %s %s %s\n' "$child" "$$" "$(date +%s%3N 2>/dev/null || echo 0)" "${DSH_STOP_GRACE_MS:-}" >"$pid_file"

# The plugin signals THIS wrapper (never the service directly). A plain
# `kill $child` is not enough for dev servers: the child is usually a runner
# (`bash -lc ... && exec pnpm run dev`) and pnpm does NOT forward SIGTERM, so the
# real process (`sh -c vite` → node/vite) survives, keeps its port, and the next
# start finds the port busy. The plugin spawns this wrapper detached, so the
# wrapper leads its own process group and every descendant inherits it — signal
# the GROUP instead. When run by hand from a shell (not a group leader) we keep
# signalling only the child, so a manual run never touches unrelated processes.
own_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
group_leader=0
if [[ -n "$own_pgid" && "$own_pgid" == "$$" ]]; then group_leader=1; fi

signal_tree() {
  local sig="$1" target="$child"
  if [[ "$group_leader" == "1" ]]; then target="-$own_pgid"; fi
  kill -s "$sig" -- "$target" 2>/dev/null
}

# Last resort after the grace loop: KILL whatever is left in the group, but
# never ourselves (a SIGKILL to the wrapper would skip the pidfile cleanup).
kill_remaining() {
  if [[ "$group_leader" != "1" ]] || ! command -v pgrep >/dev/null 2>&1; then
    kill -s KILL "$child" 2>/dev/null
    return
  fi
  local pid
  for pid in $(pgrep -g "$own_pgid" 2>/dev/null); do
    [[ "$pid" == "$$" ]] && continue
    kill -s KILL "$pid" 2>/dev/null
  done
}

stopping=0
on_signal() {
  if [[ "$stopping" == "1" ]]; then return; fi
  stopping=1
  # TERM reaches the wrapper too (it is in the group); the guard above keeps
  # this idempotent.
  signal_tree TERM
}
trap on_signal TERM INT

wait "$child"
status=$?

if [[ "$stopping" == "1" ]]; then
  for _ in $(seq 1 50); do
    kill -0 "$child" 2>/dev/null || break
    sleep 0.1
  done
  kill_remaining
  wait "$child" 2>/dev/null
  status=143
fi

rm -f "$pid_file"
printf -- '--- %s exited %s (status %s) ---\n' "$log_name" "$(date -Is 2>/dev/null || date)" "$status" >>"$log_file"
# Let tee drain the pipe before the process exits, so the banner keeps its order.
sleep 0.15
exit "$status"
