import { Hono } from "hono"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/config/project/instance"
import { Log } from "@/foundation/util/log"
import { File } from "@/filesystem/file"
import { Ripgrep } from "@/filesystem/file/ripgrep"
import { semanticNumber } from "@/foundation/util/semantic-number"
import { lazy } from "@/foundation/util/lazy"
import {
  IntelGraphFileError,
  ensureEditableSize,
  ensureTextPath,
  intelGraphLspDefinition,
  intelGraphLspServerInfo,
  resolveExistingWorkspaceFile,
  writeIntelGraphFile,
} from "@/intelgraph/file"

const log = Log.create({ service: "file-route" })

const FileDefinitionLocation = z.object({
  path: z.string(),
  line: z.number().int().min(1),
  character: z.number().int().min(0),
})

const FileDefinitionError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: semanticNumber(z.number().int().min(1).max(200).optional()),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to an existing workspace text file.",
        operationId: "file.write",
        responses: {
          200: {
            description: "File write metadata",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    path: z.string(),
                    workspace_relative: z.string(),
                    size: z.number().int().nonnegative(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const path = c.req.query("path") ?? ""
        if (!path.trim()) {
          return c.json({ error: { code: "missing_path", message: "Missing file path", details: {} } }, 400)
        }

        const body = await c.req.json().catch(() => undefined)
        const content =
          body && typeof body === "object" && "content" in body ? (body as { content?: unknown }).content : undefined
        if (typeof content !== "string") {
          return c.json({ error: { code: "invalid_content", message: "content must be string", details: {} } }, 400)
        }

        try {
          const { full, info } = await resolveExistingWorkspaceFile(fileWorkspaceRoot(), path)
          ensureTextPath(full)
          ensureEditableSize(info.size)
          const saved = await writeIntelGraphFile(fileWorkspaceRoot(), path, content)
          return c.json({
            path: saved.path,
            workspace_relative: saved.workspace_relative,
            size: saved.size_bytes,
          })
        } catch (err) {
          if (err instanceof IntelGraphFileError) {
            return c.json(
              { error: { code: err.code, message: err.message, details: { path, ...err.details } } },
              err.status as 400 | 403 | 404 | 413 | 500,
            )
          }
          const message = err instanceof Error ? err.message : String(err)
          return c.json({ error: { code: "write_failed", message, details: { path } } }, 500)
        }
      },
    )
    .get(
      "/file/definition",
      describeRoute({
        summary: "Find file definition",
        description: "Resolve a source location to definition locations using an available LSP server.",
        operationId: "file.definition",
        responses: {
          200: {
            description: "Definition locations",
            content: {
              "application/json": {
                schema: resolver(FileDefinitionLocation.array()),
              },
            },
          },
          503: {
            description: "Language server unavailable",
            content: {
              "application/json": {
                schema: resolver(FileDefinitionError),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          line: semanticNumber(z.number().int().min(1)),
          character: semanticNumber(z.number().int().min(0).optional()),
        }),
      ),
      async (c) => {
        const input = c.req.valid("query")
        const character = input.character ?? 0
        log.info("definition.lookup.start", { provider: "intelgraph", path: input.path, line: input.line, character })
        try {
          const workspaceRoot = fileWorkspaceRoot()
          const { root: realRoot, full } = await resolveExistingWorkspaceFile(workspaceRoot, input.path)
          const lspFile = path.resolve(workspaceRoot, input.path)
          ensureTextPath(full)
          const locations = await intelGraphLspDefinition(workspaceRoot, {
            file: lspFile,
            line: Math.max(0, input.line - 1),
            character,
          }).catch((err) => {
            log.warn("definition.lookup.lsp_error", {
              provider: "intelgraph",
              path: input.path,
              line: input.line,
              character,
              error: logError(err),
            })
            return []
          })
          const normalized = normalizeDefinitionLocations(workspaceRoot, realRoot, locations)
          const first = normalized[0]
          const unavailableReason =
            normalized.length === 0
              ? unavailableReasonForPath(lspFile, await intelGraphLspServerInfo(workspaceRoot).catch(() => undefined))
              : undefined
          if (unavailableReason) {
            const language = lspLanguageForPath(lspFile)
            log.warn("definition.lookup.unavailable", {
              provider: "intelgraph",
              path: input.path,
              line: input.line,
              character,
              language,
              reason: unavailableReason,
            })
            return c.json(
              {
                error: {
                  code: "lsp_unavailable",
                  message: unavailableReason,
                  details: { path: input.path, language },
                },
              },
              503,
            )
          }
          log.info("definition.lookup.complete", {
            provider: "intelgraph",
            path: input.path,
            line: input.line,
            character,
            workspaceRoot,
            realRoot,
            resultCount: normalized.length,
            firstResult: first ? { path: first.path, line: first.line, character: first.character } : undefined,
          })
          return c.json(normalized)
        } catch (err) {
          if (err instanceof IntelGraphFileError) {
            log.warn("definition.lookup.rejected", {
              path: input.path,
              line: input.line,
              character,
              code: err.code,
              status: err.status,
            })
            return c.json(
              { error: { code: err.code, message: err.message, details: { path: input.path, ...err.details } } },
              err.status as 400 | 403 | 404 | 413 | 500,
            )
          }
          const message = err instanceof Error ? err.message : String(err)
          log.error("definition.lookup.error", {
            path: input.path,
            line: input.line,
            character,
            error: logError(err),
          })
          return c.json({ error: { code: "definition_failed", message, details: { path: input.path } } }, 500)
        }
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    ),
)

function logError(err: unknown) {
  if (err instanceof Error) return { name: err.name, message: err.message }
  return { message: String(err) }
}

export function normalizeDefinitionLocations(workspaceRoot: string, realRoot: string, values: unknown[]) {
  return values.flatMap((value) => {
    const row = value as {
      uri?: unknown
      targetUri?: unknown
      range?: { start?: { line?: unknown; character?: unknown } }
      targetRange?: { start?: { line?: unknown; character?: unknown } }
      targetSelectionRange?: { start?: { line?: unknown; character?: unknown } }
    }
    const uri = typeof row.targetUri === "string" ? row.targetUri : typeof row.uri === "string" ? row.uri : undefined
    const range = row.targetSelectionRange ?? row.targetRange ?? row.range
    const line = range?.start?.line
    const character = range?.start?.character
    if (!uri || typeof line !== "number" || typeof character !== "number") return []
    const target = definitionPath([workspaceRoot, realRoot], uri)
    if (!target) return []
    return [
      {
        path: target,
        line: Math.max(1, Math.trunc(line) + 1),
        character: Math.max(0, Math.trunc(character)),
      },
    ]
  })
}

function definitionPath(roots: string[], uri: string) {
  let full = uri
  if (uri.startsWith("file://")) {
    try {
      full = fileURLToPath(uri)
    } catch {
      return
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    return
  }
  for (const root of roots) {
    const base = path.resolve(root)
    const candidate = path.isAbsolute(full) ? path.normalize(full) : path.resolve(base, full)
    const rel = path.relative(base, candidate)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
    return rel.split(path.sep).join("/")
  }
}

export function unavailableReasonForPath(filePath: string, serverInfo: unknown): string | undefined {
  if (process.env.INTELGRAPH_LSP_DISABLED === "1") return "language server disabled by INTELGRAPH_LSP_DISABLED"
  const language = lspLanguageForPath(filePath)
  if (!language || !Array.isArray(serverInfo)) return
  const entry = serverInfo.find(
    (item): item is { language?: unknown; unavailable?: unknown } =>
      typeof item === "object" && item !== null && "language" in item,
  )
  if (!entry) return
  for (const item of serverInfo) {
    if (typeof item !== "object" || item === null) continue
    const row = item as { language?: unknown; unavailable?: unknown }
    if (row.language !== language) continue
    if (typeof row.unavailable === "string" && row.unavailable.trim()) return row.unavailable.trim()
  }
}

function lspLanguageForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  if ([".c", ".h", ".m"].includes(ext)) return "c"
  if ([".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".mm", ".cu", ".cuh"].includes(ext)) return "cpp"
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript"
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript"
  if (ext === ".rs") return "rust"
  if ([".py", ".pyi"].includes(ext)) return "python"
  if (ext === ".go") return "go"
}

function fileWorkspaceRoot() {
  return Instance.directory || Instance.worktree || process.cwd()
}
