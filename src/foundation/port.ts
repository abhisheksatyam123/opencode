import z from "zod"

// ── Log ──────────────────────────────────────────────────────────────────────
export const LogLevelSchema = z.enum(["DEBUG", "INFO", "WARN", "ERROR"])
export type LogLevel = z.infer<typeof LogLevelSchema>

export const LogOptionsSchema = z.object({
  print: z.boolean(),
  dev: z.boolean().optional(),
  level: LogLevelSchema.optional(),
})
export type LogOptions = z.infer<typeof LogOptionsSchema>

// ── Error ─────────────────────────────────────────────────────────────────────
export const ErrorDataSchema = z.object({
  type: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  cause: z.string().optional(),
  formatted: z.string().optional(),
})
export type ErrorData = z.infer<typeof ErrorDataSchema>

// ── Filesystem ────────────────────────────────────────────────────────────────
export const FilesystemWriteOptionsSchema = z.object({
  mode: z.number().optional(),
})
export type FilesystemWriteOptions = z.infer<typeof FilesystemWriteOptionsSchema>

// ── Flag ──────────────────────────────────────────────────────────────────────
export const FlagNameSchema = z.string().min(1)
export type FlagName = z.infer<typeof FlagNameSchema>

// ── Id ────────────────────────────────────────────────────────────────────────
export const IdPrefixSchema = z.enum([
  "event",
  "session",
  "message",
  "permission",
  "question",
  "user",
  "part",
  "pty",
  "tool",
  "workspace",
])
export type IdPrefix = z.infer<typeof IdPrefixSchema>

export const IdSchema = z.string().min(1)
export type Id = z.infer<typeof IdSchema>

// ── Lazy ──────────────────────────────────────────────────────────────────────
// Lazy is a pure function utility — no Zod schema needed, just type export
export type LazyFactory<T> = () => T & { reset: () => void }

// ── FoundationPort ────────────────────────────────────────────────────────────
// Foundation exports concrete utilities directly (it is the only module
// permitted to do so). This port schema documents the shape of the module.
export const FoundationPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type FoundationPort = z.infer<typeof FoundationPortSchema>
