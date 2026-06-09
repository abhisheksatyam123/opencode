/**
 * intelligence/tools/index.ts
 * Self-contained registration barrel for all intelligence-bounded-context tools.
 * Exports individual schemas/executors for use by the HTTP API and CLI.
 */
export { ingestInputSchema, executeIngestTool, setIngestDeps } from "./ingest-tool.js"
export { snapshotInputSchema, executeSnapshotTool, setDbFoundation, getDbFoundation } from "./snapshot-tool.js"
export { extractFileInputSchema, executeExtractFileTool, setExtractFileDeps } from "./extract-file-tool.js"
