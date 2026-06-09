import type { ProposedReasonPath } from "./llm-advisor.js"
import type { ILogger } from "../../logging/ports.js"
import { loggerPort } from "../../logging/logger.js"

export interface ValidationOutcome {
  accepted: ProposedReasonPath[]
  rejected: Array<{ path: ProposedReasonPath; reason: string }>
}

/**
 * Validate LLM-proposed reason paths.
 *
 * Rejection criteria (any one fails the path):
 *   missing-required-files   — requiredFiles is empty
 *   low-confidence           — confidence < 0.5
 *   missing-invocation-reason — invocationReason is absent
 *   missing-runtime-trigger  — invocationReason.runtimeTrigger is empty or too short
 *   missing-dispatch-chain   — invocationReason.dispatchChain has < 2 entries
 *   missing-dispatch-site    — invocationReason.dispatchSite.file is empty
 *   registration-gate is supporting context only and does not reject by itself
 */
export function validateReasonProposals(
  proposals: ProposedReasonPath[] | undefined,
  logger?: ILogger,
): ValidationOutcome {
  const log = logger ?? loggerPort
  const accepted: ProposedReasonPath[] = []
  const rejected: Array<{ path: ProposedReasonPath; reason: string }> = []

  for (const p of proposals ?? []) {
    const reason = firstRejectionReason(p)
    if (reason) {
      log.warn("proposal-validator: rejected", {
        registrarFn: p.registrarFn,
        reason,
        confidence: p.confidence,
        hasInvocationReason: !!p.invocationReason,
        rationale: p.rationale?.slice(0, 100),
      })
      rejected.push({ path: p, reason })
    } else {
      log.debug("proposal-validator: accepted", {
        registrarFn: p.registrarFn,
        confidence: p.confidence,
        runtimeTrigger: p.invocationReason?.runtimeTrigger?.slice(0, 80),
        dispatchChainLength: p.invocationReason?.dispatchChain?.length,
      })
      accepted.push(p)
    }
  }

  return { accepted, rejected }
}

function firstRejectionReason(p: ProposedReasonPath): string | null {
  // Basic quality gates
  if (!p.requiredFiles || p.requiredFiles.length === 0) {
    return "missing-required-files"
  }
  if ((p.confidence ?? 0) < 0.5) {
    return "low-confidence"
  }

  // invocationReason is required — it is the primary output
  const ir = p.invocationReason
  if (!ir) {
    return "missing-invocation-reason"
  }

  // Layer C: runtimeTrigger must be a non-trivial human-readable event description
  if (!ir.runtimeTrigger || ir.runtimeTrigger.trim().length < 10) {
    return "missing-runtime-trigger"
  }

  // Layer B: dispatchChain must have at least 2 entries (entry-point + target)
  if (!ir.dispatchChain || ir.dispatchChain.length < 2) {
    return "missing-dispatch-chain"
  }

  // Layer B: dispatchSite.file must be a non-empty path
  if (!ir.dispatchSite?.file || ir.dispatchSite.file.trim().length === 0) {
    return "missing-dispatch-site"
  }

  // Layer A (registration) is supporting metadata only for invoker-centric mode.
  // Do not reject when registration gate details are absent.

  return null
}
