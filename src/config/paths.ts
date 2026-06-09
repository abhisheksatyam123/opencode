import path from "path"
import os from "os"
import z from "zod"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"
import { NamedError } from "@opencode-ai/util/error"
import { Filesystem } from "@/foundation/util/filesystem"
import { Flag } from "@/foundation/flag/flag"
import { Global } from "@/filesystem/global"
import { hasHiddenSegment } from "@/foundation/util/path"
import { formatJsoncParseErrorMessage } from "@/foundation/util/jsonc"

export namespace ConfigPaths {
  export async function projectFiles(name: string, directory: string, worktree: string) {
    return Filesystem.findUp([`${name}.json`, `${name}.jsonc`], directory, worktree, { rootFirst: true })
  }

  function resolveOverrideConfigDir(dir: string) {
    const resolved = path.resolve(dir)
    if (hasHiddenSegment(resolved)) {
      throw new Error(
        `hidden-config-path-unsupported: OPENCODE_CONFIG_DIR resolves inside a hidden directory (${resolved}); use ${Global.Path.config} or a non-hidden directory`,
      )
    }
    return resolved
  }

  export async function directories(_directory: string, _worktree: string) {
    const candidates = [path.resolve(Global.Path.config)]
    if (Flag.OPENCODE_CONFIG_DIR) {
      candidates.push(resolveOverrideConfigDir(Flag.OPENCODE_CONFIG_DIR))
    }

    const seen = new Set<string>()
    const unique: string[] = []
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      unique.push(resolved)
    }

    return unique
  }

  export function fileInDirectory(dir: string, name: string) {
    return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
  }

  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  /** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
  export async function readFile(filepath: string) {
    return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return
      throw new JsonError({ path: filepath }, { cause: err })
    })
  }

  type ParseSource = string | { source: string; dir: string }

  function source(input: ParseSource) {
    return typeof input === "string" ? input : input.source
  }

  function dir(input: ParseSource) {
    return typeof input === "string" ? path.dirname(input) : input.dir
  }

  /** Apply {env:VAR} and {file:path} substitutions to config text. */
  async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
    if (!fileMatches.length) return text

    const configDir = dir(input)
    const configSource = source(input)
    let out = ""
    let cursor = 0

    for (const match of fileMatches) {
      const token = match[0]
      const index = match.index!
      out += text.slice(cursor, index)

      const lineStart = text.lastIndexOf("\n", index - 1) + 1
      const prefix = text.slice(lineStart, index).trimStart()
      if (prefix.startsWith("//")) {
        out += token
        cursor = index + token.length
        continue
      }

      let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
      if (filePath.startsWith("~/")) {
        filePath = path.join(os.homedir(), filePath.slice(2))
      }

      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
      const fileContent = (
        await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
          if (missing === "empty") return ""

          const errMsg = `bad file reference: "${token}"`
          if (error.code === "ENOENT") {
            throw new InvalidError(
              {
                path: configSource,
                message: errMsg + ` ${resolvedPath} does not exist`,
              },
              { cause: error },
            )
          }
          throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
        })
      ).trim()

      out += JSON.stringify(fileContent).slice(1, -1)
      cursor = index + token.length
    }

    out += text.slice(cursor)
    return out
  }

  /** Substitute and parse JSONC text, throwing JsonError on syntax errors. */
  export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    const configSource = source(input)
    text = await substitute(text, input, missing)

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      throw new JsonError({
        path: configSource,
        message: formatJsoncParseErrorMessage(text, errors),
      })
    }

    return data
  }
}
