#!/usr/bin/env bash
# setup-notes-vault.sh — idempotent bootstrap for the notes vault and doc/ symlinks.
#
# Recreates the personal Obsidian vault at $VAULT (default ~/notes) with the
# canonical folder layout if missing, and creates this repo's doc/ symlinks
# pointing into the vault. Safe to re-run.
#
# Usage:
#   scripts/setup-notes-vault.sh
#   VAULT=/some/other/path scripts/setup-notes-vault.sh

set -euo pipefail

VAULT="${VAULT:-$HOME/notes}"
PROJECT_NAME="intelgraph"
PROJECT_CATEGORY="software"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_VAULT_PATH="$VAULT/project/$PROJECT_CATEGORY/$PROJECT_NAME"

echo "==> vault: $VAULT"
echo "==> project slot: $PROJECT_VAULT_PATH"

# 1. Ensure vault skeleton exists (idempotent)
mkdir -p "$VAULT"/atomic/{concept,principle,skill,pattern,reference}
mkdir -p "$VAULT"/atomic/literature/{paper,book,article}
mkdir -p "$VAULT"/atomic/domain
mkdir -p "$VAULT"/project/{software,research,math,art,_archive}
mkdir -p "$PROJECT_VAULT_PATH"/{architecture,module,derived,decision,skill,diagram,task}
mkdir -p "$PROJECT_VAULT_PATH"/data/{schema,fixture,contract,format,flow,state,lifecycle}
mkdir -p "$VAULT"/{task,journal,inbox,_attachments,_templates,_private}

# 2. Init vault git if not already
if [ ! -d "$VAULT/.git" ]; then
  echo "==> initializing vault git repo"
  ( cd "$VAULT" && git init -q )
fi

# 3. Create vault .gitignore if missing
if [ ! -f "$VAULT/.gitignore" ]; then
  cat > "$VAULT/.gitignore" <<'EOF'
_private/
_attachments/
inbox/
.obsidian/workspace*
.obsidian/cache
.trash/
EOF
fi

# 4. Create repo doc/ symlinks (idempotent — replace if pointing elsewhere)
mkdir -p "$REPO_ROOT/doc"
for link in atomic project; do
  target_path="$VAULT/atomic"
  [ "$link" = "project" ] && target_path="$PROJECT_VAULT_PATH"

  link_path="$REPO_ROOT/doc/$link"
  if [ -L "$link_path" ]; then
    current="$(readlink "$link_path")"
    if [ "$current" = "$target_path" ]; then
      echo "==> doc/$link already points correctly"
      continue
    fi
    echo "==> doc/$link points at $current — replacing"
    rm "$link_path"
  elif [ -e "$link_path" ]; then
    echo "ERROR: doc/$link exists and is not a symlink. Refusing to overwrite." >&2
    exit 1
  fi
  ln -s "$target_path" "$link_path"
  echo "==> created doc/$link -> $target_path"
done

echo
echo "Done. Vault ready at $VAULT"
echo "Open it in Obsidian: vault root = $VAULT"
echo "Quick capture: scripts/note new <type> <slug>"
