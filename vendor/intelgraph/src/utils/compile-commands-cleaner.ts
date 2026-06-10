/**
 * compile-commands-cleaner.ts
 *
 * Automatically cleans compile_commands.json before starting clangd.
 *
 * Operations:
 * - Expands ROM/RAM patch files to include original source files
 * - Removes test/mock/stub files (optional)
 * - Deduplicates entries
 * - Cleans problematic compiler flags
 * - Tracks cleaning state in .intelgraph.json to avoid redundant work
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs"
import path from "path"
import { loggerPort } from "../logging/logger.js"
const log = loggerPort.child("compile-commands")

export interface CleanStats {
  patchEntries: number
  mappedPatchCount: number
  unmatchedPatchCount: number
  requireZeroUnmatched: boolean
  preflightPolicy: "reject" | "fix" | "remap"
  externalEntryCount: number
  remappedExternalCount: number
  removedExternalCount: number
  preflightOk: boolean
  ranAt: string
  /** Only present when cleaning actually ran (cleaned: true). */
  newHash?: string
  cleanedAt?: string
  finalEntries?: number
}

interface CleaningConfig {
  enabled?: boolean
  removeTests?: boolean
  cleanFlags?: boolean
  requireZeroUnmatched?: boolean
  preflightPolicy?: "reject" | "fix" | "remap"
  lastCleanedHash?: string
  lastCleanedAt?: string
  preflight?: {
    ranAt?: string
    unmatchedPatchCount?: number
    mappedPatchCount?: number
    patchEntries?: number
    preflightOk?: boolean
    requireZeroUnmatched?: boolean
    preflightPolicy?: "reject" | "fix" | "remap"
    externalEntryCount?: number
    remappedExternalCount?: number
    removedExternalCount?: number
  }
}

interface CompileCommand {
  directory: string
  file: string
  arguments?: string[]
  command?: string
  output?: string
}

/**
 * Calculate a simple hash of compile_commands.json to detect changes.
 */
function hashCompileCommands(entries: CompileCommand[]): string {
  const str = JSON.stringify(entries.map((e) => e.file).sort())
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(36)
}

function isPatchName(filePath: string): boolean {
  const n = path.basename(filePath).toLowerCase()
  return (
    n.includes("_patch.c") ||
    n.includes("_patch.h") ||
    n.includes("_patch.cpp") ||
    n.endsWith("patch.c") ||
    n.endsWith("patch.h") ||
    n.endsWith("patch.cpp")
  )
}

/**
 * Find ROM source file corresponding to a patch file.
 *
 * Mapping: module/rom/variant/patch/... to module/src/...
 * Patterns: file_patch.c to file.c, filepatch.c to file.c
 */
function findRomSourceFile(patchFile: string, workspaceRoot: string): string | null {
  if (!isPatchName(patchFile)) {
    return null
  }

  // Supported families:
  // - <component>/rom/<variant>/(patch|orig)/...
  // - <component>/v1rom/patch/..., <component>/v2rom/patch/...
  // - <component>/ramv1/..., <component>/ramv2/...
  const match =
    patchFile.match(/(.+)\/(rom\/[^/]+|v[0-9]+rom)\/(patch|orig)\/(.+)/) ?? patchFile.match(/(.+)\/(ramv[0-9]+)\/(.+)/)

  if (!match) {
    return null
  }

  const modulePath = match[1]
  const relativePath = match[4] ?? match[3]

  // Remove 'patch' from filename
  const filename = path.basename(relativePath)
  let romFilename: string

  if (filename.includes("_patch.cpp")) {
    romFilename = filename.replace("_patch.cpp", ".cpp")
  } else if (filename.includes("_patch.c")) {
    romFilename = filename.replace("_patch.c", ".c")
  } else if (filename.includes("_patch.h")) {
    romFilename = filename.replace("_patch.h", ".h")
  } else if (filename.endsWith("patch.cpp")) {
    romFilename = filename.replace("patch.cpp", ".cpp")
  } else if (filename.includes("patch.c")) {
    romFilename = filename.replace("patch.c", ".c")
  } else if (filename.includes("patch.h")) {
    romFilename = filename.replace("patch.h", ".h")
  } else {
    return null
  }

  const romRelative = relativePath.replace(filename, romFilename)

  // Try possible ROM locations
  const candidates = [
    path.join(modulePath, "src", romRelative),
    path.join(modulePath, romRelative),
    path.join(modulePath, "core", "src", romRelative),
    path.join(modulePath, "protocol", "src", romRelative),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  // Conservative fallback: search only by filename under component root.
  const targetName = path.basename(romRelative)
  try {
    const stack = [modulePath]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (!cur) continue
      let children: string[] = []
      try {
        children = readdirSync(cur)
      } catch {
        continue
      }
      for (const name of children) {
        const abs = path.join(cur, name)
        try {
          const st = statSync(abs)
          if (st.isDirectory()) {
            if (abs.includes("/patch/") || abs.includes("/build/") || abs.includes("/out/") || abs.includes("/obj/")) {
              continue
            }
            stack.push(abs)
          } else if (name === targetName) {
            return abs
          }
        } catch {
          // ignore inaccessible entries
        }
      }
    }
  } catch {
    // ignore fallback failure
  }

  return null
}

/**
 * Create ROM compile entry from patch entry.
 */
function createRomEntry(patchEntry: CompileCommand, romFile: string): CompileCommand {
  const romEntry = { ...patchEntry }

  romEntry.file = romFile
  romEntry.directory = path.dirname(romFile)

  if (romEntry.arguments) {
    romEntry.arguments = romEntry.arguments.map((arg) => {
      if (arg.includes("_patch.c") || arg.includes("_patch.h") || arg.includes("patch.c") || arg.includes("patch.h")) {
        return romFile
      }
      if (arg.startsWith("-D__FILENAME__=")) {
        return `-D__FILENAME__="${path.basename(romFile)}"`
      }
      if (arg.startsWith("-DMY_GCC_FILE=")) {
        return `-DMY_GCC_FILE="${path.basename(romFile)}"`
      }
      return arg
    })
  }

  if (romEntry.command) {
    romEntry.command = romEntry.command.replace(patchEntry.file, romFile)
  }

  if (romEntry.output) {
    romEntry.output = romEntry.output.replace("_patch.o", ".o").replace("patch.o", ".o")
  }

  return romEntry
}

/**
 * Check if a file is a test/mock/stub file.
 */
function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const patterns = [
    "/test/",
    "/tests/",
    "/testing/",
    "_test.c",
    "_test.cpp",
    "_test.h",
    "test_",
    "test.c",
    "test.cpp",
    "/unit_test/",
    "/unittest/",
    "/qtf_test/",
    "_unit_test.c",
    "_unittest.c",
    "/mock/",
    "/mocks/",
    "_mock.c",
    "_mock.cpp",
    "/stub/",
    "/stubs/",
    "_stub.c",
    "_stub.cpp",
    "/simulation_test/",
    "/sim_test/",
    "/qtf_stubs/",
    "/qtf_common/",
  ]
  return patterns.some((p) => lower.includes(p))
}

/**
 * Clean problematic compiler flags.
 */
function cleanFlags(entry: CompileCommand): CompileCommand {
  const problematicFlags = new Set(["-mduplex", "-Werror"])

  if (entry.arguments) {
    entry.arguments = entry.arguments.filter((arg) => !problematicFlags.has(arg))
  }

  if (entry.command) {
    for (const flag of problematicFlags) {
      entry.command = entry.command.replace(flag, "")
    }
    entry.command = entry.command.trim()
  }

  return entry
}

function isUnderRoot(absPath: string, workspaceRoot: string): boolean {
  const normalizedRoot = path.resolve(workspaceRoot)
  const normalizedPath = path.resolve(absPath)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)
}

function remapExternalPathToWorkspace(filePath: string, workspaceRoot: string): string | null {
  const normalizedFile = path.resolve(filePath)
  const markers = ["/wlan_proc/", `${path.sep}wlan_proc${path.sep}`]

  for (const marker of markers) {
    const idx = normalizedFile.indexOf(marker)
    if (idx < 0) continue
    const suffix = normalizedFile.slice(idx + marker.length)
    const candidate = path.join(workspaceRoot, "wlan_proc", suffix)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function rewriteEntryPath(entry: CompileCommand, fromPath: string, toPath: string): CompileCommand {
  const rewritten = { ...entry }
  rewritten.file = toPath
  rewritten.directory = path.dirname(toPath)

  if (rewritten.arguments) {
    rewritten.arguments = rewritten.arguments.map((arg) => (arg === fromPath ? toPath : arg))
  }

  if (rewritten.command) {
    rewritten.command = rewritten.command.replace(fromPath, toPath)
  }

  return rewritten
}

/**
 * Clean compile_commands.json.
 */
function emptyStats(policy: "reject" | "fix" | "remap" = "remap"): CleanStats {
  return {
    patchEntries: 0,
    mappedPatchCount: 0,
    unmatchedPatchCount: 0,
    requireZeroUnmatched: false,
    preflightPolicy: policy,
    externalEntryCount: 0,
    remappedExternalCount: 0,
    removedExternalCount: 0,
    preflightOk: true,
    ranAt: new Date().toISOString(),
  }
}

export async function cleanCompileCommands(
  workspaceRoot: string,
  config: CleaningConfig,
): Promise<{ cleaned: boolean; stats: CleanStats; preflightOk: boolean }> {
  const compileCommandsPath = path.join(workspaceRoot, "compile_commands.json")

  if (!existsSync(compileCommandsPath)) {
    log.info("No compile_commands.json found — skipping cleaning", { workspaceRoot })
    return { cleaned: false, stats: emptyStats(config.preflightPolicy), preflightOk: true }
  }

  // Load compile commands
  let entries: CompileCommand[]
  try {
    const content = readFileSync(compileCommandsPath, "utf8")
    entries = JSON.parse(content)
  } catch (err) {
    log.error("Failed to load compile_commands.json", err instanceof Error ? err : { raw: String(err) })
    return { cleaned: false, stats: emptyStats(config.preflightPolicy), preflightOk: true }
  }

  const originalCount = entries.length
  const currentHash = hashCompileCommands(entries)

  // Check if already cleaned
  if (config.lastCleanedHash === currentHash) {
    log.info("compile_commands.json already cleaned (hash match) — skipping", {
      hash: currentHash,
      lastCleanedAt: config.lastCleanedAt,
    })
    const preflight = config.preflight ?? {}
    return {
      cleaned: false,
      stats: {
        ...emptyStats(config.preflightPolicy),
        patchEntries: preflight.patchEntries ?? 0,
        mappedPatchCount: preflight.mappedPatchCount ?? 0,
        unmatchedPatchCount: preflight.unmatchedPatchCount ?? 0,
        requireZeroUnmatched: preflight.requireZeroUnmatched ?? false,
        preflightPolicy: preflight.preflightPolicy ?? config.preflightPolicy ?? "remap",
        externalEntryCount: preflight.externalEntryCount ?? 0,
        remappedExternalCount: preflight.remappedExternalCount ?? 0,
        removedExternalCount: preflight.removedExternalCount ?? 0,
        preflightOk: preflight.preflightOk ?? true,
        ranAt: preflight.ranAt ?? new Date().toISOString(),
      },
      preflightOk: preflight.preflightOk ?? true,
    }
  }

  log.info("Cleaning compile_commands.json", {
    originalEntries: originalCount,
    removeTests: config.removeTests,
    cleanFlags: config.cleanFlags,
  })

  const stats = {
    originalEntries: originalCount,
    patchEntries: 0,
    mappedPatchEntries: 0,
    unmatchedPatchEntries: 0,
    externalEntries: 0,
    remappedExternalEntries: 0,
    removedExternalEntries: 0,
    romFilesAdded: 0,
    testFilesRemoved: 0,
    duplicatesRemoved: 0,
    flagsCleaned: 0,
    finalEntries: 0,
  }

  // 1. Expand ROM files
  const romFiles = new Set<string>()
  const existingFiles = new Set(entries.map((e) => path.resolve(e.file)))
  const newEntries: CompileCommand[] = []
  const unmatchedPatchFiles: string[] = []

  for (const entry of entries) {
    if (isPatchName(entry.file)) {
      stats.patchEntries++
      const romFile = findRomSourceFile(entry.file, workspaceRoot)
      if (romFile) {
        stats.mappedPatchEntries++
      } else {
        unmatchedPatchFiles.push(entry.file)
      }

      if (romFile && !romFiles.has(romFile) && !existingFiles.has(path.resolve(romFile))) {
        const romEntry = createRomEntry(entry, romFile)
        newEntries.push(romEntry)
        romFiles.add(romFile)
      }
    }
  }

  stats.unmatchedPatchEntries = unmatchedPatchFiles.length

  const preflightPolicy = config.preflightPolicy ?? "remap"
  if (preflightPolicy === "fix" || preflightPolicy === "remap") {
    const remappedOrKept: CompileCommand[] = []
    for (const entry of entries) {
      const absoluteFile = path.resolve(entry.file)
      if (isUnderRoot(absoluteFile, workspaceRoot)) {
        remappedOrKept.push(entry)
        continue
      }

      stats.externalEntries++

      if (preflightPolicy === "remap") {
        const remapped = remapExternalPathToWorkspace(absoluteFile, workspaceRoot)
        if (remapped) {
          remappedOrKept.push(rewriteEntryPath(entry, entry.file, remapped))
          stats.remappedExternalEntries++
          continue
        }
      }

      stats.removedExternalEntries++
    }

    entries = remappedOrKept
  } else {
    for (const entry of entries) {
      const absoluteFile = path.resolve(entry.file)
      if (!isUnderRoot(absoluteFile, workspaceRoot)) {
        stats.externalEntries++
      }
    }
  }

  stats.romFilesAdded = newEntries.length
  entries = entries.concat(newEntries)

  // 2. Remove test files (optional)
  if (config.removeTests) {
    const beforeCount = entries.length
    entries = entries.filter((e) => !isTestFile(e.file))
    stats.testFilesRemoved = beforeCount - entries.length
  }

  // 3. Deduplicate
  const fileMap = new Map<string, CompileCommand>()
  for (const entry of entries) {
    const normalized = path.resolve(entry.file)
    const existing = fileMap.get(normalized)

    if (!existing) {
      fileMap.set(normalized, entry)
    } else {
      // Keep the one with more arguments
      const existingArgCount = existing.arguments?.length || 0
      const newArgCount = entry.arguments?.length || 0
      if (newArgCount > existingArgCount) {
        fileMap.set(normalized, entry)
      }
      stats.duplicatesRemoved++
    }
  }

  entries = Array.from(fileMap.values())

  // 4. Clean flags (optional)
  if (config.cleanFlags) {
    for (let i = 0; i < entries.length; i++) {
      const before = JSON.stringify(entries[i])
      entries[i] = cleanFlags(entries[i])
      const after = JSON.stringify(entries[i])
      if (before !== after) {
        stats.flagsCleaned++
      }
    }
  }

  stats.finalEntries = entries.length

  const requireZeroUnmatched = config.requireZeroUnmatched !== false
  const crossRootOk = preflightPolicy === "reject" ? stats.externalEntries === 0 : true
  const preflightOk = (!requireZeroUnmatched || stats.unmatchedPatchEntries === 0) && crossRootOk

  const preflightState = {
    ranAt: new Date().toISOString(),
    patchEntries: stats.patchEntries,
    mappedPatchCount: stats.mappedPatchEntries,
    unmatchedPatchCount: stats.unmatchedPatchEntries,
    requireZeroUnmatched,
    preflightPolicy,
    externalEntryCount: stats.externalEntries,
    remappedExternalCount: stats.remappedExternalEntries,
    removedExternalCount: stats.removedExternalEntries,
    preflightOk,
  }

  // Persist unmatched report for operators.
  try {
    const reportPath = path.join(workspaceRoot, "patch_unmatched.txt")
    writeFileSync(reportPath, unmatchedPatchFiles.join("\n") + (unmatchedPatchFiles.length ? "\n" : ""), "utf8")
  } catch (err) {
    log.error("Failed to write patch_unmatched.txt", err instanceof Error ? err : { raw: String(err) })
  }

  // Write cleaned compile_commands
  try {
    writeFileSync(compileCommandsPath, JSON.stringify(entries, null, 2))
    log.info("Cleaned compile_commands.json written", stats)
  } catch (err) {
    log.error("Failed to write cleaned compile_commands.json", err instanceof Error ? err : { raw: String(err) })
    return { cleaned: false, stats: { ...stats, ...preflightState }, preflightOk }
  }

  return {
    cleaned: true,
    stats: {
      ...stats,
      ...preflightState,
      newHash: hashCompileCommands(entries),
      cleanedAt: new Date().toISOString(),
    },
    preflightOk,
  }
}
