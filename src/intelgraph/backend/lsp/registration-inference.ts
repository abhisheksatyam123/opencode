import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { collectAllDispatchChains } from "@intelgraph/plugins/clangd-core/packs/index.js"
import { findEnclosingCall, findEnclosingConstruct } from "@intelgraph/tools/pattern-detector/c-parser.js"
import registrationPatterns from "./registration-patterns.json" with { type: "json" }
import { isIntelGraphPrimarySourcePath } from "../source-path-policy"
import type { IntelGraphLspIndirectCaller, IntelGraphLspLocation } from "../resolver/dynamic-resolver"

type RegistrationPatterns = {
  macroApiAliases: Array<{ macro: string; api: string }>
  signalRegistrationApiPattern: string
  linkedDispatchApiPattern: string
  dispatchKeyArgRules: Array<{ apiPattern: string; argIndex: number }>
}

const patterns = registrationPatterns as RegistrationPatterns
const macroApiAliases = patterns.macroApiAliases
const signalRegistrationApiPattern = new RegExp(patterns.signalRegistrationApiPattern)
const linkedDispatchApiPattern = new RegExp(patterns.linkedDispatchApiPattern, "i")
const dispatchKeyArgRules = patterns.dispatchKeyArgRules.map((rule) => ({
  apiPattern: new RegExp(rule.apiPattern, "i"),
  argIndex: rule.argIndex,
}))

export type IntelGraphRegistrationInferenceRequest = {
  file: string
  line: number
  character?: number
  symbol: string
  limit: number
}

export function inferRuntimeCallersFromTextReferences(
  root: string | undefined,
  request: IntelGraphRegistrationInferenceRequest,
): IntelGraphLspIndirectCaller[] {
  if (!root) return []
  const refs = textReferenceLocations(root, request.symbol, request.file)
  const callers: IntelGraphLspIndirectCaller[] = []
  for (const ref of refs) {
    if (callers.length >= request.limit) break
    const file = uriToPath(ref.uri)
    const line = ref.range?.start?.line
    const character = ref.range?.start?.character
    if (!file || typeof line !== "number" || typeof character !== "number") continue
    if (isSameLocation(file, line, request.file, request.line)) continue
    const source = readFileText(file)
    if (!source) continue
    const structCaller = runtimeCallerFromStructAssignment(root, source, line, request.symbol)
    if (structCaller) {
      callers.push(structCaller)
      continue
    }

    const call = findEnclosingCall(source, line, character) ?? findEnclosingConstruct(source, line, character)
    const sourceText = call?.fullText ?? statementAroundLine(source, line)
    const registrationApi = registrationApiFromSource(sourceText)
    if (!registrationApi) continue
    const caller = runtimeCallerFromRegistration(registrationApi, request.symbol, sourceText)
    if (caller) callers.push(caller)
    callers.push(...runtimeCallersFromLinkedRegistration(root, registrationApi, request.symbol, sourceText))
  }
  return mergeIndirectCallers([], callers)
}

export function mergeIndirectCallers(
  primary: IntelGraphLspIndirectCaller[],
  supplemental: IntelGraphLspIndirectCaller[],
): IntelGraphLspIndirectCaller[] {
  const merged: IntelGraphLspIndirectCaller[] = []
  const seen = new Set<string>()
  for (const caller of [...primary, ...supplemental]) {
    const key = [caller.callerRole, caller.symbol, caller.file ?? "", caller.line ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(caller)
  }
  return merged
}

export function indirectCallersFromGraph(graph: { nodes?: any[] }, root?: string): IntelGraphLspIndirectCaller[] {
  const callers: IntelGraphLspIndirectCaller[] = []
  const seen = new Set<string>()
  for (const node of graph.nodes ?? []) {
    const chain = node?.resolvedChain
    if (chain?.dispatch?.dispatchFunction) {
      const symbol = canonicalizeSymbol(chain.dispatch.dispatchFunction)
      if (!symbol) continue
      const file = preferSrcPath(chain.dispatch.dispatchFile ?? node.file)
      const line =
        typeof chain.dispatch.dispatchLine === "number" ? chain.dispatch.dispatchLine + 1 : numberOrUndefined(node.line)
      const key = ["runtime_caller", symbol, file ?? "", line ?? ""].join("|")
      if (seen.has(key)) continue
      seen.add(key)
      callers.push({
        symbol,
        file,
        line,
        callerRole: "runtime_caller",
        invocationType: "runtime_dispatch_table_call",
        registrationApi: node.classification?.registrationApi ?? node.name,
        confidence: confidenceFromChain(chain),
        source: "lsp_indirect_callers",
        detail: chain.dispatch.evidence ?? node.sourceText,
      })
      continue
    }

    const templateCaller = runtimeCallerFromDispatchTemplate(node)
    if (templateCaller) {
      const additions = [templateCaller, ...linkedCallersForGraphNode(root, node)]
      for (const addition of additions) {
        const key = ["runtime_caller", addition.symbol, addition.file ?? "", addition.line ?? ""].join("|")
        if (!seen.has(key)) {
          seen.add(key)
          callers.push(addition)
        }
      }
      continue
    }

    const symbol = canonicalizeSymbol(node?.name ?? "")
    if (!symbol) continue
    const file = preferSrcPath(node.file)
    const line = numberOrUndefined(node.line)
    const key = ["registrar", symbol, file ?? "", line ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    callers.push({
      symbol,
      file,
      line,
      callerRole: "registrar",
      invocationType: classificationToInvocationType(node.classification?.connectionKind),
      registrationApi: node.classification?.registrationApi,
      confidence: 0.5,
      source: "lsp_indirect_callers",
      detail: node.sourceText,
    })
  }
  return callers
}

function runtimeCallerFromRegistration(
  registrationApi: string,
  callbackName: string,
  sourceText: string,
): IntelGraphLspIndirectCaller | undefined {
  const template = collectAllDispatchChains().get(registrationApi)
  if (!template) return runtimeCallerFromGenericRegistration(registrationApi, callbackName, sourceText)
  const dispatchKey = dispatchKeyForRegistration(registrationApi, sourceText)
  const chain = template.chain.map((item) =>
    item.replace(/%CALLBACK%/g, canonicalizeSymbol(callbackName)).replace(/%KEY%/g, dispatchKey ?? ""),
  )
  const symbol = runtimeLabelForRegistration(registrationApi, runtimeFunctionFromTemplateChain(chain), dispatchKey)
  if (!symbol || symbol === canonicalizeSymbol(callbackName)) return undefined
  return {
    symbol,
    callerRole: "runtime_caller",
    invocationType: "runtime_dispatch_table_call",
    registrationApi,
    confidence: 0.75,
    source: "text_reference_dispatch_template",
    detail: `template-chain:[${chain.join(" → ")}]; registration:${sourceText.trim().slice(0, 200)}`,
  }
}

function runtimeCallerFromGenericRegistration(
  registrationApi: string,
  callbackName: string,
  sourceText: string,
): IntelGraphLspIndirectCaller | undefined {
  if (/unregister/i.test(registrationApi)) return undefined
  const args = callArguments(sourceText, registrationApi)
  const callbackIndex = args.findIndex((arg) => new RegExp(`\\b${escapeRegex(callbackName)}\\b`).test(arg))
  if (callbackIndex < 0) return undefined
  const key = genericRegistrationKey(args, callbackIndex)
  const symbol = key ? `${registrationApi}.${key}` : registrationApi
  return {
    symbol,
    callerRole: "runtime_caller",
    invocationType: "runtime_callback_registration_call",
    registrationApi,
    confidence: 0.65,
    source: "tree_sitter_generic_registration",
    detail: `generic-registration:${registrationApi}${key ? `; key:${key}` : ""}; registration:${sourceText.trim().slice(0, 200)}`,
  }
}

function callArguments(sourceText: string, registrationApi: string): string[] {
  const start = sourceText.indexOf(registrationApi)
  if (start < 0) return []
  const open = sourceText.indexOf("(", start + registrationApi.length)
  if (open < 0) return []
  const close = matchingCloseParen(sourceText, open)
  if (close < 0) return []
  return splitArguments(sourceText.slice(open + 1, close)).map((arg) => arg.trim())
}

function matchingCloseParen(sourceText: string, open: number): number {
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = open; index < sourceText.length; index++) {
    const char = sourceText[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") depth++
    else if (char === ")") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function genericRegistrationKey(args: string[], callbackIndex: number): string | undefined {
  const candidates = args.slice(0, callbackIndex).reverse()
  return candidates
    .map(
      (arg) =>
        /\b([A-Z][A-Z0-9_]{2,})\b/.exec(arg)?.[1] ?? /\b([A-Za-z_][A-Za-z0-9_]*ID[A-Za-z0-9_]*)\b/.exec(arg)?.[1],
    )
    .find(Boolean)
}

function dispatchKeyForRegistration(registrationApi: string, sourceText: string): string | undefined {
  if (isSignalRegistrationApi(registrationApi)) return signalFromThreadRegistration(sourceText)
  const rule = dispatchKeyArgRules.find((item) => item.apiPattern.test(registrationApi))
  return rule ? argumentAt(sourceText, rule.argIndex) : undefined
}

function runtimeLabelForRegistration(registrationApi: string, dispatchSymbol: string, dispatchKey?: string) {
  const symbol = canonicalizeSymbol(dispatchSymbol)
  if (!symbol) return symbol
  if (dispatchKey && isSignalRegistrationApi(registrationApi)) {
    return `${symbol}.${dispatchKey}`
  }
  if (dispatchKey && linkedDispatchApiPattern.test(registrationApi)) {
    return `${dispatchLabelPrefixFromApi(registrationApi)}.${dispatchKey}`
  }
  return symbol
}

function runtimeCallerFromStructAssignment(
  root: string,
  source: string,
  zeroBasedLine: number,
  callbackName: string,
): IntelGraphLspIndirectCaller | undefined {
  const assignment = parseCallbackAssignment(source.split(/\r?\n/)[zeroBasedLine] ?? "", callbackName)
  if (!assignment) return undefined
  const registration = findStructRegistration(source, zeroBasedLine, assignment.base)
  if (!registration) return undefined
  return runtimeCallerFromRegistrationField(registration.api, callbackName, assignment.field, registration.sourceText)
}

function parseCallbackAssignment(line: string, callbackName: string): { base: string; field: string } | undefined {
  const pattern = new RegExp(
    String.raw`(?<target>[A-Za-z_][\w]*(?:\s*(?:->|\.)\s*[A-Za-z_][\w]*)*)\s*=\s*(?:\([^)]*\)\s*)?&?\b${escapeRegex(callbackName)}\b`,
  )
  const match = pattern.exec(line)
  const target = match?.groups?.target?.replace(/\s+/g, "")
  if (!target) return undefined
  const separator = Math.max(target.lastIndexOf("."), target.lastIndexOf("->"))
  if (separator < 0) return undefined
  const field = target.slice(target.startsWith("->", separator) ? separator + 2 : separator + 1)
  const base = target.slice(0, separator)
  if (!base || !field) return undefined
  return { base, field }
}

function findStructRegistration(
  source: string,
  zeroBasedAssignmentLine: number,
  baseExpression: string,
): { api: string; sourceText: string } | undefined {
  const lines = source.split(/\r?\n/)
  const normalizedBase = normalizeExpression(baseExpression)
  for (let offset = 0; offset < 160; offset++) {
    const line = lines[zeroBasedAssignmentLine + offset]
    if (!line) continue
    const stripped = stripCommentsFromLine(line, { inBlockComment: false }).text
    const registrationApi = registrationApiFromSource(stripped)
    const api = registrationApi
    if (!api) continue
    const column = Math.max(0, (line ?? "").indexOf(api))
    const sourceText = statementAroundLine(source, zeroBasedAssignmentLine + offset) || stripped.trim()
    if (registrationMentionsBase(sourceText, normalizedBase)) return { api, sourceText }
  }
  return undefined
}

function registrationMentionsBase(sourceText: string, normalizedBase: string) {
  const normalized = normalizeExpression(sourceText)
  return (
    normalized.includes(`&${normalizedBase}`) ||
    normalized.includes(`(${normalizedBase})`) ||
    normalized.includes(normalizedBase)
  )
}

function runtimeCallerFromRegistrationField(
  registrationApi: string,
  callbackName: string,
  field: string,
  sourceText: string,
): IntelGraphLspIndirectCaller | undefined {
  const template = collectAllDispatchChains().get(registrationApi)
  if (!template) return undefined
  const chain = template.chain.map((item) =>
    item.replace(/%CALLBACK%/g, canonicalizeSymbol(callbackName)).replace(/%KEY%/g, field),
  )
  const dispatchSymbol = runtimeFunctionFromTemplateChain(chain)
  const symbol = runtimeFieldLabel(registrationApi, dispatchSymbol, field)
  if (!symbol) return undefined
  return {
    symbol,
    callerRole: "runtime_caller",
    invocationType: "runtime_struct_callback_registration",
    registrationApi,
    confidence: 0.85,
    source: "text_reference_struct_field_registration",
    detail: `struct-field:${field}; template-chain:[${chain.join(" → ")}]; registration:${sourceText.trim().slice(0, 200)}`,
  }
}

function structFieldLabelPrefixFromApi(registrationApi: string): string | undefined {
  const callbackMatch = /^(.+?)[_-]?register[_-]?callback$/i.exec(registrationApi)
  if (callbackMatch?.[1]) return normalizeLabelPrefix(callbackMatch[1])
  const serviceMatch = /^(.+?)[_-]?RegisterService$/i.exec(registrationApi)
  if (serviceMatch?.[1]) return `${normalizeLabelPrefix(serviceMatch[1])}_ServiceDispatch`
  return undefined
}

function dispatchLabelPrefixFromApi(registrationApi: string): string {
  const dispatch = registrationApi.replace(/register/gi, "dispatch").replace(/_dynamic$/i, "")
  return normalizeLabelPrefix(dispatch)
}

function normalizeLabelPrefix(value: string): string {
  return value.replace(/[_-]+$/g, "").replace(/^[_-]+/g, "")
}

function runtimeFieldLabel(registrationApi: string, dispatchSymbol: string, field: string) {
  const inferredPrefix = structFieldLabelPrefixFromApi(registrationApi)
  if (inferredPrefix) return `${inferredPrefix}.${field}`
  const canonical = canonicalizeSymbol(dispatchSymbol)
  return canonical ? `${canonical}.${field}` : field
}

function runtimeCallersFromLinkedRegistration(
  root: string,
  registrationApi: string,
  callbackName: string,
  sourceText: string,
): IntelGraphLspIndirectCaller[] {
  if (!isSignalRegistrationApi(registrationApi)) return []
  const signal = signalFromThreadRegistration(sourceText)
  if (!signal) return []
  const sources = findLinkedDispatchRegistrations(root, signal)
  return sources.flatMap(({ api, source }) => {
    const caller = runtimeCallerFromRegistration(api, callbackName, source)
    const irq = dispatchKeyForRegistration(api, source)
    if (!caller) return []
    return [
      {
        ...caller,
        symbol: irq ? `${dispatchLabelPrefixFromApi(api)}.${irq}` : caller.symbol,
        invocationType: "runtime_irq_signal_dispatch",
        registrationApi: api,
        detail: `${caller.detail}; irq:${irq ?? "unknown"}; signal:${signal}; signal-registration:${sourceText.trim().slice(0, 160)}`,
      },
    ]
  })
}

function isSignalRegistrationApi(api: string) {
  return signalRegistrationApiPattern.test(api)
}

function signalFromThreadRegistration(sourceText: string): string | undefined {
  return (
    /\b([A-Z][A-Z0-9_]*SIGNAL[A-Z0-9_]*|WLAN_THREAD_[A-Za-z0-9_]+)\b/.exec(sourceText)?.[1] ?? argumentAt(sourceText, 1)
  )
}

function argumentAt(sourceText: string, index: number): string | undefined {
  const open = sourceText.indexOf("(")
  const close = sourceText.lastIndexOf(")")
  if (open < 0 || close <= open) return undefined
  return splitArguments(sourceText.slice(open + 1, close))[index]?.trim()
}

function splitArguments(value: string): string[] {
  const result: string[] = []
  let start = 0
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") depth--
    else if (char === "," && depth === 0) {
      result.push(value.slice(start, index))
      start = index + 1
    }
  }
  result.push(value.slice(start))
  return result
}

function findLinkedDispatchRegistrations(root: string, token: string): Array<{ api: string; source: string }> {
  const tokenPattern = new RegExp(`\\b${escapeRegex(token)}\\b`)
  const registrations: Array<{ api: string; source: string }> = []
  const seen = new Set<string>()
  let scanned = 0
  const visit = (dir: string) => {
    if (scanned >= MAX_TEXT_REFERENCE_FILES) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= MAX_TEXT_REFERENCE_FILES) return
      if (entry.isDirectory()) {
        if (!SKIPPED_REFERENCE_DIRS.has(entry.name) && entry.name !== "rom") visit(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !isReferenceCandidateFile(entry.name)) continue
      scanned++
      const text = readFileText(join(dir, entry.name))
      if (!text) continue
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        const api = registrationApiFromSource(trimmed)
        if (!api || !linkedDispatchApiPattern.test(api) || !tokenPattern.test(trimmed)) continue
        const source = extractCallExpression(trimmed, api) ?? trimmed
        const key = `${api}:${source}`
        if (seen.has(key)) continue
        seen.add(key)
        registrations.push({ api, source })
      }
    }
  }
  const base = join(root, "wlan_proc", "wlan")
  visit(existsSync(base) ? base : root)
  return registrations
}

function extractCallExpression(sourceText: string, api: string): string | undefined {
  const start = sourceText.indexOf(api)
  if (start < 0) return undefined
  const open = sourceText.indexOf("(", start + api.length)
  if (open < 0) return undefined
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = open; index < sourceText.length; index++) {
    const char = sourceText[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") depth++
    else if (char === ")") {
      depth--
      if (depth === 0) return sourceText.slice(start, index + 1)
    }
  }
  return sourceText.slice(start)
}

function normalizeExpression(value: string) {
  return value.replace(/\s+/g, "")
}

function statementAroundLine(source: string, zeroBasedLine: number): string {
  const lines = source.split(/\r?\n/)
  let start = zeroBasedLine
  while (start > 0 && zeroBasedLine - start < 8) {
    const previous = lines[start - 1]?.trim() ?? ""
    if (!previous || /[;{}]$/.test(previous)) break
    start--
  }
  let end = zeroBasedLine
  while (end < lines.length - 1 && end - zeroBasedLine < 20) {
    const current = lines[end]?.trim() ?? ""
    if (current.includes(";")) break
    end++
  }
  return lines
    .slice(start, end + 1)
    .join(" ")
    .trim()
}

function registrationApiFromSource(source: string): string | undefined {
  const macroAlias = macroApiAliases.find((item) => new RegExp(`\\b${escapeRegex(item.macro)}\\s*\\(`).test(source))
  if (macroAlias) return macroAlias.api
  const explicit = /\b([A-Za-z_][\w]*(?:register|Register|attach|Attach|install|Install)[A-Za-z0-9_]*)\s*\(/.exec(
    source,
  )?.[1]
  if (explicit && !/unregister/i.test(explicit)) return explicit
  for (const api of collectAllDispatchChains().keys()) {
    if (source.includes(api)) return api
  }
  return undefined
}

function readFileText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function isSameLocation(file: string, zeroBasedLine: number, targetFile: string, oneBasedLine: number) {
  return file === targetFile && zeroBasedLine + 1 === oneBasedLine
}

const TEXT_REFERENCE_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".hpp"])
const SKIPPED_REFERENCE_DIRS = new Set([".git", ".cache", "node_modules", "out", "build", "dist", "components"])
const MAX_TEXT_REFERENCE_FILES = 8000
const MAX_TEXT_REFERENCES = 200

export function textReferenceLocations(root: string, symbol: string, targetFile: string, maxReferences = MAX_TEXT_REFERENCES): IntelGraphLspLocation[] {
  const locations: IntelGraphLspLocation[] = []
  const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g")
  let scanned = 0
  const visit = (dir: string) => {
    if (locations.length >= maxReferences || scanned >= MAX_TEXT_REFERENCE_FILES) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (locations.length >= maxReferences || scanned >= MAX_TEXT_REFERENCE_FILES) return
      if (entry.isDirectory()) {
        if (!SKIPPED_REFERENCE_DIRS.has(entry.name) && entry.name !== "rom") visit(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !isReferenceCandidateFile(entry.name)) continue
      const file = join(dir, entry.name)
      if (!isIntelGraphPrimarySourcePath(file)) continue
      scanned++
      addTextReferences(file, pattern, locations, maxReferences)
    }
  }
  const scopes = prioritizedReferenceScopes(root, targetFile)
  for (const scope of scopes) {
    if (locations.length >= maxReferences || scanned >= MAX_TEXT_REFERENCE_FILES) break
    if (existsSync(scope)) visit(scope)
  }
  return dedupeLocations(locations)
}

function prioritizedReferenceScopes(root: string, targetFile: string): string[] {
  const normalized = targetFile.replace(/\\/g, "/")
  const scopes: string[] = []
  const directory = normalized.slice(0, normalized.lastIndexOf("/"))
  if (directory) scopes.push(directory)
  const wlanMarker = "/wlan_proc/wlan/"
  const wlanIndex = normalized.indexOf(wlanMarker)
  if (wlanIndex >= 0) {
    const afterWlan = normalized.slice(wlanIndex + wlanMarker.length).split("/")
    if (afterWlan[0]) scopes.push(normalized.slice(0, wlanIndex + wlanMarker.length + afterWlan[0].length))
    scopes.push(normalized.slice(0, wlanIndex + wlanMarker.length - 1))
  }
  const srcMarker = "/src/"
  const srcIndex = normalized.indexOf(srcMarker)
  if (srcIndex > 0) scopes.push(normalized.slice(0, srcIndex + srcMarker.length - 1))
  scopes.push(root)
  return [...new Set(scopes)]
}

function dedupeLocations(locations: IntelGraphLspLocation[]): IntelGraphLspLocation[] {
  const seen = new Set<string>()
  return locations.filter((location) => {
    const key = `${location.uri ?? ""}:${location.range?.start?.line ?? ""}:${location.range?.start?.character ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function addTextReferences(file: string, pattern: RegExp, locations: IntelGraphLspLocation[], maxReferences = MAX_TEXT_REFERENCES) {
  let info
  try {
    info = statSync(file)
  } catch {
    return
  }
  if (info.size > 2 * 1024 * 1024) return
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return
  }
  const lines = text.split(/\r?\n/)
  let inBlockComment = false
  for (let line = 0; line < lines.length && locations.length < maxReferences; line++) {
    pattern.lastIndex = 0
    const stripped = stripCommentsFromLine(lines[line] ?? "", { inBlockComment })
    inBlockComment = stripped.inBlockComment
    for (
      let match = pattern.exec(stripped.text);
      match && locations.length < maxReferences;
      match = pattern.exec(stripped.text)
    ) {
      locations.push({
        uri: `file://${file}`,
        range: {
          start: { line, character: match.index },
          end: { line, character: match.index + match[0].length },
        },
      })
    }
  }
}

function stripCommentsFromLine(line: string, state: { inBlockComment: boolean }) {
  let text = ""
  let index = 0
  let inBlockComment = state.inBlockComment
  while (index < line.length) {
    if (inBlockComment) {
      const end = line.indexOf("*/", index)
      if (end < 0) return { text, inBlockComment: true }
      index = end + 2
      inBlockComment = false
      continue
    }
    const block = line.indexOf("/*", index)
    const slash = line.indexOf("//", index)
    const next = [block, slash].filter((value) => value >= 0).sort((a, b) => a - b)[0]
    if (next === undefined) {
      text += line.slice(index)
      break
    }
    text += line.slice(index, next)
    if (next === slash) break
    inBlockComment = true
    index = next + 2
  }
  return { text, inBlockComment }
}

function isReferenceCandidateFile(name: string) {
  const dot = name.lastIndexOf(".")
  return dot >= 0 && TEXT_REFERENCE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

function linkedCallersForGraphNode(root: string | undefined, node: any): IntelGraphLspIndirectCaller[] {
  const api = registrationApiFromNode(node)
  if (!root || !api || !isSignalRegistrationApi(api)) return []
  const callbackName = canonicalizeSymbol(node?.name ?? "")
  if (!callbackName) return []
  const sourceText = typeof node?.sourceText === "string" ? node.sourceText : ""
  return runtimeCallersFromLinkedRegistration(root, api, callbackName, sourceText)
}

function runtimeCallerFromDispatchTemplate(node: any): IntelGraphLspIndirectCaller | undefined {
  const registrationApi = registrationApiFromNode(node)
  const dispatchKey = typeof node?.classification?.dispatchKey === "string" ? node.classification.dispatchKey : ""
  if (!registrationApi) return undefined
  const template = collectAllDispatchChains().get(registrationApi)
  if (!template) return undefined
  const chain = template.chain.map((item) =>
    item.replace(/%CALLBACK%/g, canonicalizeSymbol(node?.name ?? "")).replace(/%KEY%/g, dispatchKey),
  )
  const symbol = canonicalizeSymbol(runtimeFunctionFromTemplateChain(chain))
  if (!symbol) return undefined
  return {
    symbol,
    callerRole: "runtime_caller",
    invocationType: "runtime_dispatch_table_call",
    registrationApi,
    confidence: 0.8,
    source: "lsp_indirect_callers",
    detail: `template-chain:[${chain.join(" → ")}]`,
  }
}

function registrationApiFromNode(node: any): string | undefined {
  if (typeof node?.classification?.registrationApi === "string") return node.classification.registrationApi
  const source = typeof node?.sourceText === "string" ? node.sourceText : ""
  if (!source) return undefined
  return registrationApiFromSource(source)
}

function runtimeFunctionFromTemplateChain(chain: string[]) {
  if (chain.length >= 3) return chain[1] ?? chain[chain.length - 2] ?? chain[0] ?? ""
  return chain[0] ?? ""
}

function classificationToInvocationType(connectionKind?: string) {
  if (connectionKind === "api_call") return "direct_call"
  if (connectionKind === "hw_interrupt" || connectionKind === "ring_signal") return "runtime_function_pointer_call"
  if (connectionKind === "timer_callback") return "runtime_callback_registration_call"
  return "interface_registration"
}

function confidenceFromChain(chain: any) {
  const score = Number(chain?.confidenceScore)
  if (Number.isFinite(score)) return Math.max(0, Math.min(1, score / 5))
  return 0.8
}

function preferSrcPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined
  const p = path.trim()
  if (!p) return undefined
  return p
    .replace(/\\/g, "/")
    .replace(/\/(rom\/[^/]+|v[0-9]+rom|ramv[0-9]+)\/(patch|orig)\//g, "/src/")
    .replace(/\/(rom\/[^/]+|v[0-9]+rom|ramv[0-9]+)\//g, "/src/")
    .replace(/_patch(?=\.[^./]+$)/, "")
}

function canonicalizeSymbol(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  const canonical = trimmed.replace(/^_+/, "").replace(/___[A-Za-z0-9_]+$/, "")
  return canonical || trimmed
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function uriToPath(uri: unknown) {
  if (typeof uri !== "string") return undefined
  if (!uri.startsWith("file://")) return uri || undefined
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""))
  } catch {
    return uri.replace(/^file:\/\//, "")
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
