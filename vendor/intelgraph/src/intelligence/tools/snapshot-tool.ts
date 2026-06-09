/**
 * snapshot-tool.ts
 * Standalone snapshot lifecycle tool — begin/check/commit/fail via IDbFoundation.
 * Registered into TOOLS array from intelligence/tools/index.ts.
 */
import { z } from "zod"
import type { IDbFoundation } from "../contracts/db-foundation.js"

let DB_FOUNDATION: IDbFoundation | null = null

export function setDbFoundation(db: IDbFoundation): void {
  DB_FOUNDATION = db
}

export function getDbFoundation(): IDbFoundation | null {
  return DB_FOUNDATION
}

export const snapshotInputSchema = z.object({
  action: z.enum(["begin", "check", "commit", "fail"]).describe(
    "Snapshot lifecycle action: " +
    "begin=create new snapshot, " +
    "check=find latest ready snapshot for workspaceRoot, " +
    "commit=mark snapshot ready, " +
    "fail=mark snapshot failed",
  ),
  workspaceRoot: z.string().optional().describe("Workspace root path (required for begin and check)"),
  compileDbHash: z.string().optional().describe("Hash of compile_commands.json (required for begin)"),
  parserVersion: z.string().optional().describe("Parser version string (required for begin)"),
  snapshotId: z.number().int().positive().optional().describe("Snapshot ID (required for commit/fail)"),
  failReason: z.string().optional().describe("Failure reason (required for fail)"),
})

export async function executeSnapshotTool(args: z.infer<typeof snapshotInputSchema>): Promise<string> {
  if (!DB_FOUNDATION) {
    return "intelligence_snapshot: intelligence backend not initialized."
  }

  try {
    if (args.action === "begin") {
      if (!args.workspaceRoot || !args.compileDbHash) {
        return "intelligence_snapshot: workspaceRoot and compileDbHash are required for action=begin"
      }
      const res = await DB_FOUNDATION.beginSnapshot({
        workspaceRoot: args.workspaceRoot,
        compileDbHash: args.compileDbHash,
        parserVersion: args.parserVersion ?? "1.0.0",
      })
      return [
        "Snapshot started:",
        `  snapshotId:  ${res.snapshotId}`,
        `  status:      ${res.status}`,
        `  createdAt:   ${res.createdAt}`,
      ].join("\n")
    }

    if (args.action === "check") {
      if (!args.workspaceRoot) {
        return "intelligence_snapshot: workspaceRoot is required for action=check"
      }
      const res = await DB_FOUNDATION.getLatestReadySnapshot(args.workspaceRoot)
      if (!res) {
        return `No ready snapshot found for workspaceRoot: ${args.workspaceRoot}`
      }
      return [
        "Latest ready snapshot:",
        `  snapshotId:  ${res.snapshotId}`,
        `  status:      ${res.status}`,
        `  createdAt:   ${res.createdAt}`,
      ].join("\n")
    }

    if (args.action === "commit") {
      if (!args.snapshotId) {
        return "intelligence_snapshot: snapshotId is required for action=commit"
      }
      await DB_FOUNDATION.commitSnapshot(args.snapshotId)
      return `Snapshot committed: id=${args.snapshotId} status=ready`
    }

    if (!args.snapshotId) {
      return "intelligence_snapshot: snapshotId is required for action=fail"
    }
    const reason = args.failReason ?? "unknown"
    await DB_FOUNDATION.failSnapshot(args.snapshotId, reason)
    return `Snapshot failed: id=${args.snapshotId} reason=${reason}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `intelligence_snapshot: operation failed: ${msg}`
  }
}
