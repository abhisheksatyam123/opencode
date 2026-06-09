import type { InvocationReason, RuntimeFlowRecord } from "./contracts.js"

/**
 * Convert invocationReason into canonical invoker-centric runtime flow record.
 * Returns undefined when invocationReason is absent.
 */
export function toRuntimeFlowRecord(
  targetApi: string,
  invocationReason?: InvocationReason,
): RuntimeFlowRecord | undefined {
  if (!invocationReason) return undefined

  const chain = invocationReason.dispatchChain ?? []
  const immediateInvoker = chain[Math.max(0, chain.length - 2)] ?? chain[0] ?? ""

  return {
    targetApi,
    runtimeTrigger: invocationReason.runtimeTrigger,
    dispatchChain: chain,
    dispatchSite: invocationReason.dispatchSite,
    immediateInvoker,
  }
}
