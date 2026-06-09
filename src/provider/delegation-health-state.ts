import * as fs from "fs/promises"
import path from "path"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/filesystem/global"
import { Provider } from "@/provider/provider"
import { Log } from "@/foundation/util/log"

const log = Log.create({ service: "delegation-health-state" })

export const MAX_RECORDS = 20_000

export const DelegationHealthRecord = z.object({
  at: z.string(),
  endpoint: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  success: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  errorClass: z.enum(["halt", "retry", "fallback-immediately", "unknown"]).optional(),
  rateLimited: z.boolean().optional(),
})
export type DelegationHealthRecord = z.infer<typeof DelegationHealthRecord>

export const DelegationHealthStateFile = z.object({
  version: z.literal("1.0"),
  records: z.array(DelegationHealthRecord),
})
export type DelegationHealthStateFile = z.infer<typeof DelegationHealthStateFile>

export interface DelegationHealthStats {
  key: string
  endpoint: string
  providerID: string
  modelID: string
  calls: number
  successes: number
  failures: number
  failureRate: number
  meanLatencyMs: number
  lastSuccessAt: number
  lastFailureAt: number
  rateLimitFailures: number
  lastRateLimitedAt: number
  consecutiveRateLimits: number
}

function statePath(): string {
  return path.join(Global.Path.state, "delegation-health.json")
}

function key(endpoint: string, providerID: string, modelID: string): string {
  return `${endpoint}|${providerID}|${modelID}`
}

async function readRaw(): Promise<DelegationHealthStateFile> {
  try {
    const raw = await fs.readFile(statePath(), "utf8")
    const parsed = DelegationHealthStateFile.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      log.warn("delegation-health.read.invalid", { error: parsed.error.message })
      return { version: "1.0", records: [] }
    }
    return parsed.data
  } catch {
    return { version: "1.0", records: [] }
  }
}

async function writeRaw(state: DelegationHealthStateFile): Promise<void> {
  const p = statePath()
  const tmp = `${p}.tmp`
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, p)
}

function normalizedEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return ""
  return raw.trim().replace(/\/+$/, "")
}

function isQualcommProviderID(providerID: string): providerID is "qpilot" | "qgenie" {
  return providerID === "qpilot" || providerID === "qgenie"
}

function hasRouteSuffix(endpoint: string): boolean {
  const lower = endpoint.toLowerCase()
  return lower.endsWith("/messages") || lower.endsWith("/chat/completions") || lower.endsWith("/responses")
}

function inferredQualcommPath(input: {
  providerID: "qpilot" | "qgenie"
  modelID: string
  modelEndpoint?: string
  modelProviderNpm?: string
}): string {
  switch (
    Provider.qualcommModelRoute(input.providerID, input.modelID, {
      endpoint: input.modelEndpoint,
      npm: input.modelProviderNpm,
    })
  ) {
    case "anthropic":
      return "/messages"
    case "openai-chat":
      return "/chat/completions"
    case "openai-responses":
      return "/responses"
  }
}

export function resolveDelegationEndpoint(input: {
  providerID: string
  modelID: string
  config?: Awaited<ReturnType<typeof Config.get>>
}): string {
  const cfg = input.config ?? Config.getSync?.()
  const providerCfg = cfg?.provider?.[input.providerID] as
    | {
        options?: Record<string, unknown>
        models?: Record<string, { endpoint?: string; provider?: { npm?: string } } | undefined>
      }
    | undefined

  const baseRaw =
    normalizedEndpoint(providerCfg?.options?.["endpoint"]) || normalizedEndpoint(providerCfg?.options?.["baseURL"])
  const base = isQualcommProviderID(input.providerID)
    ? (Provider.normalizeQualcommBaseURL(input.providerID, baseRaw) ?? baseRaw)
    : baseRaw
  const modelCfg = providerCfg?.models?.[input.modelID]
  const modelEndpoint = normalizedEndpoint(modelCfg?.endpoint)
  const modelProviderNpm = modelCfg?.provider?.npm

  if (modelEndpoint && /^https?:\/\//.test(modelEndpoint)) {
    return isQualcommProviderID(input.providerID)
      ? (Provider.normalizeQualcommBaseURL(input.providerID, modelEndpoint) ?? modelEndpoint)
      : modelEndpoint
  }
  if (base && modelEndpoint) return `${base}${modelEndpoint.startsWith("/") ? "" : "/"}${modelEndpoint}`
  if (base && isQualcommProviderID(input.providerID)) {
    if (hasRouteSuffix(base)) return base
    return `${base}${inferredQualcommPath({
      providerID: input.providerID,
      modelID: input.modelID,
      modelEndpoint,
      modelProviderNpm,
    })}`
  }
  if (base) return base
  if (modelEndpoint) return modelEndpoint
  return input.providerID
}

export namespace DelegationHealthState {
  export async function append(input: {
    providerID: string
    modelID: string
    success: boolean
    latencyMs: number
    errorClass?: "halt" | "retry" | "fallback-immediately" | "unknown"
    rateLimited?: boolean
    endpoint?: string
    at?: string
  }): Promise<void> {
    const state = await readRaw()
    const endpoint =
      normalizedEndpoint(input.endpoint) ||
      resolveDelegationEndpoint({
        providerID: input.providerID,
        modelID: input.modelID,
      })
    state.records.push({
      at: input.at ?? new Date().toISOString(),
      endpoint,
      providerID: input.providerID,
      modelID: input.modelID,
      success: input.success,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      ...(input.rateLimited === true ? { rateLimited: true } : {}),
    })
    if (state.records.length > MAX_RECORDS) {
      state.records = state.records.slice(state.records.length - MAX_RECORDS)
    }
    await writeRaw(state)
  }

  export async function snapshot(): Promise<Record<string, DelegationHealthStats>> {
    const state = await readRaw()
    const out: Record<string, DelegationHealthStats> = {}
    for (const rec of state.records) {
      const k = key(rec.endpoint, rec.providerID, rec.modelID)
      let s = out[k]
      if (!s) {
        s = {
          key: k,
          endpoint: rec.endpoint,
          providerID: rec.providerID,
          modelID: rec.modelID,
          calls: 0,
          successes: 0,
          failures: 0,
          failureRate: 0,
          meanLatencyMs: 0,
          lastSuccessAt: 0,
          lastFailureAt: 0,
          rateLimitFailures: 0,
          lastRateLimitedAt: 0,
          consecutiveRateLimits: 0,
        }
        out[k] = s
      }
      s.calls++
      if (rec.success) s.successes++
      else s.failures++
      s.meanLatencyMs = s.meanLatencyMs + (rec.latencyMs - s.meanLatencyMs) / s.calls
      const at = Date.parse(rec.at)
      const atMs = Number.isFinite(at) ? at : 0
      if (rec.success) {
        if (atMs > s.lastSuccessAt) s.lastSuccessAt = atMs
        s.consecutiveRateLimits = 0
      } else {
        if (atMs > s.lastFailureAt) s.lastFailureAt = atMs
        if (rec.rateLimited) {
          s.rateLimitFailures++
          if (atMs > s.lastRateLimitedAt) s.lastRateLimitedAt = atMs
          s.consecutiveRateLimits++
        } else {
          s.consecutiveRateLimits = 0
        }
      }
    }
    for (const s of Object.values(out)) {
      s.failureRate = s.calls > 0 ? s.failures / s.calls : 0
    }
    return out
  }

  export async function clear(): Promise<void> {
    await writeRaw({ version: "1.0", records: [] })
  }
}
