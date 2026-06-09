/**
 * phases/syscall-macros.ts — Phase 8: SYSCALL_DEFINE macro detection.
 *
 * Detects lines matching SYSCALL_DEFINE[0-6](name, ...) and emits:
 *   - A function symbol node for __do_sys_<name>
 *   - A registers_callback edge from syscall_table to the handler
 *   - A runtime_calls edge with the syscall dispatch chain
 *
 * This handles the kernel's macro-expanded syscall entry points that
 * clangd can't resolve because the function name at the SYSCALL_DEFINE
 * line doesn't match any AST node.
 *
 * Generic C/C++ logic — the syscall table dispatch chain template
 * comes from the linux pack's dispatch-chains.ts.
 */

import type { FileSymbolMap, PhaseCtx } from "./types.js"
import type { DispatchChainTemplate } from "../packs/types.js"

// Regex to match SYSCALL_DEFINE0(name) through SYSCALL_DEFINE6(name, ...)
const SYSCALL_DEFINE_RE = /^\s*SYSCALL_DEFINE(\d)\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)/

export async function* extractSyscallMacros(
  ctx: PhaseCtx,
  files: string[],
  dispatchTemplateMap: Map<string, DispatchChainTemplate>,
) {
  // Look for a syscall dispatch template
  const syscallTemplate = dispatchTemplateMap.get("module_init")
    ? {
        chain: ["userspace_syscall", "syscall_dispatch", "sys_call_table", "__do_sys_%NAME%"],
        triggerKind: "event" as const,
        triggerDescription: "Userspace syscall(%NAME%)",
      }
    : null

  for (const file of files) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    // Quick check: does this file contain SYSCALL_DEFINE?
    if (!text.includes("SYSCALL_DEFINE")) continue

    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(SYSCALL_DEFINE_RE)
      if (!m) continue

      const argCount = parseInt(m[1], 10)
      const syscallName = m[2]
      const expandedName = `__do_sys_${syscallName}`
      const lineNum = i + 1

      // Emit a function symbol for the macro-expanded name
      yield ctx.symbol({
        payload: {
          kind: "function",
          name: expandedName,
          qualifiedName: `SYSCALL_DEFINE${argCount}(${syscallName})`,
          location: { filePath: file, line: lineNum, column: 1 },
          metadata: {
            isSyscallHandler: true,
            syscallName,
            argCount,
            macroLine: lineNum,
          },
        },
      })
      ctx.metrics.count("symbols.syscall_handler")

      // Emit registers_callback from syscall_table
      yield ctx.edge({
        payload: {
          edgeKind: "registers_callback",
          srcSymbolName: "syscall_table",
          dstSymbolName: expandedName,
          confidence: 0.95,
          derivation: "clangd",
          metadata: {
            registrationKind: "syscall_define_macro",
            dispatchKey: syscallName,
            macroForm: `SYSCALL_DEFINE${argCount}(${syscallName})`,
          },
          evidence: { sourceKind: "file_line", location: { filePath: file, line: lineNum } },
        },
      })
      ctx.metrics.count("edges.registers_callback")

      // Emit runtime_calls with syscall dispatch chain
      if (syscallTemplate) {
        const chain = syscallTemplate.chain.map((s) => s.replace(/%NAME%/g, syscallName))
        yield ctx.edge({
          payload: {
            edgeKind: "runtime_calls",
            srcSymbolName: "syscall_dispatch",
            dstSymbolName: expandedName,
            confidence: 0.9,
            derivation: "clangd",
            metadata: {
              dispatchChain: chain,
              registrationApi: `SYSCALL_DEFINE${argCount}`,
              dispatchKey: syscallName,
              triggerKind: syscallTemplate.triggerKind,
              triggerDescription: syscallTemplate.triggerDescription.replace(/%NAME%/g, syscallName),
            },
            evidence: { sourceKind: "file_line", location: { filePath: file, line: lineNum } },
          },
        })
        ctx.metrics.count("edges.runtime_calls")
      }
    }
  }
}
