import { Effect, Layer, ServiceMap } from "effect"
import { AppFileSystem } from "@/filesystem"
import { Config } from "@/config/config"
import { HttpClient } from "effect/unstable/http"
import { MessageV2 } from "@/process/session/message-v2"
import { MessageID } from "@/process/session/schema"

export namespace InstructionPrompt {
  export async function systemPaths(): Promise<Set<string>> {
    return new Set<string>()
  }

  export async function system(): Promise<string[]> {
    return []
  }

  export async function find(dir: string): Promise<string | undefined> {
    void dir
    return undefined
  }

  export async function resolve(
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ): Promise<{ filepath: string; content: string }[]> {
    void messages
    void filepath
    void messageID
    return []
  }

  export function clear(messageID: MessageID): void {
    void messageID
  }

  export function loaded(messages: MessageV2.WithParts[]): Set<string> {
    const result = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          const meta = (part.state as { metadata?: { loaded?: string[] } }).metadata
          if (meta?.loaded) {
            for (const p of meta.loaded) result.add(p)
          }
        }
      }
    }
    return result
  }
}

// Effect-based Instruction service stub
export namespace Instruction {
  export interface Interface {
    readonly clear: (messageID: MessageID) => Effect.Effect<void>
    readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
    readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
    readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
    readonly resolve: (
      messages: MessageV2.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Instruction") {}

  export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Config.Service | HttpClient.HttpClient> =
    Layer.succeed(Service, {
      clear: (messageID) => Effect.sync(() => InstructionPrompt.clear(messageID)),
      systemPaths: () => Effect.promise(() => InstructionPrompt.systemPaths()),
      system: () => Effect.promise(() => InstructionPrompt.system()),
      find: (dir) => Effect.promise(() => InstructionPrompt.find(dir)),
      resolve: (messages, filepath, messageID) =>
        Effect.promise(() => InstructionPrompt.resolve(messages, filepath, messageID)),
    })

  export const defaultLayer = layer

  export function clear(messageID: MessageID) {
    return InstructionPrompt.clear(messageID)
  }

  export async function systemPaths() {
    return InstructionPrompt.systemPaths()
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    return InstructionPrompt.loaded(messages)
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: MessageID) {
    return InstructionPrompt.resolve(messages, filepath, messageID)
  }
}
