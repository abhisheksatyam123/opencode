/**
 * Tool L3 — tool-card sub-module
 *
 * tool-card/ folds into Tool L3 per cycle resolution in dep-graph-v2.
 * This sub-module re-exports the ToolCard namespace from the original
 * tool-card/ location. The original src/tool-card/index.ts becomes a
 * barrel pointing here.
 *
 * Per dep-graph-v2: tool-card lives in Tool L3, NOT Permission L2.
 * The DA1 secondary cycle (workflow↔tool-card↔policy) is resolved by
 * placing tool-card here (Tool L3) rather than in Permission L2.
 */

export * from "@/tool/card/contract/port"
export { ToolCard } from "@/permission/tool-card/index"
