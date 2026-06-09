#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== CI fixture gate ==="
echo "  repo:       $REPO_DIR"
echo "  timestamp:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

cd "$REPO_DIR"

# 1. Typecheck
echo "--- typecheck ---"
if ! bun run typecheck; then
  echo ""
  echo "CI gate: FAIL (typecheck)"
  exit 1
fi
echo ""

# 1.5 Composition-root lint — no bare `new SqliteFoo()` outside the factory.
#     See src/intelligence/db/sqlite/factory.ts for the allowed site.
echo "--- composition-root lint ---"
BARE_INSTANTIATION=$(grep -rnE 'new (SqliteDbFoundation|SqliteGraphStore|SqliteDbLookup)\(' src --include="*.ts" 2>/dev/null \
  | grep -v 'src/intelligence/db/sqlite/factory\.ts' \
  || true)
if [ -n "$BARE_INSTANTIATION" ]; then
  echo "FAIL: bare SQLite instantiation outside src/intelligence/db/sqlite/factory.ts:"
  echo "$BARE_INSTANTIATION"
  echo ""
  echo "Fix: import { createSqliteStore } from '.../db/sqlite/factory.js' and destructure."
  echo ""
  echo "CI gate: FAIL (composition-root lint)"
  exit 1
fi
echo "  ok: all SQLite instantiation routes through createSqliteStore()"
echo ""

# 2. Contract tests (port-shared + schema + property layer; <5s wall)
if [ -d "test/contracts" ]; then
  echo "--- contract tests ---"
  if ! bun run test:contracts; then
    echo ""
    echo "CI gate: FAIL (contract tests)"
    exit 1
  fi
  echo ""
fi

# 3. Unit tests (if directory exists)
if [ -d "test/unit" ]; then
  echo "--- unit tests ---"
  if ! bun run test:unit; then
    echo ""
    echo "CI gate: FAIL (unit tests)"
    exit 1
  fi
  echo ""
fi

echo "CI gate: PASS"
