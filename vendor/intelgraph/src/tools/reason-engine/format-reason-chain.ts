import type { ReasonPath } from "./contracts.js"
import { toRuntimeFlowRecord } from "./runtime-flow.js"

export interface FormattedReasonResult {
  reasonPaths: ReasonPath[]
  usedLlm: boolean
  rejected: number
  cacheHit: boolean
  cacheMismatchedFiles: string[]
}

type PathRenderer = (p: string) => string

export function formatReasonChainText(
  result: FormattedReasonResult,
  symbol: string,
  filePath: string,
  displayPath: PathRenderer,
): string {
  const lines: string[] = []
  const rel = displayPath(filePath)

  lines.push(`Invocation reason chain: ${symbol}  (${rel})`)
  lines.push(`  Cache: ${result.cacheHit ? "hit" : "miss"}  |  LLM used: ${result.usedLlm}  |  Rejected proposals: ${result.rejected}`)

  if (result.cacheMismatchedFiles.length) {
    lines.push(`  Stale files (hash mismatch):`)
    for (const f of result.cacheMismatchedFiles) lines.push(`    ${displayPath(f)}`)
  }

  if (!result.reasonPaths.length) {
    lines.push("")
    lines.push("  No invocation reason found.")
    if (!result.usedLlm && !result.cacheHit) {
      lines.push("  Enable llmReasoning in .intelgraph.json to run LLM-assisted analysis.")
    }
    return lines.join("\n")
  }

  for (let i = 0; i < result.reasonPaths.length; i++) {
    renderReasonPath(lines, result.reasonPaths[i], i, displayPath)
  }

  const runtimeFlows = result.reasonPaths
    .map((rp) => rp.runtimeFlow ?? toRuntimeFlowRecord(rp.targetSymbol, rp.invocationReason))
    .filter((rf): rf is NonNullable<typeof rf> => !!rf)

  if (runtimeFlows.length) {
    lines.push("")
    lines.push("---runtime-flow-json---")
    lines.push(JSON.stringify(runtimeFlows, null, 2))
    lines.push("---end-runtime-flow-json---")
  }

  return lines.join("\n")
}

function renderReasonPath(
  lines: string[],
  rp: ReasonPath,
  index: number,
  displayPath: PathRenderer,
): void {
  const ir = rp.invocationReason
  lines.push("")
  lines.push(`  Path ${index + 1}  [${rp.provenance}  confidence=${rp.confidence.score.toFixed(2)}]`)

  if (!ir) {
    lines.push(`  [legacy] registrarFn: ${rp.registrarFn ?? "(unknown)"}`)
    lines.push(`  [legacy] registrationApi: ${rp.registrationApi ?? "(unknown)"}`)
    lines.push(`  WARNING: invocationReason missing — this entry predates the three-layer contract.`)
    lines.push(`           Re-run with LLM enabled to get the full invocation reason.`)
    return
  }

  lines.push(`  ┌─ WHY (runtime trigger)`)
  lines.push(`  │  ${ir.runtimeTrigger}`)

  lines.push(`  ├─ HOW (dispatch chain)`)
  for (let j = 0; j < ir.dispatchChain.length; j++) {
    const isLast = j === ir.dispatchChain.length - 1
    lines.push(`${isLast ? "  │  └─ " : "  │  ├─ "}${ir.dispatchChain[j]}`)
  }
  lines.push(`  │  Dispatch site: ${displayPath(ir.dispatchSite.file)}:${ir.dispatchSite.line || "?"}`)
  if (ir.dispatchSite.snippet) lines.push(`  │    ${ir.dispatchSite.snippet}`)

  if (ir.registrationGate) {
    lines.push(`  └─ GATE (registration)`)
    lines.push(`     Registrar:  ${ir.registrationGate.registrarFn || "(unknown)"}`)
    lines.push(`     API:        ${ir.registrationGate.registrationApi || "(unknown)"}`)
    if (ir.registrationGate.conditions?.length) {
      lines.push(`     Conditions:`)
      for (const c of ir.registrationGate.conditions) lines.push(`       • ${c}`)
    }
  }
}
