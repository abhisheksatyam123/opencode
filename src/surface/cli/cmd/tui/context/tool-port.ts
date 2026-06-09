/**
 * tool-port.ts — Surface-layer tool input/metadata contracts for TUI rendering.
 *
 * DIP boundary: TUI session renderer imports from this module, NOT from
 * @/tool/* runtime implementations. Each interface captures only the fields
 * the TUI actually reads, keeping the surface layer decoupled from tool
 * implementation details.
 *
 * When a tool's schema changes, update the interface here and the adapter
 * in the tool's own contract/port — the TUI renderer stays unchanged.
 */

// ─── Bash ────────────────────────────────────────────────────────────────────

export interface BashToolInput {
  mode?: "run" | "background" | "list" | "status" | "kill" | "cleanup" | "remove"
  command?: string
  workdir?: string
  timeout?: number
  description?: string
  label?: string
  id?: string
  max_age_ms?: number
  run_in_background?: boolean
}

export interface BashToolMetadata {
  output?: string
  exit?: number | null
  exitCode?: number
  error?: string
}

// ─── Task ────────────────────────────────────────────────────────────────────

export interface TaskToolInput {
  op?: "spawn" | "result" | "workflow" | "note" | "kill" | "pause" | "resume" | "resurrect" | "model" | "message"
  operation?: string
  description?: string
  subagent_type?: string
  todo_item?: string
  task_path?: string
  acceptance_signal?: string
  background_task_id?: string
  task_id?: string
  section?: string
}

export interface TaskToolMetadata {
  sessionId?: string
  sessionID?: string
  resumable_task_id?: string
  task_id?: string
}

// ─── Generic (unknown tool) ───────────────────────────────────────────────────

export interface GenericToolInput {
  [key: string]: unknown
}

export interface GenericToolMetadata {
  [key: string]: unknown
}
