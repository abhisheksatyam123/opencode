/**
 * Filesystem L1 — Public barrel (backward-compatible)
 *
 * Concrete implementation now lives in `impl/filesystem.ts`.
 * New code may import from `@/filesystem/contract/port`
 * and `@/filesystem/wiring/layer` directly.
 */

export * from "@/filesystem/impl/filesystem"
