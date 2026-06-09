#!/usr/bin/env bash
# pre-commit-check.sh — runs on every commit after `install-git-hooks.sh`.
#
# Enforces the contract-first workflow:
#
#   1. Composition-root lint — same as CI gate. Fails if any bare
#      `new SqliteDbFoundation()` / `new SqliteGraphStore()` /
#      `new SqliteDbLookup()` is introduced outside the factory.
#
#   2. Contracts ↔ notes sync reminder. If any staged file lives under
#      src/intelligence/contracts/*.ts (excluding fakes/), warn the
#      developer to update the matching spec note in
#      /local/mnt/workspace/notes/project/software/intelgraph/specification/.
#      This is a WARNING, not a block — the notes vault is a separate
#      repo and enforcing cross-repo atomic commits is fragile.
#
# Exit codes:
#   0 — all checks pass (warnings are non-fatal)
#   1 — composition-root lint failure (hard block)
#
# To install: `bash scripts/install-git-hooks.sh`

set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
cd "$REPO_DIR"

# ---------- 1. Composition-root lint (hard block) ----------

BARE_INSTANTIATION=$(grep -rnE 'new (SqliteDbFoundation|SqliteGraphStore|SqliteDbLookup)\(' src --include="*.ts" 2>/dev/null \
  | grep -v 'src/intelligence/db/sqlite/factory\.ts' \
  || true)

if [ -n "$BARE_INSTANTIATION" ]; then
  echo ""
  echo "✗ pre-commit: bare SQLite instantiation outside factory"
  echo ""
  echo "$BARE_INSTANTIATION"
  echo ""
  echo "Fix: import { createSqliteStore } from '.../db/sqlite/factory.js' and destructure."
  echo ""
  exit 1
fi

# ---------- 2. Contracts ↔ notes sync (soft warning) ----------

STAGED=$(git diff --cached --name-only --diff-filter=ACM)

CONTRACT_CHANGES=$(echo "$STAGED" | grep -E '^src/intelligence/contracts/.*\.ts$' | grep -v '/fakes/' || true)
NOTE_CHANGES=$(echo "$STAGED" | grep -E '^docs/' || true)  # intelgraph repo has no internal notes dir yet

if [ -n "$CONTRACT_CHANGES" ]; then
  NOTES_VAULT="/local/mnt/workspace/notes/project/software/intelgraph/specification"

  # Check if the notes vault has uncommitted changes in the specification dir.
  # If yes, the developer is probably mid-edit; don't nag.
  NOTES_PENDING=""
  if [ -d "$NOTES_VAULT/.." ] && command -v git >/dev/null 2>&1; then
    NOTES_PENDING=$(git -C "$NOTES_VAULT/.." status --short 2>/dev/null \
      | grep -E 'project/software/intelgraph/specification/' \
      || true)
  fi

  if [ -z "$NOTES_PENDING" ]; then
    echo ""
    echo "⚠ pre-commit: contract changes staged — spec notes do not appear to be modified."
    echo ""
    echo "  Changed contract files:"
    echo "$CONTRACT_CHANGES" | sed 's/^/    /'
    echo ""
    echo "  Notes vault: $NOTES_VAULT"
    echo "    specification/contract/   — port interface notes"
    echo "    specification/schema/     — data-shape notes"
    echo ""
    echo "  This is a warning only. Proceeding with commit."
    echo ""
  fi
fi

exit 0
