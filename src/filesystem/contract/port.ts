/**
 * Filesystem L1 — Port contract
 *
 * Exposes:
 *   - DirEntrySchema / DirEntry              — typed directory entry
 *   - GlobOptionsSchema / GlobOptions        — glob options
 *   - FindUpOptionsSchema / FindUpOptions    — findUp options
 *   - FilesystemPort interface               — file I/O surface
 *   - Filesystem.Service Effect.Tag          — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 (zod, effect). No peer L1 imports.
 */

import z from "zod"
import { Effect, ServiceMap } from "effect"
export * from "@/filesystem/contract/version"
export * from "@/filesystem/contract/identity"
export * from "@/filesystem/contract/error"
export * from "@/filesystem/contract/event"
export * from "@/filesystem/contract/conformance"

// ── DirEntry schema ───────────────────────────────────────────────────────────

export const DirEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
})
export type DirEntry = z.infer<typeof DirEntrySchema>

// ── Glob options schema ───────────────────────────────────────────────────────

export const GlobOptionsSchema = z.object({
  cwd: z.string().optional(),
  absolute: z.boolean().optional(),
  include: z.enum(["file", "directory", "all"]).optional(),
  dot: z.boolean().optional(),
})
export type GlobOptions = z.infer<typeof GlobOptionsSchema>

// ── FindUp options schema ─────────────────────────────────────────────────────

export const FindUpOptionsSchema = z.object({
  targets: z.array(z.string().min(1)).min(1),
  start: z.string().min(1),
  stop: z.string().optional(),
})
export type FindUpOptions = z.infer<typeof FindUpOptionsSchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * FilesystemPort — abstract interface for the AppFileSystem service.
 *
 * Provides higher-level file I/O operations on top of Effect's FileSystem.
 * Concrete adapter lives in adapter.ts; wired via layer.ts.
 */
export interface FilesystemPort {
  readonly isDir: (path: string) => Effect.Effect<boolean>
  readonly isFile: (path: string) => Effect.Effect<boolean>
  readonly existsSafe: (path: string) => Effect.Effect<boolean>
  readonly readJson: (path: string) => Effect.Effect<unknown, any>
  readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, any>
  readonly ensureDir: (path: string) => Effect.Effect<void, any>
  readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, any>
  readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], any>
  readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], any>
  readonly up: (options: FindUpOptions) => Effect.Effect<string[], any>
  readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], any>
  readonly glob: (pattern: string, options?: GlobOptions) => Effect.Effect<string[], any>
  readonly globMatch: (pattern: string, filepath: string) => boolean
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Filesystem {
  /**
   * Effect.Tag for the Filesystem service (AppFileSystem).
   * Concrete impl provided by FilesystemLayer in layer.ts.
   * Callers: `yield* Filesystem.Service` to access FilesystemPort.
   */
  export class Service extends ServiceMap.Service<Service, FilesystemPort>()("@opencode/Filesystem") {}
}
