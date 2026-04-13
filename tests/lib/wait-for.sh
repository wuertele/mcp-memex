#!/usr/bin/env bash

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"
  local started_at

  started_at="$(date +%s)"

  while true; do
    if (: >/dev/tcp/"${host}"/"${port}") >/dev/null 2>&1; then
      return 0
    fi

    if (( "$(date +%s)" - started_at >= timeout_seconds )); then
      echo "Timed out waiting for ${host}:${port}" >&2
      return 1
    fi

    sleep 1
  done
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"
  local started_at

  started_at="$(date +%s)"

  while true; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi

    if (( "$(date +%s)" - started_at >= timeout_seconds )); then
      echo "Timed out waiting for ${url}" >&2
      return 1
    fi

    sleep 1
  done
}
