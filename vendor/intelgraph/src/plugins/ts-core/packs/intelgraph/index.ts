/**
 * packs/intelgraph/index.ts — intelgraph-specific TypeScript patterns.
 *
 * The intelgraph project IS the dogfood for ts-core. This pack is the
 * landing spot for any patterns specific to how intelgraph wires its
 * extractors, tool registry, daemon lifecycle, etc.
 *
 * Currently empty — the generic ts-core extractor already handles
 * intelgraph's `class`, `interface`, `function`, `method`, `field`,
 * `module`, and the standard edge kinds (`contains`, `calls`, `imports`,
 * `extends`, `implements`, `references_type`, `field_of_type`, `aggregates`).
 *
 * Future entries might capture:
 *   - The `defineExtractor({...})` factory pattern → emit a synthetic
 *     `extractor_plugin` edge so we can list every plugin without grep.
 *   - The `BUILT_IN_EXTRACTORS = [...]` registry in `src/plugins/index.ts`
 *     → emit `is_registered_extractor` edges for each entry.
 *   - The IntelGraph tool registry in `src/tools/index.ts` → similarly tag
 *     each tool definition.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { TsPatternPack } from "../types.js"

const intelgraphPack: TsPatternPack = {
  name: "intelgraph",
  description: "intelgraph-specific TypeScript patterns (extractor plugins, tool registry, daemon lifecycle).",

  contributesEdgeKinds: ["logs_event"],

  logPatterns: [
    // intelgraph uses src/logging/logger.ts exclusively
    { name: "log", level: "INFO", messageArgIndex: 1 }, // log("INFO", "message", ctx)
    { name: "logError", level: "ERROR", messageArgIndex: 0 }, // logError("message", err)
    // Logger class methods
    { name: "logger.info", level: "INFO", messageArgIndex: 0 },
    { name: "logger.debug", level: "DEBUG", messageArgIndex: 0 },
    { name: "logger.warn", level: "WARN", messageArgIndex: 0 },
    { name: "logger.error", level: "ERROR", messageArgIndex: 0 },
    // process.stderr.write is used for user-visible messages
    { name: "process.stderr.write", level: "INFO", messageArgIndex: 0 },
    // console.* (generic, any TS project)
    { name: "console.log", level: "INFO", messageArgIndex: 0 },
    { name: "console.error", level: "ERROR", messageArgIndex: 0 },
    { name: "console.warn", level: "WARN", messageArgIndex: 0 },
    { name: "console.debug", level: "DEBUG", messageArgIndex: 0 },
  ],

  appliesTo: (workspaceRoot: string) => {
    // Heuristic: an intelgraph checkout always has src/plugins/ + src/tools/
    // + src/intelligence/ at the top level. If any of these are missing,
    // the workspace is something else.
    return (
      existsSync(join(workspaceRoot, "src/plugins")) &&
      existsSync(join(workspaceRoot, "src/intelligence")) &&
      existsSync(join(workspaceRoot, "src/tools"))
    )
  },
}

export default intelgraphPack
