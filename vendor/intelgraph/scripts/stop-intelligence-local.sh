#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <WLAN_WORKSPACE_ROOT>"
  exit 1
fi

export WLAN_WORKSPACE_ROOT="$1"
docker compose -f "docker-compose.intelligence.local.yml" down

echo "Stopped intelligence DBs for workspace: $WLAN_WORKSPACE_ROOT"
