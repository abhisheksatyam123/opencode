/**
 * Filesystem L1 — Concrete adapter
 *
 * Wraps the existing AppFileSystem.layer from index.ts as a named export
 * following the Bus/Storage L1 pattern (adapter.ts → layer.ts → index.ts).
 *
 * Depends on:
 *   - ./index.ts (AppFileSystem — concrete impl, Effect Layer)
 *
 * NOTE: AppFileSystem.layer has pre-existing deps on @effect/platform-node
 * and util/glob (Foundation L0). These are counted in the 38-violation
 * baseline. This file does NOT introduce new violations.
 */

import { AppFileSystem } from "@/filesystem/impl/filesystem"

/**
 * FilesystemAdapterLayer — Effect Layer providing AppFileSystem.Service
 * via the concrete Node.js filesystem adapter.
 * Import this in layer.ts to compose FilesystemLayer.
 *
 * Requires: FileSystem.FileSystem (from @effect/platform-node)
 */
export const FilesystemAdapterLayer = AppFileSystem.layer

export { AppFileSystem } from "@/filesystem/impl/filesystem"
