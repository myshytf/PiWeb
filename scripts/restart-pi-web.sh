#!/usr/bin/env bash
# Safe production restart for pi-web.
#
# This script intentionally only kills the process currently listening on the
# configured port (and its child processes / known pi-web wrapper parent). It
# does NOT grep broad command lines, so it will not kill itself or the caller.

set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PI_WEB_PORT:-9876}"
APP_CWD="${PI_WEB_CWD:-$PROJECT_DIR}"
APP_LOG="${PI_WEB_LOG:-/tmp/pi-web.log}"
RESTART_LOG="${PI_WEB_RESTART_LOG:-/tmp/pi-web-restart.log}"
LOCK_DIR="${PI_WEB_RESTART_LOCK:-/tmp/pi-web-restart.lock}"
START_TIMEOUT_SECONDS="${PI_WEB_START_TIMEOUT_SECONDS:-15}"
GRACE_SECONDS="${PI_WEB_STOP_GRACE_SECONDS:-8}"
START_DELAY_SECONDS="${PI_WEB_RESTART_DELAY_SECONDS:-1}"

mkdir -p "$(dirname "$RESTART_LOG")" "$(dirname "$APP_LOG")"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -Iseconds)] Another pi-web restart is already running (lock: $LOCK_DIR)" >> "$RESTART_LOG"
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

exec >> "$RESTART_LOG" 2>&1

log() {
  printf '[%s] %s\n' "$(date -Iseconds)" "$*"
}

listener_pids() {
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -n -u || true
}

read_pids_into_array() {
  local array_name="$1"
  local line
  eval "$array_name=()"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    eval "$array_name+=(\"$line\")"
  done
}

descendant_pids() {
  local pid="$1"
  local child
  while read -r child; do
    [[ -z "$child" ]] && continue
    echo "$child"
    descendant_pids "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

known_wrapper_parent_pids() {
  local pid ppid cmd
  for pid in "$@"; do
    [[ -z "$pid" ]] && continue
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -z "$ppid" || "$ppid" == "0" || "$ppid" == "1" ]] && continue
    cmd="$(ps -o command= -p "$ppid" 2>/dev/null || true)"
    case "$cmd" in
      *"dist/cli.js --port $PORT"*|*"tsx src/cli.ts --port $PORT"*)
        echo "$ppid"
        ;;
    esac
  done
}

unique_safe_pids() {
  awk -v self="$$" -v parent="$PPID" '
    NF && $1 ~ /^[0-9]+$/ && $1 != 0 && $1 != 1 && $1 != self && $1 != parent && !seen[$1]++ { print $1 }
  '
}

wait_for_port_free() {
  local deadline=$((SECONDS + GRACE_SECONDS))
  while (( SECONDS < deadline )); do
    if [[ -z "$(listener_pids)" ]]; then
      return 0
    fi
    sleep 0.2
  done
  [[ -z "$(listener_pids)" ]]
}

wait_for_server() {
  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))
  local code="000"
  while (( SECONDS < deadline )); do
    if listener_pids >/dev/null; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo 000)"
      # 200 = auth disabled or credentials supplied elsewhere; 401 = app is up and auth is active.
      if [[ "$code" == "200" || "$code" == "401" ]]; then
        return 0
      fi
    fi
    sleep 0.25
  done
  return 1
}

start_server() {
  if [[ ! -f "$PROJECT_DIR/dist/cli.js" ]]; then
    log "ERROR: $PROJECT_DIR/dist/cli.js not found. Run npm run build first."
    return 1
  fi

  cd "$PROJECT_DIR"
  log "Starting: NODE_ENV=production node dist/cli.js --port $PORT --cwd $APP_CWD"
  NODE_ENV=production node dist/cli.js --port "$PORT" --cwd "$APP_CWD" > "$APP_LOG" 2>&1 &
  local new_pid=$!
  disown "$new_pid" 2>/dev/null || true
  log "Started PID: $new_pid"
}

main() {
  log "pi-web restart requested"
  log "Project: $PROJECT_DIR"
  log "Port: $PORT"
  log "CWD: $APP_CWD"

  # Let the HTTP response that triggered this restart flush before the listener is terminated.
  sleep "$START_DELAY_SECONDS"

  read_pids_into_array listeners < <(listener_pids)
  if (( ${#listeners[@]} > 0 )); then
    log "Listener PIDs: ${listeners[*]}"
  else
    log "No existing listener on port $PORT"
  fi

  read_pids_into_array old_pids < <(
    {
      if (( ${#listeners[@]} > 0 )); then
        printf '%s\n' "${listeners[@]}"
        for pid in "${listeners[@]}"; do
          descendant_pids "$pid"
        done
        known_wrapper_parent_pids "${listeners[@]}"
      fi
    } | unique_safe_pids
  )

  if (( ${#old_pids[@]} > 0 )); then
    log "Stopping PIDs: ${old_pids[*]}"
    kill -TERM "${old_pids[@]}" 2>/dev/null || true

    if ! wait_for_port_free; then
      read_pids_into_array still_listening < <(listener_pids)
      if (( ${#still_listening[@]} > 0 )); then
        log "Port still busy; force killing listener PIDs: ${still_listening[*]}"
        kill -KILL "${still_listening[@]}" 2>/dev/null || true
      fi
      wait_for_port_free || {
        log "ERROR: Port $PORT is still busy; aborting start"
        lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
        return 1
      }
    fi
  fi

  start_server

  if wait_for_server; then
    log "Server is up"
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
    log "restart complete"
  else
    log "ERROR: Server did not become ready within ${START_TIMEOUT_SECONDS}s"
    tail -80 "$APP_LOG" || true
    return 1
  fi
}

main "$@"
