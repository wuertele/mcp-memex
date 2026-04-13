#!/usr/bin/env bash
set -euo pipefail
set -E  # ensure ERR trap is inherited by functions, command substitutions, and subshells

echo "[run-tests] preflight"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "[run-tests] missing required command: ${command_name}" >&2
    exit 1
  fi
}

assert_port_available() {
  local port="$1"
  if (: >/dev/tcp/127.0.0.1/"${port}") >/dev/null 2>&1; then
    echo "[run-tests] port ${port} is already bound; inspect with 'lsof -i :${port}'" >&2
    exit 1
  fi
}

require_command docker
require_command deno

if ! docker compose version >/dev/null 2>&1; then
  echo "[run-tests] docker compose is not available" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[run-tests] Docker not reachable - start Colima with 'colima start' or open Docker Desktop" >&2
  exit 1
fi

assert_port_available 55432
assert_port_available 58000

COMPOSE=(docker compose -p memex-test -f tests/compose.yaml)
cleanup_done=0
compose_started=0

cleanup() {
  if (( cleanup_done == 1 )); then
    return
  fi

  cleanup_done=1
  echo "[run-tests] tearing down"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

handle_err() {
  local exit_code=$?
  echo "[run-tests] FAILED" >&2
  if (( compose_started == 1 )); then
    "${COMPOSE[@]}" logs --no-color >&2 || true
  fi
  # cleanup runs via the EXIT trap after this returns
  exit "${exit_code}"
}

handle_signal() {
  cleanup
  exit 130
}

trap cleanup EXIT
trap handle_signal INT TERM
trap handle_err ERR

"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" config >/dev/null

echo "[run-tests] bringing up stack"
compose_started=1
COMPOSE_HTTP_TIMEOUT=120 "${COMPOSE[@]}" up -d --build --wait

echo "[run-tests] waiting for readiness"
source tests/lib/wait-for.sh
wait_for_http "http://127.0.0.1:58000/health" 60

postgres_ready=0
for _attempt in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U memex_test -d memex_test >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 1
done

if (( postgres_ready == 0 )); then
  echo "[run-tests] PostgreSQL did not become ready in time" >&2
  echo "[run-tests] FAILED" >&2
  "${COMPOSE[@]}" logs --no-color || true
  exit 1
fi

export MEMEX_TEST_DB_HOST=127.0.0.1
export MEMEX_TEST_DB_PORT=55432
export MEMEX_TEST_DB_NAME=memex_test
export MEMEX_TEST_DB_USER=memex_test
export MEMEX_TEST_DB_PASSWORD=memex_test
export PGHOST="${MEMEX_TEST_DB_HOST}"
export PGPORT="${MEMEX_TEST_DB_PORT}"
export PGDATABASE="${MEMEX_TEST_DB_NAME}"
export PGUSER="${MEMEX_TEST_DB_USER}"
export PGPASSWORD="${MEMEX_TEST_DB_PASSWORD}"
export MEMEX_TEST_INFERENCE_BASE=http://127.0.0.1:58000
export MEMEX_TEST_MCP_PASSWORD='memex_mcp_test_password'
export MEMEX_TEST_SYNC_PASSWORD='memex_sync_test_password'
export PSQL="docker compose -p memex-test -f tests/compose.yaml exec -T postgres psql"

echo "[run-tests] running unit tests"
set +e
deno task test:unit
unit_exit_code=$?
set -e

if (( unit_exit_code != 0 )); then
  echo "[run-tests] FAILED" >&2
  "${COMPOSE[@]}" logs --no-color >&2 || true
  exit "${unit_exit_code}"
fi

echo "[run-tests] running integration tests"
set +e
deno task test:integration
integration_exit_code=$?
set -e

if (( integration_exit_code != 0 )); then
  echo "[run-tests] FAILED" >&2
  "${COMPOSE[@]}" logs --no-color >&2 || true
  exit "${integration_exit_code}"
fi

echo "[run-tests] OK"
