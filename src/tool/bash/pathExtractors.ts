export type PathCommand =
  | "cd"
  | "ls"
  | "find"
  | "mkdir"
  | "touch"
  | "rm"
  | "rmdir"
  | "mv"
  | "cp"
  | "cat"
  | "head"
  | "tail"
  | "grep"
  | "rg"
  | "sed"
  | "git"
  | "jq"

export const PATH_EXTRACTORS: Record<PathCommand, (args: string[]) => string[]> = {
  cd: (args) => args.filter((a) => !a.startsWith("-")).slice(0, 1),
  ls: (args) => args.filter((a) => !a.startsWith("-")),
  find: (args) => {
    // first non-flag arg(s) before any -name/-type etc predicate
    const paths: string[] = []
    for (const a of args) {
      if (a.startsWith("-")) break
      paths.push(a)
    }
    return paths
  },
  mkdir: (args) => args.filter((a) => !a.startsWith("-")),
  touch: (args) => args.filter((a) => !a.startsWith("-")),
  rm: (args) => args.filter((a) => !a.startsWith("-")),
  rmdir: (args) => args.filter((a) => !a.startsWith("-")),
  mv: (args) => args.filter((a) => !a.startsWith("-")),
  cp: (args) => args.filter((a) => !a.startsWith("-")),
  cat: (args) => args.filter((a) => !a.startsWith("-")),
  head: (args) => args.filter((a) => !a.startsWith("-")),
  tail: (args) => args.filter((a) => !a.startsWith("-")),
  grep: (args) => {
    // skip pattern (first non-flag arg), return rest as paths
    const nonFlags = args.filter((a) => !a.startsWith("-"))
    return nonFlags.slice(1)
  },
  rg: (args) => {
    // skip pattern, return rest
    const nonFlags = args.filter((a) => !a.startsWith("-"))
    return nonFlags.slice(1)
  },
  sed: (args) => {
    // skip expression(s), return file args
    const nonFlags = args.filter((a) => !a.startsWith("-"))
    return nonFlags.slice(1)
  },
  git: (args) => {
    // for git, extract path args after subcommand (very basic)
    const nonFlags = args.filter((a) => !a.startsWith("-"))
    return nonFlags.slice(1)
  },
  jq: (args) => {
    // skip filter expression, return file args
    const nonFlags = args.filter((a) => !a.startsWith("-"))
    return nonFlags.slice(1)
  },
}

export function extractPathsFromCommand(command: string): { baseCmd: string; paths: string[] } | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null
  const baseCmd = tokens[0] as PathCommand
  if (!(baseCmd in PATH_EXTRACTORS)) return null
  const args = tokens.slice(1)
  const extractor = PATH_EXTRACTORS[baseCmd]
  const paths = extractor(args)
  return { baseCmd, paths }
}

function tokenize(cmd: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if ((c === " " || c === "\t") && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += c
  }
  if (current) tokens.push(current)
  return tokens
}
