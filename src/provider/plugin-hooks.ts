import type { Hooks } from "@opencode-ai/plugin"
import { Effect } from "effect"

export type PluginHookName = keyof Hooks

export interface ProviderPluginHooksProvider {
  readonly init?: () => Promise<void>
  readonly list: () => Promise<Hooks[]>
  readonly trigger: <Output>(name: PluginHookName, input: unknown, output: Output) => Promise<Output>
  readonly notify: (name: PluginHookName, input: unknown) => Promise<void>
  readonly latestAnthropicToken?: () => Promise<string | undefined>
}

let provider: ProviderPluginHooksProvider | undefined

export function registerProviderPluginHooks(next: ProviderPluginHooksProvider): () => void {
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}

export const ProviderPluginHooks = {
  init() {
    return provider?.init?.() ?? Promise.resolve()
  },
  list() {
    return provider?.list() ?? Promise.resolve([])
  },
  trigger<Output>(name: PluginHookName, input: unknown, output: Output) {
    return provider?.trigger(name, input, output) ?? Promise.resolve(output)
  },
  notify(name: PluginHookName, input: unknown) {
    return provider?.notify(name, input) ?? Promise.resolve()
  },
  latestAnthropicToken() {
    return provider?.latestAnthropicToken?.() ?? Promise.resolve(undefined)
  },
  listEffect() {
    return Effect.promise(() => ProviderPluginHooks.list())
  },
  triggerEffect<Output>(name: PluginHookName, input: unknown, output: Output) {
    return Effect.promise(() => ProviderPluginHooks.trigger(name, input, output))
  },
  notifyEffect(name: PluginHookName, input: unknown) {
    return Effect.promise(() => ProviderPluginHooks.notify(name, input))
  },
}
