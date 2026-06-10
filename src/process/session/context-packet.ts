export type PacketMode = "subagent" | "resume" | "primary"
export type PacketTier = "narrow" | "standard" | "wide"
export type PacketTrigger = "subagent-launch" | "subagent-resume" | "compaction" | "manual" | string

export type DispatchCandidatePacket = {
  todoPath: string
  specialist: string
  content: string
  closeSignal: string
  priority?: string
  type?: string
}

export type ContextPacket = {
  task_path: string
  mode: PacketMode
  trigger: PacketTrigger
  candidates: DispatchCandidatePacket[]
}

export type PacketMeta = {
  task_path: string
  mode: PacketMode
  trigger: PacketTrigger
  actionable: ActionableState
}

export type PacketResult = {
  markdown: string
  meta: PacketMeta
  candidates: DispatchCandidatePacket[]
}

export type ActionableState = {
  item: string
  done_criteria: string
  write_target: string
  task_path: string
  agent: string
  siblings?: string[]
}

const EMPTY_ACTIONABLE: ActionableState = {
  item: "",
  done_criteria: "",
  write_target: "",
  task_path: "",
  agent: "",
  siblings: [],
}

export function nextActionable(_planText: string, taskPath = ""): ActionableState {
  return { ...EMPTY_ACTIONABLE, task_path: taskPath }
}

export function hasActionableStateChanged(prev: ActionableState, next: ActionableState): boolean {
  return JSON.stringify(prev) !== JSON.stringify(next)
}

export function serialize(p: ContextPacket): string {
  return [
    `## Task coordination`,
    "",
    `- task path: ${p.task_path || "none"}`,
    "- format-specific coordination parsing is disabled; inspect files with bash when needed.",
  ].join("\n")
}

export async function buildPacket(opts: {
  taskNotePath: string
  notesRoot: string
  mode: PacketMode
  trigger: PacketTrigger
}): Promise<PacketResult> {
  const actionable = nextActionable("", opts.taskNotePath)
  const packet: ContextPacket = { task_path: opts.taskNotePath, mode: opts.mode, trigger: opts.trigger, candidates: [] }
  return {
    markdown: serialize(packet),
    meta: { task_path: opts.taskNotePath, mode: opts.mode, trigger: opts.trigger, actionable },
    candidates: [],
  }
}

export async function buildCompactionPrompt(_opts: { taskNotePath?: string; notesRoot?: string }): Promise<string> {
  return "Summarize the conversation state concisely. Do not rely on format-specific coordination files; inspect files with bash when needed."
}

export function markPacketStale(_sessionID: string, _cause: string, _force = false) {}
export function clearPacketFreshness(_sessionID: string) {}
export function resetBgDeliveryCursors(): void {}

export async function checkAndRebuildPacket(_opts: {
  sessionID: string
  taskNotePath: string
  notesRoot: string
}): Promise<PacketResult | undefined> {
  return undefined
}
