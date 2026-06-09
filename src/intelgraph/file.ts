import { Buffer } from "node:buffer"
import { existsSync } from "node:fs"
import { realpath, stat, writeFile } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import { getDefaultIntelGraphRuntime } from "@/intelgraph/backend/runtime"

type IntelGraphFile = {
  path: string
  workspace_relative: string
  content: string
  line_count: number
  size_bytes: number
}

export class IntelGraphFileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "IntelGraphFileError"
  }
}

const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".html",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
])
const MAX_EDIT_BYTES = 1 * 1024 * 1024

export async function intelGraphLspDefinition(
  workspaceRoot: string,
  input: { file: string; line: number; character: number },
): Promise<unknown[]> {
  return getDefaultIntelGraphRuntime(workspaceRoot).definition(input)
}

export async function intelGraphLspServerInfo(workspaceRoot: string): Promise<unknown | undefined> {
  return getDefaultIntelGraphRuntime(workspaceRoot)
    .serverInfo()
    .catch(() => undefined)
}

export function ensureTextPath(path: string) {
  if (!TEXT_EXTS.has(extname(path).toLowerCase())) {
    throw new IntelGraphFileError("extension_not_supported", "file extension not supported", 400, { path })
  }
}

export function ensureEditableSize(bytes: number) {
  if (bytes > MAX_EDIT_BYTES) {
    throw new IntelGraphFileError("file_too_large", "file exceeds 1 MiB edit limit", 413, {
      bytes,
      max_bytes: MAX_EDIT_BYTES,
    })
  }
}

export async function resolveExistingWorkspaceFile(workspaceRoot: string, input: string) {
  const root = resolve(workspaceRoot)
  const full = resolveWorkspacePath(root, input)
  if (!existsSync(full)) throw new IntelGraphFileError("file_not_found", "file not found", 404, { path: input })
  const [realRoot, realFull] = await Promise.all([realpath(root).catch(() => root), realpath(full)])
  if (!inside(realRoot, realFull)) {
    throw new IntelGraphFileError("workspace_forbidden", "path escapes workspace", 403, { path: input })
  }
  ensureTextPath(realFull)
  const info = await stat(realFull)
  if (!info.isFile()) throw new IntelGraphFileError("file_not_found", "path is not a file", 404, { path: input })
  return { root: realRoot, full: realFull, info }
}

export async function writeIntelGraphFile(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<IntelGraphFile> {
  ensureEditableSize(Buffer.byteLength(content, "utf8"))
  const { root, full } = await resolveExistingWorkspaceFile(workspaceRoot, path)
  await writeFile(full, content, "utf8")
  const nextInfo = await stat(full)
  return fileResponse(root, full, content, nextInfo.size)
}

function resolveWorkspacePath(root: string, input: string) {
  const normalized = input.replace(/\\/g, "/")
  const full = resolve(root, normalized)
  if (!inside(root, full))
    throw new IntelGraphFileError("workspace_forbidden", "path escapes workspace", 403, { path: input })
  return full
}

function fileResponse(root: string, full: string, content: string, size: number): IntelGraphFile {
  return {
    path: full,
    workspace_relative: normalizeRel(relative(root, full)),
    content,
    line_count: content.split(/\r?\n/).length,
    size_bytes: size,
  }
}

function normalizeRel(path: string) {
  return path.split(sep).join("/")
}

function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}
