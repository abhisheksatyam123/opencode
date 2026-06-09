import type { MessageID, SessionID } from "@/foundation/identifier/session"

/**
 * Compatibility bridge for task-tool/session integration.
 *
 * The bridge intentionally keeps a narrow runtime boundary between the tool layer
 * and the session module to avoid a dependency cycle. Several methods accept or
 * return `any` because their concrete payloads are owned by session internals and
 * are passed through without interpretation here. Narrow at the session boundary
 * before removing this bridge.
 */
export namespace ToolSessionPort {
  export const AUTONOMOUS_MARKER = "<opencode:loop-autonomous>"

  export type PacketTrigger =
    | "todo-done"
    | "todo-revise"
    | "todo-switch"
    | "compaction"
    | "task-note-edit"
    | "subagent-launch"
    | "subagent-resume"
    | "reservation-release"

  export interface Bridge {
    readonly sessionCreate: (input: any) => Promise<any>
    readonly sessionGet: (id: SessionID) => Promise<any>
    readonly updatePart: (part: any) => Promise<any>
    readonly messageGet: (input: { sessionID: SessionID; messageID: MessageID }) => any
    readonly messagePage: (input: { sessionID: SessionID; limit: number }) => any
    readonly prompt: (input: any) => Promise<any>
    readonly resolvePromptParts: (parts: any) => Promise<any>
    readonly onCancel: (sessionID: SessionID, fn: (reason?: string) => void) => () => void
    readonly cancel: (sessionID: SessionID) => Promise<any>
    readonly buildPacket: (input: any) => Promise<any>
    readonly nextActionable: (planText: string, taskPath?: string) => any
    readonly hasActionableStateChanged: (prev: any, next: any) => boolean
    readonly markPacketStale: (sessionID: string, cause: string, force?: boolean) => void
  }

  let bridge: Bridge | undefined

  export function registerBridge(next: Bridge): () => void {
    bridge = next
    return () => {
      if (bridge === next) bridge = undefined
    }
  }

  function current(): Bridge {
    if (!bridge) throw new Error("ToolSessionPort bridge is not registered")
    return bridge
  }

  export const sessionCreate = (input: any) => current().sessionCreate(input)
  export const sessionGet = (id: SessionID) => current().sessionGet(id)
  export const updatePart = (part: any) => current().updatePart(part)
  export const messageGet = (input: { sessionID: SessionID; messageID: MessageID }) => current().messageGet(input)
  export const messagePage = (input: { sessionID: SessionID; limit: number }) => current().messagePage(input)
  export const prompt = (input: any) => current().prompt(input)
  export const resolvePromptParts = (parts: any) => current().resolvePromptParts(parts)
  export const onCancel = (sessionID: SessionID, fn: (reason?: string) => void) => current().onCancel(sessionID, fn)
  export const cancel = (sessionID: SessionID) => current().cancel(sessionID)
  export const buildPacket = (input: any) => current().buildPacket(input)
  export const nextActionable = (planText: string, taskPath?: string) => current().nextActionable(planText, taskPath)
  export const hasActionableStateChanged = (prev: any, next: any) => current().hasActionableStateChanged(prev, next)
  export const markPacketStale = (sessionID: string, cause: string, force?: boolean) =>
    current().markPacketStale(sessionID, cause, force)
}
