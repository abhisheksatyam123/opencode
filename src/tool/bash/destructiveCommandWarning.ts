const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  // git data-loss ops
  { pattern: /\bgit\s+.*--hard\b/, warning: "git reset --hard will discard all uncommitted changes permanently" },
  {
    pattern: /\bgit\s+push\s+.*(?:-f|--force)\b/,
    warning: "Force push will overwrite remote history and may cause data loss for other contributors",
  },
  {
    pattern: /\bgit\s+push\s+--force-with-lease\b/,
    warning: "Force push (--force-with-lease) will overwrite remote history",
  },
  { pattern: /\bgit\s+clean\s+.*-f\b/, warning: "git clean -f will permanently delete untracked files" },
  {
    pattern: /\bgit\s+(?:checkout|restore)\s+\.\s*$/,
    warning: "git checkout/restore . will discard all unstaged changes in the working directory",
  },
  {
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/,
    warning: "git stash drop/clear will permanently delete stashed changes",
  },
  {
    pattern: /\bgit\s+branch\s+.*-D\b/,
    warning: "git branch -D will permanently delete the branch and its unmerged commits",
  },
  // git safety bypasses
  { pattern: /\bgit\s+.*--no-verify\b/, warning: "Using --no-verify bypasses pre-commit and commit-msg hooks" },
  { pattern: /\bgit\s+commit\s+.*--amend\b/, warning: "git commit --amend rewrites history; avoid on pushed commits" },
  // filesystem
  {
    pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\s+.*-[a-zA-Z]*f[a-zA-Z]*r\b/,
    warning: "rm -rf will recursively and forcefully delete files without confirmation",
  },
  { pattern: /\brm\s+.*-[a-zA-Z]*f\b/, warning: "rm -f will forcefully delete files without confirmation" },
  { pattern: /\brm\s+.*-[a-zA-Z]*r\b/, warning: "rm -r will recursively delete directories" },
  // SQL
  {
    pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$))/i,
    warning: "SQL statement will permanently delete data from the database",
  },
  // kubectl
  { pattern: /\bkubectl\s+delete\b/, warning: "kubectl delete will permanently remove Kubernetes resources" },
  // terraform
  {
    pattern: /\bterraform\s+destroy\b/,
    warning: "terraform destroy will permanently destroy all managed infrastructure",
  },
]

export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return warning
  }
  return null
}
