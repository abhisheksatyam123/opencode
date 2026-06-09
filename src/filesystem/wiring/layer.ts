/**
 * Filesystem L1 — Effect Layer
 *
 * FilesystemLayer is the single entry point for wiring the Filesystem module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: AppFileSystem.Service (via FilesystemAdapterLayer)
 * Requires: FileSystem.FileSystem (from @effect/platform-node)
 *
 * Mirrors the Bus/Storage L1 pattern from bus/layer.ts + storage/layer.ts.
 *
 * Sub-area services (Git, Worktree, File, Patch, Pty, Shell) retain their
 * own Service tags and layers; they are NOT merged here to avoid introducing
 * new dep-cruiser violations. Each sub-area is wired independently at the
 * composition root.
 */

export { FilesystemAdapterLayer as FilesystemLayer } from "@/filesystem/impl"
export { AppFileSystem } from "@/filesystem/impl/filesystem"
