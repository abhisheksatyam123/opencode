import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/process/session/schema"
import { Session } from "@/process/session"
import { SessionPrompt } from "@/process/session/prompt"
import { TodoAgentRegistry } from "@/process/session/todo-agent-registry"
import type { TodoAgentAssignment, TodoAgentTask } from "@/process/session/todo-agent-protocol"
import {
  compileTodoAgentPrompt,
  compileTodoAgentSystemPrompt,
  pendingTodoAgentComments,
} from "@/process/session/todo-agent-protocol"

export namespace TodoAgentRunner {
  export type AgentInfo = {
    rootSessionID: SessionID
    name: string
    sessionID: SessionID
    providerID: string
    modelID: string
    created: boolean
    forked: boolean
    responseText?: string
  }

  export type SessionOps = {
    create(input: { parentID: SessionID; title: string }): Promise<{ id: SessionID }>
    fork(input: { sessionID: SessionID }): Promise<{ id: SessionID }>
    prompt(input: SessionPrompt.PromptInput): Promise<unknown>
  }

  export type RegistryOps = {
    get(input: { rootSessionID: SessionID; name: string }): TodoAgentRegistry.Info | undefined
    create(input: {
      rootSessionID: SessionID
      name: string
      sessionID: SessionID
      providerID: string
      modelID: string
      source?: TodoAgentRegistry.Source
    }): TodoAgentRegistry.Info
    upsert(input: {
      rootSessionID: SessionID
      name: string
      sessionID: SessionID
      providerID: string
      modelID: string
      source?: TodoAgentRegistry.Source
    }): TodoAgentRegistry.Info
  }

  export const defaultSessionOps: SessionOps = {
    create: (input) => Session.create({ parentID: input.parentID, title: input.title }),
    fork: (input) => Session.fork(input),
    prompt: (input) => SessionPrompt.prompt(input),
  }

  export const defaultRegistryOps: RegistryOps = {
    get: TodoAgentRegistry.get,
    create: TodoAgentRegistry.create,
    upsert: TodoAgentRegistry.upsert,
  }

  function providerModel(input: { providerID: string; modelID: string }) {
    const model = TodoAgentRegistry.normalizeProviderModel(input)
    return { providerID: ProviderID.make(model.providerID), modelID: ModelID.make(model.modelID) }
  }

  function sameProviderModel(a: { providerID: string; modelID: string }, b: { providerID: string; modelID: string }) {
    const left = TodoAgentRegistry.normalizeProviderModel(a)
    const right = TodoAgentRegistry.normalizeProviderModel(b)
    return left.providerID === right.providerID && left.modelID === right.modelID
  }

  function syncExistingModel(input: {
    rootSessionID: SessionID
    existing: TodoAgentRegistry.Info
    providerID: string
    modelID: string
    registry: RegistryOps
  }) {
    if (sameProviderModel(input.existing, input)) return input.existing
    return input.registry.upsert({
      rootSessionID: input.rootSessionID,
      name: input.existing.name,
      sessionID: input.existing.sessionID,
      providerID: input.providerID,
      modelID: input.modelID,
      source: input.existing.source,
    })
  }

  function responseTextFromPromptResult(result: unknown) {
    const parts = (
      result as { parts?: Array<{ type?: string; text?: unknown; synthetic?: boolean; ignored?: boolean }> }
    )?.parts
    if (!Array.isArray(parts)) return ""
    return parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n\n")
      .trim()
  }

  export async function resolveAgent(input: {
    rootSessionID: SessionID
    assignment: TodoAgentAssignment
    sessions?: SessionOps
    registry?: RegistryOps
  }): Promise<AgentInfo> {
    const sessions = input.sessions ?? defaultSessionOps
    const registry = input.registry ?? defaultRegistryOps

    if (input.assignment.kind === "create-or-reuse") {
      const existing = registry.get({ rootSessionID: input.rootSessionID, name: input.assignment.agentName })
      if (existing) {
        const info = syncExistingModel({
          rootSessionID: input.rootSessionID,
          existing,
          providerID: input.assignment.providerID,
          modelID: input.assignment.modelID,
          registry,
        })
        return {
          rootSessionID: input.rootSessionID,
          name: info.name,
          sessionID: info.sessionID,
          providerID: info.providerID,
          modelID: info.modelID,
          created: false,
          forked: false,
        }
      }
      const created = await sessions.create({
        parentID: input.rootSessionID,
        title: `${input.assignment.agentName} (todo agent)`,
      })
      const info = registry.create({
        rootSessionID: input.rootSessionID,
        name: input.assignment.agentName,
        sessionID: created.id,
        providerID: input.assignment.providerID,
        modelID: input.assignment.modelID,
        source: { type: "new" },
      })
      return {
        rootSessionID: input.rootSessionID,
        name: info.name,
        sessionID: info.sessionID,
        providerID: info.providerID,
        modelID: info.modelID,
        created: true,
        forked: false,
      }
    }

    const source = registry.get({ rootSessionID: input.rootSessionID, name: input.assignment.sourceAgentName })
    if (!source) throw new TodoAgentRegistry.AgentNotFoundError(input.rootSessionID, input.assignment.sourceAgentName)
    const target = registry.get({ rootSessionID: input.rootSessionID, name: input.assignment.targetAgentName })
    if (target) {
      if (target.source?.type === "fork" && target.source.fromAgent === source.name) {
        const info = syncExistingModel({
          rootSessionID: input.rootSessionID,
          existing: target,
          providerID: input.assignment.providerID,
          modelID: input.assignment.modelID,
          registry,
        })
        return {
          rootSessionID: input.rootSessionID,
          name: info.name,
          sessionID: info.sessionID,
          providerID: info.providerID,
          modelID: info.modelID,
          created: false,
          forked: true,
        }
      }
      throw new TodoAgentRegistry.DuplicateAgentError(input.rootSessionID, input.assignment.targetAgentName)
    }

    const forked = await sessions.fork({ sessionID: source.sessionID })
    const info = registry.create({
      rootSessionID: input.rootSessionID,
      name: input.assignment.targetAgentName,
      sessionID: forked.id,
      providerID: input.assignment.providerID,
      modelID: input.assignment.modelID,
      source: { type: "fork", fromAgent: source.name, fromSessionID: source.sessionID },
    })
    return {
      rootSessionID: input.rootSessionID,
      name: info.name,
      sessionID: info.sessionID,
      providerID: info.providerID,
      modelID: info.modelID,
      created: true,
      forked: true,
    }
  }

  export async function dispatchTask(input: {
    rootSessionID: SessionID
    task: TodoAgentTask
    systemsText?: string
    mode?: "initial" | "follow-up"
    sessions?: SessionOps
    registry?: RegistryOps
    onError?: (error: unknown) => void
    onComplete?: (agent: AgentInfo) => void | Promise<void>
  }): Promise<AgentInfo> {
    if (!input.task.assignment) throw new Error(`Todo task "${input.task.title}" has no assign: block`)
    const sessions = input.sessions ?? defaultSessionOps
    const agent = await resolveAgent({
      rootSessionID: input.rootSessionID,
      assignment: input.task.assignment,
      sessions,
      registry: input.registry,
    })
    const mode = input.mode ?? (pendingTodoAgentComments(input.task).length > 0 ? "follow-up" : "initial")
    const prompt = compileTodoAgentPrompt({ task: input.task, systemsText: input.systemsText, mode })
    const system = compileTodoAgentSystemPrompt({
      agentName: agent.name,
      mode,
      assignmentKind: input.task.assignment.kind,
      sourceAgentName: input.task.assignment.kind === "fork" ? input.task.assignment.sourceAgentName : undefined,
    })
    sessions
      .prompt({
        sessionID: agent.sessionID,
        model: providerModel(agent),
        system,
        parts: [{ type: "text", text: prompt }],
      })
      .then((result) => input.onComplete?.({ ...agent, responseText: responseTextFromPromptResult(result) }))
      .catch((error) => input.onError?.(error))
    return agent
  }

  export async function runTask(input: {
    rootSessionID: SessionID
    task: TodoAgentTask
    systemsText?: string
    mode?: "initial" | "follow-up"
    sessions?: SessionOps
    registry?: RegistryOps
  }): Promise<AgentInfo> {
    if (!input.task.assignment) throw new Error(`Todo task "${input.task.title}" has no assign: block`)
    const sessions = input.sessions ?? defaultSessionOps
    const agent = await resolveAgent({
      rootSessionID: input.rootSessionID,
      assignment: input.task.assignment,
      sessions,
      registry: input.registry,
    })
    const mode = input.mode ?? (pendingTodoAgentComments(input.task).length > 0 ? "follow-up" : "initial")
    const prompt = compileTodoAgentPrompt({ task: input.task, systemsText: input.systemsText, mode })
    const system = compileTodoAgentSystemPrompt({
      agentName: agent.name,
      mode,
      assignmentKind: input.task.assignment.kind,
      sourceAgentName: input.task.assignment.kind === "fork" ? input.task.assignment.sourceAgentName : undefined,
    })
    const result = await sessions.prompt({
      sessionID: agent.sessionID,
      model: providerModel(agent),
      system,
      parts: [{ type: "text", text: prompt }],
    })
    return { ...agent, responseText: responseTextFromPromptResult(result) }
  }
}
