/**
 * Storage L1 — Effect Layer
 *
 * StorageLayer is the single entry point for wiring the Storage module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: Storage.Service
 * Requires: AppFileSystem.Service (pre-existing dep in storage.ts adapter)
 *
 * Mirrors the Bus L1 pattern from bus/layer.ts (commit c452847).
 */

export { StorageAdapterLayer as StorageLayer } from "@/storage/impl/adapter"
export { Storage } from "@/storage/contract/port"
