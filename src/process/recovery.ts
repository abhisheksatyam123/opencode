// src/process/recovery.ts — Stage 8 (I8.4) crash-recovery harness for
// the ProcessRegistry boot scan.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/process-registry.md
//     §Crash-recovery scan        L189-205
//     §S.1 Crash-recovery cell    L287-302
//     §Invariants                 P9 idempotent (L248)
//     §Lifecycle                  L186-187 boot scan + ring-1 init
//
//   project/software/opencode/specification/contract/bus-service.md
//     §Process events             L456-516
//     §Reload event ordering      L546-558
//
// What this module does:
//
//   The ProcessRegistry.load() boot scan parses every active task
//   note's PCB block but does NOT mutate orphan state — that decision
//   belongs HERE. After load() commits the snapshot, ProcessRecovery
//   walks the freshly-published list, classifies orphans (state ∈
//   {running, blocked, stopped} ∧ no live fiber registered for that
//   pid), transitions them to zombie+exit_reason="crashed"+exit_code=
//   -1, and emits process.exited{recovery=true} per each.
//
//   "Live fiber" registry is the caller's responsibility — the engine
//   maintains a Set<pid> of agent fibers actually running in this
//   process. Multi-instance scenarios (Stage 16 multi-engine) require
//   cross-instance fiber tracking; this single-instance implementation
//   treats every PCB on disk as orphan unless explicitly registered as
//   live before scan() runs.
//
// Idempotency: running scan() twice in a row produces the same final
// state (P9). Orphans transitioned to zombie on the first pass are not
// re-classified on the second — the state-∈{running,blocked,stopped}
// guard rejects them. Reaping (registry.reap()) is a separate concern
// that runs on a longer cadence.
// -------------------------------------------------------------------------

import { Bus } from "@/bus"
import { Log } from "@/foundation/util/log"
import matter from "gray-matter"
import path from "path"
import { Filesystem } from "@/foundation/util/filesystem"
import { vaultPath } from "@/notes/root"
import { RegistryEvent } from "@/bus/registry-events"
import { ProcessEvent } from "@/process/events"
import { ProcessRegistry } from "@/process/registry"
import { TaskNotePath } from "@/foundation/task-note-path"

export namespace ProcessRecovery {
  const log = Log.create({ service: "process-recovery" })

  export interface ScanResult {
    /** PCBs whose state was running/blocked/stopped + no live fiber. */
    orphans: ReadonlyArray<ProcessRegistry.PCB>
    /** PCBs that survived the scan unchanged. */
    survivors: ReadonlyArray<ProcessRegistry.PCB>
    /** Wall-clock duration of the scan in ms. */
    durationMs: number
  }

  /**
   * Coerce a free-text PCB exit_reason to the closed enum required by
   * bus-service.md L502 — duplicate of registry.ts's normaliseExitReason
   * to avoid creating a public surface for a one-shot helper.
   */
  function normaliseExitReason(raw: string | null): "ok" | "killed" | "crashed" | "timeout" {
    if (raw === "ok" || raw === "killed" || raw === "crashed" || raw === "timeout") return raw
    return "crashed"
  }

  /**
   * Run the crash-recovery scan.
   *
   * Per §Crash-recovery scan algorithm (L189-205):
   *
   *   1. Walk folder-backed active task entry files plus legacy flats (handled by
   *      load() — we read the post-load snapshot here).
   *   2. For each PCB with state ∈ {running, blocked, stopped} AND
   *      pid ∉ liveFibers: classify orphan.
   *   3. For each orphan:
   *      - transition state → zombie
   *      - set exit_reason="crashed", exit_code=-1 if not already set
   *        from boot scan"
   *      - publish process.exited{recovery=true}
   *   4. Survivors are PCBs with state=zombie OR pid ∈ liveFibers —
   *      eligible for normal reap (registry.reap()) without further
   *      action here.
   *
   * @param liveFibers Set of pids currently running in this engine
   *                   instance. Empty set ⇒ every PCB on disk is an
   *                   orphan (cold-boot recovery scenario).
   *
   * Idempotency (P9): calling scan() twice with the same liveFibers
   * yields the same final state. Already-zombie PCBs are not
   * re-classified.
   */
  export async function scan(liveFibers: ReadonlySet<string> = new Set()): Promise<ScanResult> {
    const t0 = Date.now()
    // load() must have run first; we operate on the post-load snapshot.
    const all = ProcessRegistry.list()
    const orphans: ProcessRegistry.PCB[] = []
    const survivors: ProcessRegistry.PCB[] = []

    for (const pcb of all) {
      const isOrphanCandidate = pcb.state === "running" || pcb.state === "blocked" || pcb.state === "stopped"
      if (!isOrphanCandidate) {
        survivors.push(pcb)
        continue
      }
      if (liveFibers.has(pcb.pid)) {
        survivors.push(pcb)
        continue
      }
      orphans.push(pcb)
    }

    if (orphans.length === 0) {
      log.debug("recovery.scan.clean", {
        survivors: survivors.length,
        durationMs: Date.now() - t0,
      })
      return Object.freeze({
        orphans: Object.freeze([]) as ReadonlyArray<ProcessRegistry.PCB>,
        survivors: Object.freeze(survivors) as ReadonlyArray<ProcessRegistry.PCB>,
        durationMs: Date.now() - t0,
      })
    }

    // Process each orphan: write zombie state to disk, append history,
    // emit process.exited.
    for (const pcb of orphans) {
      try {
        await markOrphanCrashed(pcb)
      } catch (err) {
        log.warn("recovery.orphan.write.failed", {
          pid: pcb.pid,
          task_path: taskPathOf(pcb),
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Re-read disk so subsequent ProcessRegistry queries see the
    // crashed state. P9: this means a second scan() with the same
    // liveFibers will find these PCBs in state=zombie and skip them.
    await ProcessRegistry.reload()

    log.warn("recovery.scan.orphans", {
      count: orphans.length,
      survivors: survivors.length,
      pids: orphans.map((p) => p.pid),
      durationMs: Date.now() - t0,
    })

    return Object.freeze({
      orphans: Object.freeze(orphans) as ReadonlyArray<ProcessRegistry.PCB>,
      survivors: Object.freeze(survivors) as ReadonlyArray<ProcessRegistry.PCB>,
      durationMs: Date.now() - t0,
    })
  }

  /**
   * Atomically write the crashed state to a single orphan PCB:
   *   - state → zombie
   *   - exit_reason → "crashed" (preserves prior reason if already set)
   *   - exit_code → -1 (preserves prior code if already set)
   *   - publish process.exited{recovery=true}
   */
  function taskPathOf(pcb: Pick<ProcessRegistry.PCB, "task_path">): string {
    return pcb.task_path
  }

  function taskNoteFileForProcess(taskPath: string): string {
    const rel = TaskNotePath.canonicalize(taskPath)
    if (TaskNotePath.isValid(rel) && rel.startsWith("scratchpad/task/")) {
      for (const candidate of TaskNotePath.noteFileCandidates(rel).map((p) => path.join(vaultPath.root(), p))) {
        if (Filesystem.stat(candidate)?.isFile()) return candidate
      }
      return path.join(vaultPath.root(), TaskNotePath.artifactTodo(rel))
    }
    return path.join(vaultPath.root(), rel.endsWith(".md") ? rel : `${rel}.md`)
  }

  function appendRecoveryHistory(content: string): string {
    const row = `| ${new Date().toISOString()} | crashed | recovered from boot scan |`
    if (/^## Process history\b/m.test(content)) return `${content.trimEnd()}\n${row}\n`
    return `${content.trimEnd()}\n\n## Process history\n\n| timestamp | state | reason |\n| --- | --- | --- |\n${row}\n`
  }

  async function markOrphanCrashed(orphan: ProcessRegistry.PCB): Promise<void> {
    const absPath = taskNoteFileForProcess(taskPathOf(orphan))

    const raw = await Filesystem.readText(absPath)
    const stripped = raw.startsWith("\uFEFF") ? raw.slice(1) : raw
    const parsed = matter(stripped)
    const fm = { ...(parsed.data as Record<string, unknown>) }
    const next = {
      ...orphan,
      state: "zombie" as const,
      exit_code: orphan.exit_code ?? -1,
      exit_reason: orphan.exit_reason ?? "crashed",
    }
    fm["pcb"] = next

    const content = appendRecoveryHistory(parsed.content)
    await Filesystem.write(absPath, matter.stringify(content, fm))

    // Emit the recovery-classified exit event.
    try {
      await Bus.publish(ProcessEvent.Exited, {
        pid: orphan.pid,
        key: {
          session_id: orphan.session_id,
          agent: orphan.agent,
          task_path: taskPathOf(orphan),
        },
        exit_code: next.exit_code ?? -1,
        exit_reason: normaliseExitReason(next.exit_reason),
        recovery: true,
      })
    } catch (err) {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("recovery.bus.publish.failed", {
        pid: orphan.pid,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Convenience: load + scan in one call. Used by the engine boot
   * harness (init-registry, ring 1) before any `task spawn` request is
   * honoured per process-registry §Lifecycle L204.
   */
  export async function bootRecover(liveFibers: ReadonlySet<string> = new Set()): Promise<ScanResult> {
    await ProcessRegistry.load()
    return scan(liveFibers)
  }
}
