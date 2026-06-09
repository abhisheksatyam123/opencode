/**
 * Storage L1 — Port contract
 *
 * Exposes:
 *   - StorageKeySchema / StorageKey          — typed key path (string[])
 *   - StoragePortSchema                      — Zod schema for the port interface shape
 *   - StoragePort interface                  — read/write/update/remove/list surface
 *   - Storage.Service Effect.Tag             — DI tag for Effect Layer
 *   - Storage.NotFoundError                  — typed not-found error
 *
 * Depends only on Foundation L0 (zod, effect). No peer L1 imports.
 *
 * NOTE: Storage.Service Effect.Tag is declared here (contract-owned identity).
 * All callers should import from this file or from src/storage/layer.ts.
 */

import z from "zod"
import { ServiceMap, type Effect } from "effect"
export * from "@/storage/contract/version"
export * from "@/storage/contract/identity"
export * from "@/storage/contract/error"
export * from "@/storage/contract/event"
export * from "@/storage/contract/conformance"

// ── Key schema ────────────────────────────────────────────────────────────────

/**
 * A storage key is an ordered array of non-empty string segments.
 * Maps to a filesystem path: key.join("/") + ".json"
 */
export const StorageKeySchema = z.array(z.string().min(1)).min(1)
export type StorageKey = z.infer<typeof StorageKeySchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * StoragePort — abstract interface for JSON file persistence.
 *
 * All durable JSON state persistence routes through this port.
 * Concrete adapter lives in adapter.ts; wired via layer.ts.
 *
 * Error channel uses AppFileSystem.Error | NotFoundError from the concrete
 * adapter — callers should import error types from storage.ts directly.
 */
export interface StoragePort {
  /**
   * Remove a JSON file at the given key path. No-op if missing.
   */
  readonly remove: (key: StorageKey) => Effect.Effect<void, any>

  /**
   * Read and parse a JSON file at the given key path.
   * Fails with NotFoundError if the file does not exist.
   */
  readonly read: <T>(key: StorageKey) => Effect.Effect<T, any>

  /**
   * Read, mutate via fn, and write back atomically (write-lock).
   * Fails with NotFoundError if the file does not exist.
   */
  readonly update: <T>(key: StorageKey, fn: (draft: T) => void) => Effect.Effect<T, any>

  /**
   * Write a JSON file at the given key path. Creates parent dirs as needed.
   */
  readonly write: <T>(key: StorageKey, content: T) => Effect.Effect<void, any>

  /**
   * List all keys under the given prefix. Returns sorted key arrays.
   */
  readonly list: (prefix: StorageKey) => Effect.Effect<StorageKey[], any>
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Storage {
  export class Service extends ServiceMap.Service<Service, StoragePort>()("@opencode/Storage") {}
}

export const StorageService = Storage.Service
export type StorageService = Storage.Service
