import { Context } from "@/foundation/effect/context"
import { InstanceContextStorage } from "@/foundation/effect/instance-context"

export namespace Env {
  const states = new Map<string, Record<string, string | undefined>>()

  function state() {
    try {
      const directory = InstanceContextStorage.directory
      let env = states.get(directory)
      if (!env) {
        env = { ...process.env } as Record<string, string | undefined>
        states.set(directory, env)
      }
      return env
    } catch (err) {
      if (!(err instanceof Context.NotFound)) throw err
      return process.env as Record<string, string | undefined>
    }
  }

  export function get(key: string) {
    const env = state()
    return env[key]
  }

  export function all() {
    return state()
  }

  export function set(key: string, value: string) {
    const env = state()
    env[key] = value
  }

  export function remove(key: string) {
    const env = state()
    delete env[key]
  }
}
