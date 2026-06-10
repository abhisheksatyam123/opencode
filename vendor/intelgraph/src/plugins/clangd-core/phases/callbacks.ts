/**
 * phases/callbacks.ts — Phase 5: callback registration + runtime_calls +
 * HW entity materialization.
 *
 * Detects three patterns of indirect function invocation:
 *   5a) Function-call registration: request_irq(IRQ, handler)
 *   5b) Struct-field initializer:   .read = handler in file_operations
 *   5c) Function-body assignment:   ptr->field = handler
 *
 * For each detected registration, emits:
 *   - registers_callback edge (registrar → callback)
 *   - runtime_calls edge with dispatch chain (if template matches)
 *   - HW entity nodes + dispatches_to edges (if pack defines HW entities
 *     matching chain steps)
 *
 * Generic C/C++ logic. Project knowledge comes from the pack parameters:
 *   - callPatterns: which APIs register callbacks
 *   - dispatchTemplateMap: which APIs have known dispatch chains
 *   - hwEntities: which chain steps are HW blocks/interrupts/timers/etc.
 */

import { parseSourceWith, findAllNodes, walkAst } from "../../../tools/pattern-detector/c-parser.js"
import type { CallPattern } from "../packs/types.js"
import type { DispatchChainTemplate, HWEntityDef } from "../packs/types.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

/** Pack-provided data for Phase 5. */
export interface CallbackPhaseConfig {
  callPatterns: CallPattern[]
  dispatchTemplateMap: Map<string, DispatchChainTemplate>
  hwEntities: {
    byName: Map<string, HWEntityDef>
    byChainStep: Map<string, HWEntityDef>
  }
}

/** Plain-JS extraction results from a single-pass AST walk (no tree-sitter nodes retained). */
interface RawRegistration {
  kind: "call" | "init" | "assign"
  registrar: string
  callbackName: string
  registrationKind: string
  dispatchKey: string
  containerType?: string
  line: number
  file: string
}

export async function* extractCallbacks(ctx: PhaseCtx, fileSymbols: FileSymbolMap, config: CallbackPhaseConfig) {
  const { callPatterns, dispatchTemplateMap, hwEntities } = config
  const registrationApis = new Set(callPatterns.map((p) => p.registrationApi))
  const emittedHWNodes = new Set<string>()

  // Build set of all known function names for fast membership test.
  // Phase 1 (symbols.ts) already populated fileSymbols with AST-fallback
  // entries when LSP was unavailable, so this set is always populated.
  const knownFunctions = new Set<string>()
  for (const syms of fileSymbols.values()) {
    for (const s of syms) {
      if (s.kind === "function") knownFunctions.add(s.name)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function* emitRegistration(
    registrar: string,
    callbackName: string,
    registrationKind: string,
    dispatchKey: string,
    file: string,
    line: number,
  ) {
    yield ctx.edge({
      payload: {
        edgeKind: "registers_callback",
        srcSymbolName: registrar,
        dstSymbolName: callbackName,
        confidence: 0.9,
        derivation: "clangd",
        metadata: { registrationKind, dispatchKey },
        evidence: { sourceKind: "file_line", location: { filePath: file, line } },
      },
    })
    ctx.metrics.count("edges.registers_callback")
  }

  function* emitRuntimeCall(
    tmplKey: string,
    callbackName: string,
    dispatchKey: string,
    file: string,
    line: number,
    detectedStructType?: string,
  ) {
    // Try exact template match
    let tmpl = dispatchTemplateMap.get(tmplKey)

    // Struct-field match using actual detected type
    if (!tmpl && detectedStructType && dispatchKey) {
      const cleanType = detectedStructType.replace(/\b(static|const|volatile|struct|enum|union)\b/g, "").trim()
      const syntheticKey = `__struct_field:${cleanType}.${dispatchKey}`
      tmpl = dispatchTemplateMap.get(syntheticKey)

      // Generic struct-type fallback: adapt another field's template
      if (!tmpl) {
        const prefix = `__struct_field:${cleanType}.`
        for (const [key, candidate] of dispatchTemplateMap) {
          if (key.startsWith(prefix)) {
            tmpl = {
              ...candidate,
              registrationApi: syntheticKey,
              chain: candidate.chain.map((s: string) => {
                if (s.includes("->") && !s.includes("%")) {
                  const parts = s.split("->")
                  parts[parts.length - 1] = dispatchKey
                  return parts.join("->")
                }
                return s
              }),
              triggerDescription: candidate.triggerDescription.replace(
                /\b\w+\b(?= dispatch| handler| callback)/,
                dispatchKey,
              ),
            }
            break
          }
        }
      }
    }
    if (!tmpl) return

    const chain = tmpl.chain.map((s: string) => s.replace(/%CALLBACK%/g, callbackName).replace(/%KEY%/g, dispatchKey))

    // Emit the runtime_calls edge
    yield ctx.edge({
      payload: {
        edgeKind: "runtime_calls",
        srcSymbolName: chain.length >= 3 ? chain[chain.length - 2] : chain[0],
        dstSymbolName: callbackName,
        confidence: 0.9,
        derivation: "clangd",
        metadata: {
          dispatchChain: chain,
          registrationApi: tmplKey,
          dispatchKey,
          triggerKind: tmpl.triggerKind,
          triggerDescription: tmpl.triggerDescription
            .replace(/%KEY%/g, dispatchKey)
            .replace(/%CALLBACK%/g, callbackName),
        },
        evidence: { sourceKind: "file_line", location: { filePath: file, line } },
      },
    })
    ctx.metrics.count("edges.runtime_calls")

    // Materialize HW entity nodes + dispatches_to edges
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]
      const hwEntity = hwEntities.byChainStep.get(step)
      if (!hwEntity) continue

      if (!emittedHWNodes.has(hwEntity.name)) {
        emittedHWNodes.add(hwEntity.name)
        yield ctx.symbol({
          payload: {
            kind: "function",
            name: hwEntity.name,
            metadata: {
              hwEntityKind: hwEntity.kind,
              isHWEntity: true,
              description: hwEntity.description,
            },
          },
        })
        ctx.metrics.count(`hw_entities.${hwEntity.kind}`)
      }

      const nextStep = chain[i + 1]
      if (nextStep) {
        yield ctx.edge({
          payload: {
            edgeKind: "dispatches_to",
            srcSymbolName: hwEntity.name,
            dstSymbolName: nextStep,
            confidence: 0.9,
            derivation: "clangd",
            metadata: {
              hwEntityKind: hwEntity.kind,
              dispatchChainPosition: i,
              triggerKind: tmpl.triggerKind,
            },
            evidence: { sourceKind: "file_line", location: { filePath: file, line } },
          },
        })
        ctx.metrics.count("edges.dispatches_to")
      }
    }
  }

  // Strip transparent single-arg macro wrappers (e.g. OFFLDMGR_FN(fn) → fn)
  function unwrapMacro(arg: string): string {
    const m = arg.match(/^[A-Z_][A-Z0-9_]*\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/)
    return m ? m[1] : arg
  }

  // ── Per-file extraction ──────────────────────────────────────────────────

  for (const [file] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    // Parse once, extract all registration data as plain JS, delete tree immediately
    const registrations =
      parseSourceWith(text, (root): RawRegistration[] => {
        const results: RawRegistration[] = []

        // ── 5a) Function-call registrations ──────────────────────────────────
        const callNodes = findAllNodes(root, "call_expression")
        for (const callNode of callNodes) {
          const fnNode = callNode.childForFieldName?.("function")
          if (!fnNode || fnNode.type !== "identifier") continue
          if (!registrationApis.has(fnNode.text)) continue

          const calleeName = fnNode.text
          const pattern = callPatterns.find((p: any) => p.registrationApi === calleeName)
          if (!pattern) continue

          const argsNode = callNode.childForFieldName?.("arguments")
          if (!argsNode) continue
          const argTexts: string[] = []
          for (let i = 0; i < argsNode.childCount; i++) {
            const child = argsNode.child(i)
            if (!child || child.type === "(" || child.type === ")" || child.type === ",") continue
            argTexts.push(child.text.trim())
          }

          let callbackName: string | null = null
          for (const arg of argTexts) {
            const bare = unwrapMacro(arg)
            if (knownFunctions.has(bare)) {
              callbackName = bare
              break
            }
          }
          if (!callbackName) continue

          const dispatchKey = argTexts[pattern.keyArgIndex] ?? ""
          const callLine = (callNode.startPosition?.row ?? 0) + 1

          results.push({
            kind: "call",
            registrar: calleeName,
            callbackName,
            registrationKind: "function_call",
            dispatchKey,
            line: callLine,
            file,
          })
        }

        // ── 5b) Struct-field initializer registrations ──────────────────────
        const initPairs = findAllNodes(root, "initializer_pair")
        for (const pair of initPairs) {
          let fieldName: string | null = null
          let valueName: string | null = null
          for (let i = 0; i < pair.childCount; i++) {
            const child = pair.child(i)
            if (!child) continue
            if (child.type === "field_designator") {
              fieldName = child.text?.replace(/^\./, "").trim() ?? null
            }
            if (child.type === "identifier" && knownFunctions.has(child.text)) {
              valueName = child.text
            }
          }
          if (!fieldName || !valueName) continue

          let containerVar: string | null = null
          let containerType: string | null = null
          let parent = pair.parent
          while (parent) {
            if (parent.type === "init_declarator") {
              const fullText: string = parent.text ?? ""
              const lhs = fullText.split("=")[0] ?? ""
              const idents = lhs.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
              const nonAttr = idents.filter((id: string) => !id.startsWith("__"))
              containerVar = nonAttr[nonAttr.length - 1] ?? idents[idents.length - 1] ?? null
            }
            if (parent.type === "declaration") {
              const typeNode = parent.childForFieldName?.("type")
              if (typeNode) containerType = typeNode.text?.trim() ?? null
              break
            }
            parent = parent.parent
          }

          const registrar = containerVar ?? "(struct_init)"
          const pairLine = (pair.startPosition?.row ?? 0) + 1

          results.push({
            kind: "init",
            registrar,
            callbackName: valueName,
            registrationKind: `struct_field:${containerType ?? "unknown"}.${fieldName}`,
            dispatchKey: fieldName,
            containerType: containerType ?? undefined,
            line: pairLine,
            file,
          })
        }

        // ── 5c) Function-body assignment registrations ──────────────────────
        // Build var → type map from all declarations in this file
        const varTypeMap = new Map<string, string>()
        const declarations = findAllNodes(root, "declaration")
        for (const decl of declarations) {
          const typeNode = decl.childForFieldName?.("type")
          if (!typeNode) continue
          const typeText = typeNode.text?.trim() ?? ""
          walkAst(decl, (child: any) => {
            if (child.type === "init_declarator") {
              const declr = child.childForFieldName?.("declarator")
              if (declr?.type === "identifier") varTypeMap.set(declr.text, typeText)
            }
          })
        }

        // Build function name → line range map for enclosing-function lookup
        const fnRanges: Array<{ name: string; startLine: number; endLine: number }> = []
        const funcDefs = findAllNodes(root, "function_definition")
        for (const fd of funcDefs) {
          let fnName: string | null = null
          const decl = fd.childForFieldName?.("declarator")
          if (decl)
            walkAst(decl, (n: any) => {
              if (!fnName && n.type === "identifier") fnName = n.text
            })
          if (fnName) {
            fnRanges.push({
              name: fnName,
              startLine: fd.startPosition?.row ?? 0,
              endLine: fd.endPosition?.row ?? 0,
            })
          }
        }

        const assignments = findAllNodes(root, "assignment_expression")
        for (const assign of assignments) {
          const right = assign.childForFieldName?.("right")
          if (!right || right.type !== "identifier") continue
          if (!knownFunctions.has(right.text)) continue

          const left = assign.childForFieldName?.("left")
          if (!left || left.type !== "field_expression") continue
          const fieldNode = left.childForFieldName?.("field")
          const argNode = left.childForFieldName?.("argument")
          if (!fieldNode || !argNode) continue

          const fieldName = fieldNode.text
          const containerExpr = argNode.text?.slice(0, 60) ?? ""
          const callbackName = right.text
          const assignRow = assign.startPosition?.row ?? 0
          const assignLine = assignRow + 1

          const containerVarName = containerExpr.replace(/->.*/, "").replace(/\..*/, "").trim()
          const resolvedType = varTypeMap.get(containerVarName)

          // Use enclosing function name as registrar (vs struct field expression)
          let enclosingFn = "(file-scope)"
          for (const fn of fnRanges) {
            if (assignRow >= fn.startLine && assignRow <= fn.endLine) {
              enclosingFn = fn.name
              break
            }
          }

          results.push({
            kind: "assign",
            registrar: enclosingFn,
            callbackName,
            registrationKind: `fn_body_assign:${containerExpr}.${fieldName}`,
            dispatchKey: fieldName,
            containerType: resolvedType,
            line: assignLine,
            file,
          })
        }

        return results
      }) ?? []

    // ── Emit edges from extracted plain-JS data ──────────────────────────
    for (const reg of registrations) {
      if (reg.kind === "call") {
        yield* emitRegistration(
          reg.registrar,
          reg.callbackName,
          reg.registrationKind,
          reg.dispatchKey,
          reg.file,
          reg.line,
        )
        yield* emitRuntimeCall(reg.registrar, reg.callbackName, reg.dispatchKey, reg.file, reg.line)
      } else if (reg.kind === "init") {
        yield* emitRegistration(
          reg.registrar,
          reg.callbackName,
          reg.registrationKind,
          reg.dispatchKey,
          reg.file,
          reg.line,
        )
        yield* emitRuntimeCall(reg.registrar, reg.callbackName, reg.dispatchKey, reg.file, reg.line, reg.containerType)
      } else if (reg.kind === "assign") {
        yield* emitRegistration(
          reg.registrar,
          reg.callbackName,
          reg.registrationKind,
          reg.dispatchKey,
          reg.file,
          reg.line,
        )
        yield* emitRuntimeCall(reg.registrar, reg.callbackName, reg.dispatchKey, reg.file, reg.line, reg.containerType)
      }
    }
  }
}
