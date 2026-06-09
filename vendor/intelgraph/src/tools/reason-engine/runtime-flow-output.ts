import type { ReasonPath } from "./contracts.js"
import { toRuntimeFlowRecord } from "./runtime-flow.js"

export interface RuntimeFlowPayload {
  targetApi: string
  cacheHit: boolean
  usedLlm: boolean
  staleFiles: string[]
  runtimeFlows: ReturnType<typeof toRuntimeFlowRecord>[]
}

export function buildRuntimeFlowPayload(
  targetApi: string,
  result: {
    reasonPaths: ReasonPath[]
    cacheHit: boolean
    usedLlm: boolean
    cacheMismatchedFiles: string[]
  },
): RuntimeFlowPayload {
  const runtimeFlows = result.reasonPaths
    .map((rp) => rp.runtimeFlow ?? toRuntimeFlowRecord(rp.targetSymbol, rp.invocationReason))
    .filter((rf): rf is NonNullable<typeof rf> => !!rf)

  return {
    targetApi,
    cacheHit: result.cacheHit,
    usedLlm: result.usedLlm,
    staleFiles: result.cacheMismatchedFiles,
    runtimeFlows,
  }
}
