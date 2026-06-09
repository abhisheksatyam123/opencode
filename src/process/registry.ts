// src/process/registry.ts — ProcessRegistry L3 registry (Stage 8, leaf I8.1).
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   process-registry.md (333 lines)
//     §Signature        L55-107  — PCB type + ProcessRegistry interface
//     §PCB on disk      L109+    — frontmatter is source of truth
//     §State machine    L138-176 — 4 states, 13-row transition table
//     §Lifecycle        L178-187 — boot/spawn/heartbeat/exit/signal/reap
//     §Crash-recovery   L189-205 — boot-scan algorithm
//     §Invariants       L238-249 — P1-P10
//
// Differences vs sibling L3 registries (e.g. runtime-role.ts):
//   • Source of truth is task-note frontmatter at <vault>/scratchpad/task/
//     <proj>/active/todo-*/todo.md `pcb` block — not a dedicated card directory.
//   • Schema is fixed by the contract (PCB shape), not authored per file.
//   • Mutating ops (spawn/exit/signal/heartbeat) write through to disk
//     and re-publish snapshot via atomic swap (l3-registry I4).
//   • Empty registry is "quiet" — cold-boot with no active tasks is the
//     normal state, so we DEBUG instead of WARN (learning P2).
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import { randomUUID } from "node:crypto"
import matter from "gray-matter"
import z from "zod"
import { ConfigMarkdown } from "@/config/markdown"
import { Filesystem } from "@/foundation/util/filesystem"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Bus, WatchManager } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"
import { ProcessEvent } from "@/process/events"
import { TaskNotePath } from "@/foundation/task-note-path"

export namespace ProcessRegistry {
  const log = Log.create({ service: "process-registry" })

  // ── Types (mirrors process-registry.md §Signature) ───────────────────

  export const ProcessState = z.enum(["running", "blocked", "zombie", "stopped"])
  export type ProcessState = z.infer<typeof ProcessState>

  export const SignalKind = z.enum(["kill", "pause", "resume", "resurrect"])
  export type SignalKind = z.infer<typeof SignalKind>

  /** Process Control Block — one per (session_id, agent, task_path). `task_path` is the persisted/event wire field. */
  export const PCB = z.object({
    pid: z.string().uuid(),
    parent_pid: z.string().uuid().nullable(),
    session_id: z.string().min(1),
    agent: z.string().min(1),
    model: z.string().min(1),
    task_path: z.string().min(1),
    state: ProcessState,
    started_at: z.string().min(1),
    last_heartbeat: z.string().min(1),
    exit_code: z.number().int().nullable(),
    exit_reason: z.string().nullable(),
  })
  export type PCB = z.infer<typeof PCB>

  export interface SpawnInput {
    parent_pid: string | null
    session_id: string
    agent: string
    model: string
    task_path: string
  }

  export interface ProcessKey {
    session_id: string
    agent: string
    task_path: string
  }

  export interface LoadError {
    source: string
    path?: string
    name?: string
    reason: "schema.invalid" | "frontmatter.parse" | "io.read" | "duplicate-pid"
    detail: string
  }

  // ── Errors thrown by mutating ops ───────────────────────────────────

  export class ProcessExistsError extends Error {
    constructor(key: ProcessKey, existing_pid: string) {
      super(
        `ProcessRegistry: active PCB already exists for key ` +
          `(session_id=${key.session_id}, agent=${key.agent}, task_path=${key.task_path}) ` +
          `with pid=${existing_pid}. Wait for prior PCB to be reaped before re-spawning.`,
      )
      this.name = "ProcessExistsError"
    }
  }

  export class ProcessNotFoundError extends Error {
    constructor(pid: string) {
      super(`ProcessRegistry: pid=${pid} not found in snapshot.`)
      this.name = "ProcessNotFoundError"
    }
  }

  export class IllegalTransitionError extends Error {
    constructor(pid: string, from: ProcessState, sig: SignalKind | "exit") {
      super(`ProcessRegistry: illegal transition for pid=${pid}: state=${from} cannot accept ${sig}.`)
      this.name = "IllegalTransitionError"
    }
  }

  // ── Internal state ───────────────────────────────────────────────────

  type Snapshot = {
    /** byPid — primary key (uuid). */
    byPid: ReadonlyMap<string, PCB>
    /** byKey — natural key (session_id|agent|task_path) → pid. */
    byKey: ReadonlyMap<string, string>
    /** byTaskPath — task-note path (`task_path` on disk/events) → pid. */
    byTaskPath: ReadonlyMap<string, string>
    list: ReadonlyArray<PCB>
    errors: ReadonlyArray<LoadError>
  }

  function emptySnapshot(): Snapshot {
    return {
      byPid: new Map(),
      byKey: new Map(),
      byTaskPath: new Map(),
      list: Object.freeze([]) as ReadonlyArray<PCB>,
      errors: Object.freeze([]) as ReadonlyArray<LoadError>,
    }
  }

  let snapshot: Snapshot = emptySnapshot()
  const subscribers = new Set<() => void>()

  /**
   * Per-task-note write lock. Serialises concurrent spawn/exit/signal/
   * heartbeat for the same file. Coarse but sufficient — invariant P8
   * just requires per-pid write atomicity, and one file ≤ one pid.
   */
  const writeLocks = new Map<string, Promise<void>>()

  function taskPathOf(pcb: Pick<PCB, "task_path">): string {
    return pcb.task_path
  }

  function processKeyOf(pcb: Pick<PCB, "session_id" | "agent" | "task_path">): ProcessKey {
    return { session_id: pcb.session_id, agent: pcb.agent, task_path: pcb.task_path }
  }

  function naturalKey(k: ProcessKey): string {
    return `${k.session_id}|${k.agent}|${k.task_path}`
  }

  function activeTaskDir(): string {
    return vaultPath.scratchpad("task")
  }

  /**
   * Coerce free-text exit reasons to the closed enum required by
   * bus-service.md L502 (`ok | killed | crashed | timeout`). Unknown
   * reasons fall through to "crashed" — preserves audit information
   * (the original text still lives in PCB.exit_reason on disk; this
   * mapping is event-payload-only).
   */
  function normaliseExitReason(raw: string): "ok" | "killed" | "crashed" | "timeout" {
    if (raw === "ok" || raw === "killed" || raw === "crashed" || raw === "timeout") return raw
    return "crashed"
  }

  /**
   * Stage 8 (I8.5) — fire-and-forget publisher for process lifecycle
   * events. Bus-not-bootstrapped failures are downgraded to silent skip
   * (test contexts where the Effect runtime isn't wired). Other publish
   * failures get a WARN log.
   */
  type ProcessEventInputs = {
    spawned: { pcb: PCB }
    exited: {
      pid: string
      key: ProcessKey
      exit_code: number
      exit_reason: "ok" | "killed" | "crashed" | "timeout"
      recovery: boolean
    }
  }
  async function publishProcessEvent<K extends keyof ProcessEventInputs>(
    kind: K,
    payload: ProcessEventInputs[K],
  ): Promise<void> {
    const def = kind === "spawned" ? ProcessEvent.Spawned : ProcessEvent.Exited
    try {
      await Bus.publish(def, payload as never)
    } catch (err) {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.process.failed", {
        kind,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Walk folder-backed active task entry files plus legacy
   * flat `todo-*.md` files. Returns absolute paths for every candidate
   * task-note file. Missing dirs are ignored
   * (degraded boot — empty vault is normal).
   */
  async function enumerateActiveTaskNotes(): Promise<string[]> {
    const root = activeTaskDir()
    if (!existsSync(root)) return []
    const projects = await fs.readdir(root).catch(() => [] as string[])
    const out: string[] = []
    for (const proj of projects) {
      const activeDir = path.join(root, proj, "active")
      if (!existsSync(activeDir)) continue
      const entries = await fs.readdir(activeDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isFile() && /^todo-.*\.md$/.test(entry.name)) out.push(path.join(activeDir, entry.name))
        if (entry.isDirectory() && /^todo-/.test(entry.name)) {
          const todo = path.join(activeDir, entry.name, "todo.md")
          if (existsSync(todo)) out.push(todo)
        }
      }
    }
    return out
  }

  // ── Snapshot indexer ────────────────────────────────────────────────

  function indexSnapshot(records: PCB[]): Snapshot {
    const byPid = new Map<string, PCB>()
    const byKey = new Map<string, string>()
    const byTaskPath = new Map<string, string>()
    const errors: LoadError[] = []

    for (const rec of records) {
      const frozen = Object.freeze({ ...rec }) as PCB
      if (byPid.has(frozen.pid)) {
        errors.push({
          source: "vault",
          name: frozen.pid,
          reason: "duplicate-pid",
          detail: `pid=${frozen.pid} appears in two PCBs; keeping first occurrence.`,
        })
        continue
      }
      byPid.set(frozen.pid, frozen)
      byKey.set(
        naturalKey({
          session_id: frozen.session_id,
          agent: frozen.agent,
          task_path: taskPathOf(frozen),
        }),
        frozen.pid,
      )
      byTaskPath.set(taskPathOf(frozen), frozen.pid)
    }

    const list = Object.freeze(
      [...byPid.values()].sort((a, b) => a.started_at.localeCompare(b.started_at)),
    ) as ReadonlyArray<PCB>

    return {
      byPid,
      byKey,
      byTaskPath,
      list,
      errors: Object.freeze(errors) as ReadonlyArray<LoadError>,
    }
  }

  // ── Disk I/O — frontmatter PCB block ────────────────────────────────

  /**
   * Parse a single task-note file. Returns the PCB if the frontmatter
   * has a `pcb` block; null if absent (task note without process state);
   * pushes a LoadError if malformed.
   */
  async function readPcbFromFile(filePath: string, errors: LoadError[]): Promise<PCB | null> {
    let parsed: { data: unknown; content: string }
    try {
      parsed = await ConfigMarkdown.parse(filePath)
    } catch (err) {
      errors.push({
        source: "vault",
        path: filePath,
        reason: "frontmatter.parse",
        detail: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    const fm = (parsed.data ?? {}) as Record<string, unknown>
    const pcbBlock = fm["pcb"]
    if (pcbBlock == null) return null // no PCB on this task note — fine.

    const result = PCB.safeParse(pcbBlock)
    if (!result.success) {
      errors.push({
        source: "vault",
        path: filePath,
        reason: "schema.invalid",
        detail: result.error.issues.map((i) => `${i.path.join("@/process") || "<root>"}: ${i.message}`).join("; "),
      })
      return null
    }
    return result.data
  }

  /**
   * Merge a PCB into the task-note frontmatter, re-stringify, and write
   * atomically. P8: callers MUST hold the per-file writeLock while this
   * runs.
   */
  async function writePcbToFile(absPath: string, pcb: PCB): Promise<void> {
    let raw = ""
    try {
      raw = await Filesystem.readText(absPath)
    } catch (err) {
      throw new Error(
        `ProcessRegistry: cannot read task note ${absPath} for PCB write: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    const stripped = raw.startsWith("\uFEFF") ? raw.slice(1) : raw
    let parsed
    try {
      parsed = matter(stripped)
    } catch (err) {
      throw new Error(
        `ProcessRegistry: malformed frontmatter in ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const fm = { ...(parsed.data as Record<string, unknown>), pcb }
    const next = matter.stringify(parsed.content, fm)
    await Filesystem.write(absPath, next)
  }
  async function appendProcessHistory(_absPath: string, _state: ProcessState, _reason: string): Promise<void> {
    // Keep task-note bodies minimal.
  }

  /** Resolve a vault-relative task-note path (`task_path` on disk/events) to an absolute file path. */
  function taskPathToAbsolute(taskPath: string): string {
    const rel = TaskNotePath.canonicalize(taskPath)
    if (TaskNotePath.isValid(rel) && rel.startsWith("scratchpad/task/")) {
      for (const candidate of TaskNotePath.noteFileCandidates(rel).map((p) => path.join(vaultPath.root(), p))) {
        if (existsSync(candidate)) return candidate
      }
      return path.join(vaultPath.root(), TaskNotePath.artifactTodo(rel))
    }
    const withExt = rel.endsWith(".md") ? rel : `${rel}.md`
    return path.join(vaultPath.root(), withExt)
  }

  /** Per-file write serialiser (P8). */
  async function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
    const prior = writeLocks.get(absPath) ?? Promise.resolve()
    let release: () => void = () => {}
    const next = new Promise<void>((res) => {
      release = res
    })
    writeLocks.set(
      absPath,
      prior.then(() => next),
    )
    await prior
    try {
      return await fn()
    } finally {
      release()
      // Garbage-collect the lock if no follow-on waiter chained beyond us.
      if (writeLocks.get(absPath) === prior.then(() => next)) writeLocks.delete(absPath)
    }
  }

  // ── Public API — L3 6-method contract ───────────────────────────────

  /**
   * Boot scan — walks active task notes, populates table from PCB
   * frontmatter blocks. P9: idempotent; running twice yields the same
   * snapshot. Crash-recovery hook (process-registry.md §Crash-recovery
   * scan) is layered on top by the caller via the returned `orphans`
   * list — registry itself does NOT mutate orphan state on read; that
   * decision belongs to the recovery harness (I8.4).
   */
  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByName = snapshot.byPid

    const errors: LoadError[] = []
    const records: PCB[] = []
    const files = await enumerateActiveTaskNotes()
    for (const f of files) {
      const pcb = await readPcbFromFile(f, errors)
      if (pcb) records.push(pcb)
    }

    snapshot = indexSnapshot(records)
    if (errors.length) {
      // Augment indexSnapshot's errors with our parse errors.
      snapshot = { ...snapshot, errors: Object.freeze([...snapshot.errors, ...errors]) }
    }

    if (snapshot.byPid.size === 0) {
      // Quiet-empty (learning): empty registry is the normal cold-boot
      // state for a fresh vault. No WARN.
      log.debug("registry.empty", {
        kind: "process",
        active_dir: activeTaskDir(),
      })
    }

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, snapshot.byPid)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "process",
      count: snapshot.byPid.size,
      errors: snapshot.errors.length,
      durationMs: Date.now() - t0,
      sourceIds: ["vault"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "process",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  export async function reload(): Promise<void> {
    await load()
  }

  /** Lookup by pid (primary key). */
  export function get(pid: string): PCB | undefined {
    return snapshot.byPid.get(pid)
  }

  /** All active PCBs, sorted by started_at. */
  export function list(): ReadonlyArray<PCB> {
    return snapshot.list
  }

  export function errors(): ReadonlyArray<LoadError> {
    return snapshot.errors
  }

  export function onChange(fn: () => void): { dispose(): void } {
    subscribers.add(fn)
    return {
      dispose() {
        subscribers.delete(fn)
      },
    }
  }

  export function provenance(pid: string): Array<{ source: string; fields: string[] }> {
    const rec = snapshot.byPid.get(pid)
    if (!rec) return []
    return [{ source: "pcb-on-disk", fields: Object.keys(rec) }]
  }

  /** Stage 7 hot-reload — watch active task notes for external edits. */
  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "process",
      dir: activeTaskDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  export function stopWatcher(): void {
    WatchManager.stop("process")
  }

  // ── Process-specific extensions (process-registry.md §Signature) ────

  /** Natural-key lookup (P3). */
  export function byKey(key: ProcessKey): PCB | undefined {
    const pid = snapshot.byKey.get(naturalKey(key))
    return pid ? snapshot.byPid.get(pid) : undefined
  }

  /**
   * Resolve a task_id (`ses_<ulid>` foreground or `bg_ses_<ulid>` background)
   * to its ProcessRegistry pid. Returns the first PCB whose session_id
   * matches the underlying ulid. Stage 9 — task-as-comms-surface (see
   * specification/contract/task-tool §Identity contract).
   */
  export function getPidByTaskId(taskId: string): string | undefined {
    const sessionID = taskId.startsWith("bg_") ? taskId.slice(3) : taskId
    for (const pcb of snapshot.byPid.values()) {
      if (pcb.session_id === sessionID) return pcb.pid
    }
    return undefined
  }

  /**
   * Spawn a new process. Throws ProcessExistsError if the natural key
   * already has an active PCB (state ∈ {running, blocked, stopped}).
   * State transition: ∅ → running.
   */
  export async function spawn(input: SpawnInput): Promise<PCB> {
    const key: ProcessKey = {
      session_id: input.session_id,
      agent: input.agent,
      task_path: input.task_path,
    }
    const existing = byKey(key)
    if (existing && existing.state !== "zombie") {
      throw new ProcessExistsError(key, existing.pid)
    }

    const now = new Date().toISOString()
    const pcb: PCB = Object.freeze({
      pid: randomUUID(),
      parent_pid: input.parent_pid,
      session_id: input.session_id,
      agent: input.agent,
      model: input.model,
      task_path: input.task_path,
      state: "running",
      started_at: now,
      last_heartbeat: now,
      exit_code: null,
      exit_reason: null,
    })

    const absPath = taskPathToAbsolute(input.task_path)
    await withFileLock(absPath, () => writePcbToFile(absPath, pcb))
    await reload() // re-read disk → atomic swap snapshot
    publishProcessEvent("spawned", { pcb }).catch(() => {})
    return pcb
  }

  /**
   * Update last_heartbeat for a running/blocked process. Idempotent.
   * Returns false if pid is unknown or terminal.
   */
  export async function heartbeat(pid: string): Promise<boolean> {
    const cur = snapshot.byPid.get(pid)
    if (!cur) return false
    if (cur.state !== "running" && cur.state !== "blocked") return false

    const next: PCB = Object.freeze({ ...cur, last_heartbeat: new Date().toISOString() })
    const absPath = taskPathToAbsolute(taskPathOf(cur))
    await withFileLock(absPath, () => writePcbToFile(absPath, next))
    await reload()
    return true
  }

  /**
   * Mark a process as zombie (terminal-but-not-reaped). State machine
   * §Transitions row: running|blocked|stopped → zombie via `exit()`.
   */
  export async function exit(pid: string, code: number, reason: string): Promise<void> {
    const cur = snapshot.byPid.get(pid)
    if (!cur) throw new ProcessNotFoundError(pid)
    if (cur.state === "zombie") return // idempotent

    const next: PCB = Object.freeze({
      ...cur,
      state: "zombie",
      exit_code: code,
      exit_reason: reason,
    })
    const absPath = taskPathToAbsolute(taskPathOf(cur))
    await withFileLock(absPath, async () => {
      await writePcbToFile(absPath, next)
      await appendProcessHistory(absPath, "zombie", reason)
    })
    await reload()
    publishProcessEvent("exited", {
      pid: cur.pid,
      key: processKeyOf(cur),
      exit_code: code,
      exit_reason: normaliseExitReason(reason),
      recovery: false,
    }).catch(() => {})
  }

  /**
   * Apply a signal to a process. Caller (the `signal` tool) is
   * responsible for the permission gate per S1 — this method assumes
   * permission has been granted. Permission denial MUST NOT reach here.
   *
   * State transitions (process-registry.md §State machine):
   *   running|blocked|stopped + kill      → zombie
   *   running                + pause      → stopped
   *   blocked                + pause      → stopped
   *   stopped                + resume     → running
   *   zombie  (exit ≠ "ok")  + resurrect  → running (NEW pid; old reaped)
   */
  export async function signal(pid: string, sig: SignalKind): Promise<PCB> {
    const cur = snapshot.byPid.get(pid)
    if (!cur) throw new ProcessNotFoundError(pid)

    // Validate transition.
    const validKills = sig === "kill" && (cur.state === "running" || cur.state === "blocked" || cur.state === "stopped")
    const validPause = sig === "pause" && (cur.state === "running" || cur.state === "blocked")
    const validResume = sig === "resume" && cur.state === "stopped"
    const validResurrect = sig === "resurrect" && cur.state === "zombie" && cur.exit_reason !== "ok"
    if (!validKills && !validPause && !validResume && !validResurrect) {
      throw new IllegalTransitionError(pid, cur.state, sig)
    }

    const absPath = taskPathToAbsolute(taskPathOf(cur))
    if (sig === "resurrect") {
      // Reap old, spawn fresh — atomic from caller's viewpoint.
      const reborn: PCB = Object.freeze({
        pid: randomUUID(),
        parent_pid: cur.parent_pid,
        session_id: cur.session_id,
        agent: cur.agent,
        model: cur.model,
        task_path: taskPathOf(cur),
        state: "running",
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        exit_code: null,
        exit_reason: null,
      })
      await withFileLock(absPath, async () => {
        await writePcbToFile(absPath, reborn)
        await appendProcessHistory(absPath, "running", `resurrected from pid=${cur.pid}`)
      })
      await reload()
      // Old pid "exits" via resurrect; new pid spawns. Per spec L536-544
      // ordering: emit exited(old) then spawned(new) so subscribers see
      // the lifecycle in causal order.
      publishProcessEvent("exited", {
        pid: cur.pid,
        key: processKeyOf(cur),
        exit_code: cur.exit_code ?? -1,
        exit_reason: normaliseExitReason(cur.exit_reason ?? "killed"),
        recovery: false,
      }).catch(() => {})
      publishProcessEvent("spawned", { pcb: reborn }).catch(() => {})
      return reborn
    }

    const nextState: ProcessState = sig === "kill" ? "zombie" : sig === "pause" ? "stopped" : "running"
    const next: PCB = Object.freeze({
      ...cur,
      state: nextState,
      ...(sig === "kill"
        ? {
            exit_code: cur.exit_code ?? -1,
            exit_reason: cur.exit_reason ?? "killed",
          }
        : {}),
    })
    await withFileLock(absPath, async () => {
      await writePcbToFile(absPath, next)
      if (sig === "kill") await appendProcessHistory(absPath, "zombie", "killed by signal")
    })
    await reload()
    if (sig === "kill") {
      publishProcessEvent("exited", {
        pid: cur.pid,
        key: processKeyOf(cur),
        exit_code: -1,
        exit_reason: "killed",
        recovery: false,
      }).catch(() => {})
    }
    return next
  }

  /** Walk parent_pid chain. Returns root → … → parent (excluding self). */
  export function ancestors(pid: string): ReadonlyArray<PCB> {
    const out: PCB[] = []
    let cur = snapshot.byPid.get(pid)
    if (!cur) return Object.freeze(out)
    const seen = new Set<string>([cur.pid])
    while (cur && cur.parent_pid) {
      if (seen.has(cur.parent_pid)) break // cycle guard
      const parent = snapshot.byPid.get(cur.parent_pid)
      if (!parent) break
      seen.add(parent.pid)
      out.unshift(parent)
      cur = parent
    }
    return Object.freeze(out)
  }

  /** All transitive descendants (BFS). */
  export function descendants(pid: string): ReadonlyArray<PCB> {
    const childrenByParent = new Map<string, PCB[]>()
    for (const p of snapshot.byPid.values()) {
      if (p.parent_pid) {
        const arr = childrenByParent.get(p.parent_pid) ?? []
        arr.push(p)
        childrenByParent.set(p.parent_pid, arr)
      }
    }
    const out: PCB[] = []
    const queue: string[] = [pid]
    const seen = new Set<string>([pid])
    while (queue.length) {
      const cur = queue.shift()!
      const kids = childrenByParent.get(cur) ?? []
      for (const k of kids) {
        if (seen.has(k.pid)) continue
        seen.add(k.pid)
        out.push(k)
        queue.push(k.pid)
      }
    }
    return Object.freeze(out)
  }

  /**
   * Reap zombies older than `ttlMs`. Removes the `pcb` block from the
   * task-note frontmatter and appends a "reaped" row to §Process
   * history. Returns reaped pids. Designed to be called from a periodic
   * reconciler (default 60 s; cfg.process.zombie_ttl_ms).
   */
  export async function reap(ttlMs: number): Promise<string[]> {
    const now = Date.now()
    const reaped: string[] = []
    for (const pcb of snapshot.list) {
      if (pcb.state !== "zombie") continue
      const age = now - Date.parse(pcb.last_heartbeat || pcb.started_at)
      if (age < ttlMs) continue

      const absPath = taskPathToAbsolute(taskPathOf(pcb))
      await withFileLock(absPath, async () => {
        // Remove pcb block from frontmatter.
        try {
          const raw = await Filesystem.readText(absPath)
          const stripped = raw.startsWith("\uFEFF") ? raw.slice(1) : raw
          const parsed = matter(stripped)
          const fm = { ...(parsed.data as Record<string, unknown>) }
          delete fm["pcb"]
          await Filesystem.write(absPath, matter.stringify(parsed.content, fm))
          await appendProcessHistory(absPath, "zombie", `reaped (age=${Math.floor(age / 1000)}s)`)
        } catch (err) {
          log.warn("reap.write.failed", {
            pid: pcb.pid,
            task_path: taskPathOf(pcb),
            err: err instanceof Error ? err.message : String(err),
          })
          return
        }
        reaped.push(pcb.pid)
      })
    }
    if (reaped.length) await reload()
    return reaped
  }

  /** @internal — reset for tests. */
  export function _resetForTest(): void {
    snapshot = emptySnapshot()
    subscribers.clear()
    writeLocks.clear()
  }
}
