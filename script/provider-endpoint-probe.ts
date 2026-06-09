#!/usr/bin/env bun

import { randomBytes, randomUUID } from "node:crypto"

type Target = {
  id: string
  baseURL: string
  apiKey?: string
}

type ProbeKind = "openai-chat" | "openai-responses" | "anthropic-messages" | "vertex-generate"

type ProbeResult = {
  kind: ProbeKind
  url: string
  ok: boolean
  status: number | null
  category: "supported" | "unsupported" | "auth" | "error" | "network"
  reason: string
}

type ModelReport = {
  model: string
  family: "azure-openai" | "anthropic" | "vertex" | "unknown"
  preference: ProbeKind[]
  probes: ProbeResult[]
  supported: ProbeKind[]
  preferred: ProbeKind | null
}

function usage() {
  console.log(`provider-endpoint-probe

Usage:
  bun run script/provider-endpoint-probe.ts --targets qgenie,qpilot --models "azure::gpt-5.5,anthropic::claude-4-6-sonnet,vertexai::gemini-3.1-pro-preview"
  bun run script/provider-endpoint-probe.ts --targets qgenie --mode responses-only --models "azure::gpt-5.5,anthropic::claude-4-6-sonnet"

Env:
  QGENIE_BASE_URL      default: https://qgenie-api.qualcomm.com/v1
  QPILOT_BASE_URL      default: https://qpilot-api.qualcomm.com/v1
  QPILOT_API_KEY       bearer token for qpilot and qgenie
  PROVIDER_PROBE_TIMEOUT_MS  default: 20000
  PROVIDER_PROBE_MODE  matrix | responses-only (default: matrix)
`)
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith("--")) out[key] = "true"
    else {
      out[key] = value
      i++
    }
  }
  return out
}

function normalizeBaseURL(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function splitCSV(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
}

function inferFamily(model: string): ModelReport["family"] {
  const id = model.toLowerCase()
  if (
    id.startsWith("azure::") ||
    id.startsWith("azure/") ||
    id.startsWith("openai::") ||
    id.startsWith("openai/") ||
    id.includes("gpt-") ||
    id.includes("codex") ||
    id.includes("o1") ||
    id.includes("o3")
  ) {
    return "azure-openai"
  }
  if (id.startsWith("anthropic::") || id.includes("claude") || id.includes("anthropic")) return "anthropic"
  if (id.startsWith("vertexai::") || id.startsWith("vertex::") || id.startsWith("google::") || id.includes("gemini")) {
    return "vertex"
  }
  return "unknown"
}

function preferenceForFamily(family: ModelReport["family"]): ProbeKind[] {
  // Preference policy:
  // Anthropic -> /messages first
  // Vertex -> chat first on qgenie/qpilot proxy; messages/native paths are diagnostic.
  // Azure/OpenAI -> responses first (per qgenie/qpilot policy)
  switch (family) {
    case "anthropic":
      return ["anthropic-messages", "openai-chat", "openai-responses"]
    case "vertex":
      return ["openai-chat", "anthropic-messages", "vertex-generate", "openai-responses"]
    case "azure-openai":
      return ["openai-responses", "openai-chat"]
    default:
      return ["openai-chat", "openai-responses", "anthropic-messages", "vertex-generate"]
  }
}

function probePayload(kind: ProbeKind, model: string) {
  if (kind === "openai-chat") {
    return {
      path: "/chat/completions",
      body: {
        model,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      },
    }
  }
  if (kind === "openai-responses") {
    return {
      path: "/responses",
      body: {
        model,
        stream: false,
        max_output_tokens: 16,
        input: "ping",
      },
    }
  }
  if (kind === "anthropic-messages") {
    return {
      path: "/messages",
      body: {
        model,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      },
    }
  }
  return {
    path: `/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 16 },
    },
  }
}

function qualcommLikeHeaders(targetID: string, apiKey?: string): Record<string, string> {
  const turnID = randomUUID()
  const cliName = targetID === "qpilot" ? "qpilot_cli" : "qgenie_cli"
  const headers: Record<string, string> = {
    version: "0.1.12",
    "user-agent": `x86_64 / linux / terminal / ${cliName} / 0.1.12`,
    "x-encrypted-key": randomBytes(32).toString("hex"),
    "x-codex-beta-features": "multi_agent",
    "x-codex-turn-metadata": JSON.stringify({ turn_id: turnID, sandbox: "none" }),
    session_id: randomUUID(),
    accept: "text/event-stream",
    "content-type": "application/json",
    originator: "codex_cli_rs",
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

function classify(status: number | null, body: string): Pick<ProbeResult, "category" | "reason"> {
  const b = body.toLowerCase()
  if (status === null) return { category: "network", reason: "network_error" }
  if (status >= 200 && status < 300) return { category: "supported", reason: "ok" }
  if (status === 401 || status === 403) return { category: "auth", reason: "auth_failed" }
  if (status === 404 || status === 405) return { category: "unsupported", reason: "endpoint_not_supported" }
  if (status === 400) {
    if (b.includes("model") && (b.includes("not found") || b.includes("invalid"))) {
      return { category: "error", reason: "invalid_or_unknown_model" }
    }
    if (b.includes("unsupported") || b.includes("not supported") || b.includes("unknown endpoint")) {
      return { category: "unsupported", reason: "unsupported_request_shape" }
    }
    return { category: "error", reason: "bad_request" }
  }
  return { category: "error", reason: `http_${status}` }
}

async function runProbe(target: Target, model: string, kind: ProbeKind, timeoutMs: number): Promise<ProbeResult> {
  const { path, body } = probePayload(kind, model)
  const url = `${target.baseURL}${path}`
  const headers = qualcommLikeHeaders(target.id, target.apiKey)
  if (kind === "vertex-generate" && target.apiKey) headers["x-goog-api-key"] = target.apiKey

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => "")
    const meta = classify(res.status, text)
    return {
      kind,
      url,
      ok: meta.category === "supported",
      status: res.status,
      category: meta.category,
      reason: meta.reason,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind,
      url,
      ok: false,
      status: null,
      category: "network",
      reason,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function probeModelOnTarget(target: Target, model: string, timeoutMs: number): Promise<ModelReport> {
  const family = inferFamily(model)
  const preference = preferenceForFamily(family)
  const probes: ProbeResult[] = []

  for (const kind of preference) {
    const result = await runProbe(target, model, kind, timeoutMs)
    probes.push(result)
  }

  const supported = probes.filter((x) => x.ok).map((x) => x.kind)
  const preferred = preference.find((kind) => supported.includes(kind)) ?? null
  return { model, family, preference, probes, supported, preferred }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args["help"] === "true") {
    usage()
    return
  }

  const targets = splitCSV(args["targets"] ?? "qgenie,qpilot")
  const models = splitCSV(args["models"])
  const mode = (args["mode"] ?? process.env.PROVIDER_PROBE_MODE ?? "matrix").toLowerCase()
  const timeoutMs = Number(args["timeout-ms"] ?? process.env.PROVIDER_PROBE_TIMEOUT_MS ?? "20000")

  if (models.length === 0) {
    console.error("No models provided. Pass --models <csv>.")
    usage()
    process.exit(1)
  }

  const targetDefs: Target[] = targets.map((id) => {
    const key = id.toUpperCase()
    const envBase = process.env[`${key}_BASE_URL`]
    const envApiKey = id === "qgenie" || id === "qpilot" ? process.env.QPILOT_API_KEY : process.env[`${key}_API_KEY`]
    const defaultBase =
      id === "qgenie"
        ? "https://qgenie-api.qualcomm.com/v1"
        : id === "qpilot"
          ? "https://qpilot-api.qualcomm.com/v1"
          : ""
    const baseURL = normalizeBaseURL(envBase ?? defaultBase)
    return { id, baseURL, apiKey: envApiKey }
  })

  for (const target of targetDefs) {
    if (!target.baseURL) {
      console.error(`Missing base URL for target "${target.id}". Set ${target.id.toUpperCase()}_BASE_URL.`)
      process.exit(1)
    }
  }

  const report: Record<string, ModelReport[]> = {}
  for (const target of targetDefs) {
    const rows: ModelReport[] = []
    for (const model of models) {
      if (mode === "responses-only") {
        const family = inferFamily(model)
        const only: ModelReport = {
          model,
          family,
          preference: ["openai-responses"],
          probes: [await runProbe(target, model, "openai-responses", timeoutMs)],
          supported: [],
          preferred: null,
        }
        only.supported = only.probes.filter((x) => x.ok).map((x) => x.kind)
        only.preferred = only.supported[0] ?? null
        rows.push(only)
      } else {
        rows.push(await probeModelOnTarget(target, model, timeoutMs))
      }
    }
    report[target.id] = rows
  }

  for (const target of targetDefs) {
    console.log(`\n=== ${target.id} (${target.baseURL}) ===`)
    for (const row of report[target.id] ?? []) {
      const support = row.supported.length > 0 ? row.supported.join(", ") : "none"
      console.log(`model=${row.model}`)
      console.log(`  family=${row.family}`)
      console.log(`  supported=${support}`)
      console.log(`  preferred=${row.preferred ?? "none"}`)
      for (const p of row.probes) {
        console.log(
          `    - ${p.kind.padEnd(19)} status=${String(p.status ?? "NA").padEnd(4)} ${p.category} (${p.reason})`,
        )
      }
    }
  }

  console.log("\nJSON report:")
  console.log(JSON.stringify(report, null, 2))
}

void main()
