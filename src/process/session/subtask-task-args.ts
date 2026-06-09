export type SubtaskTaskArgsInput = {
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
  background?: boolean
}

export function subtaskTaskArgs(task: SubtaskTaskArgsInput) {
  return {
    op: "spawn" as const,
    prompt: task.prompt,
    description: task.description,
    subagent_type: task.agent,
    ...(task.model ? { model: `${task.model.providerID}/${task.model.modelID}` } : {}),
    ...(task.command ? { command: task.command } : {}),
    ...(task.background !== undefined ? { background: task.background } : {}),
  }
}
