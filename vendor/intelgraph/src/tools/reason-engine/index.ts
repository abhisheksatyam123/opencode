import type { ILanguageClient } from "../../lsp/ports.js"
import { requestReasonProposals, type LlmReasoningConfig } from "./llm-advisor.js"
import { validateReasonProposals } from "./proposal-validator.js"
import type { ReasonPath } from "./contracts.js"
import { computeFileHash, readLlmDbEntry, verifyHashManifest, writeLlmDbEntry } from "./db.js"
import type { ILogger } from "../../logging/ports.js"
import { loggerPort } from "../../logging/logger.js"
import { toRuntimeFlowRecord } from "./runtime-flow.js"

export interface ReasonEngineInput {
  targetSymbol: string
  targetFile: string
  targetLine: number
  knownEvidence: Array<{ file: string; line: number; text: string }>
  suspectedPatterns: string[]
  workspaceRoot?: string
}

export async function runReasonEngine(
  client: ILanguageClient,
  input: ReasonEngineInput,
  llmConfig?: LlmReasoningConfig,
  logger?: ILogger,
): Promise<{
  reasonPaths: ReasonPath[]
  usedLlm: boolean
  rejected: number
  cacheHit: boolean
  cacheMismatchedFiles: string[]
}> {
  const log = logger ?? loggerPort
  const workspaceRoot = input.workspaceRoot || client.root
  const connectionKey = `${workspaceRoot}::${input.targetSymbol}::${input.targetFile}:${input.targetLine}`

  log.info("reason-engine: start", {
    symbol: input.targetSymbol,
    file: input.targetFile,
    line: input.targetLine,
    llmEnabled: llmConfig?.enabled ?? false,
    evidenceCount: input.knownEvidence.length,
    suspectedPatterns: input.suspectedPatterns,
  })

  // ── Cache read ──────────────────────────────────────────────────────────────
  const cached = readLlmDbEntry(workspaceRoot, connectionKey)

  if (cached) {
    const verify = verifyHashManifest(cached.hashManifest)
    if (verify.ok) {
      log.info("reason-engine: cache hit", {
        symbol: input.targetSymbol,
        pathCount: cached.reasonPaths.length,
        cachedAt: cached.createdAt,
      })
      return {
        reasonPaths: cached.reasonPaths,
        usedLlm: false,
        rejected: 0,
        cacheHit: true,
        cacheMismatchedFiles: [],
      }
    }

    log.warn("reason-engine: cache stale (hash mismatch)", {
      symbol: input.targetSymbol,
      mismatchedFiles: verify.mismatchedFiles,
      llmEnabled: llmConfig?.enabled ?? false,
    })

    if (!llmConfig?.enabled) {
      return {
        reasonPaths: [],
        usedLlm: false,
        rejected: 0,
        cacheHit: false,
        cacheMismatchedFiles: verify.mismatchedFiles,
      }
    }
    // LLM enabled — fall through to refresh
  } else {
    log.info("reason-engine: cache miss (no entry)", { symbol: input.targetSymbol })
    if (!llmConfig?.enabled) {
      log.info("reason-engine: LLM disabled, returning empty", { symbol: input.targetSymbol })
      return { reasonPaths: [], usedLlm: false, rejected: 0, cacheHit: false, cacheMismatchedFiles: [] }
    }
  }

  // ── LLM path ────────────────────────────────────────────────────────────────
  log.info("reason-engine: calling LLM", {
    symbol: input.targetSymbol,
    model: llmConfig!.model,
    maxCallsPerQuery: llmConfig!.maxCallsPerQuery,
    evidenceCount: input.knownEvidence.length,
  })

  const proposals = await requestReasonProposals(
    llmConfig!,
    {
      targetSymbol: input.targetSymbol,
      targetFile: input.targetFile,
      targetLine: input.targetLine,
      knownEvidence: input.knownEvidence,
      suspectedPatterns: input.suspectedPatterns,
    },
    { client, workspaceRoot },
    log,
  )

  if (!proposals) {
    log.warn("reason-engine: LLM returned null (no API key, disabled, or JSON parse failed)", {
      symbol: input.targetSymbol,
    })
    return { reasonPaths: [], usedLlm: false, rejected: 0, cacheHit: false, cacheMismatchedFiles: [] }
  }

  log.info("reason-engine: LLM proposals received", {
    symbol: input.targetSymbol,
    proposedCount: proposals.proposedPaths?.length ?? 0,
    openQuestions: proposals.openQuestions ?? [],
  })

  const validated = validateReasonProposals(proposals.proposedPaths, log)

  if (validated.rejected.length > 0) {
    log.warn("reason-engine: proposals rejected by validator", {
      symbol: input.targetSymbol,
      rejectedCount: validated.rejected.length,
      reasons: validated.rejected.map((r) => ({ rationale: r.path.rationale?.slice(0, 80), reason: r.reason })),
    })
  }

  log.info("reason-engine: validation complete", {
    symbol: input.targetSymbol,
    accepted: validated.accepted.length,
    rejected: validated.rejected.length,
  })

  const mapped: ReasonPath[] = validated.accepted.map((p) => {
    const runtimeFlow = toRuntimeFlowRecord(input.targetSymbol, p.invocationReason)

    return {
      targetSymbol: input.targetSymbol,
      registrarFn: p.registrarFn,
      registrationApi: p.registrationApi,
      storageFieldPath: p.storageFieldPath,
      gates: p.gates ?? [],
      evidence: p.requiredFiles.map((file) => ({ role: "llm-required-file", file, line: 1 })),
      provenance: "llm_validated" as const,
      confidence: { score: p.confidence, reasons: ["llm-validated"] },
      invocationReason: p.invocationReason,
      runtimeFlow,
    }
  })

  // ── Persist ─────────────────────────────────────────────────────────────────
  if (mapped.length > 0) {
    const requiredFiles = Array.from(new Set(mapped.flatMap((rp) => rp.evidence.map((e) => e.file))))
    const hashManifest: Record<string, string> = {}
    for (const f of requiredFiles) {
      const h = computeFileHash(f)
      if (h) hashManifest[f] = h
    }
    writeLlmDbEntry(workspaceRoot, {
      connectionKey,
      targetSymbol: input.targetSymbol,
      reasonPaths: mapped,
      requiredFiles,
      hashManifest,
      createdAt: new Date().toISOString(),
    })
    log.info("reason-engine: persisted to cache", {
      symbol: input.targetSymbol,
      pathCount: mapped.length,
      requiredFiles,
    })
  } else {
    log.warn("reason-engine: no accepted paths to persist", { symbol: input.targetSymbol })
  }

  return {
    reasonPaths: mapped,
    usedLlm: true,
    rejected: validated.rejected.length,
    cacheHit: false,
    cacheMismatchedFiles: cached ? verifyHashManifest(cached.hashManifest).mismatchedFiles : [],
  }
}

// ── IReasonEngine binding ────────────────────────────────────────────────────
//
// Real-implementation binding for the port declared in ./ports.ts.

import type { IReasonEngine } from "./ports.js"

export const reasonEngine: IReasonEngine = {
  run: (client, input, llmConfig) => runReasonEngine(client, input, llmConfig, loggerPort),
}
