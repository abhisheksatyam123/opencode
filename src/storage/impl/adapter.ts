/**
 * Storage L1 — Concrete adapter
 *
 * Wraps the existing Storage.layer from storage.ts as a named export
 * following the Bus L1 pattern (adapter.ts → layer.ts → index.ts).
 *
 * Depends on:
 *   - storage.ts (concrete impl — JSON file persistence via AppFileSystem)
 *   - snapshot/index.ts is NOT folded here: it depends on Config (L2) and
 *     AppFileSystem (L1 peer), which would introduce new violations.
 *     See Open questions in task note.
 *
 * NOTE: The concrete Storage.layer in storage.ts has pre-existing L1 peer
 * deps (AppFileSystem, Git) counted in the 38-violation baseline. This file
 * does NOT introduce new violations — it only re-exports the existing layer.
 */

import { Storage } from "@/storage/impl/storage"

/**
 * StorageAdapterLayer — Effect Layer providing Storage.Service via the
 * concrete JSON-file adapter. Import this in layer.ts to compose StorageLayer.
 *
 * Requires: AppFileSystem.Service (pre-existing dep in storage.ts)
 */
export const StorageAdapterLayer = Storage.layer

export { Storage } from "@/storage/impl/storage"
