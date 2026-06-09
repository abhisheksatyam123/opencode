import { InstanceContextStorage } from "@/foundation/effect/instance-context"

export interface ConfigInstanceLifecycle {
  readonly disposeCurrent: () => Promise<void>
  readonly disposeAll: () => Promise<void>
}

let lifecycle: ConfigInstanceLifecycle | undefined

export function registerConfigInstanceLifecycle(next: ConfigInstanceLifecycle): () => void {
  lifecycle = next
  return () => {
    if (lifecycle === next) lifecycle = undefined
  }
}

export const ConfigInstance = {
  containsPath(filepath: string) {
    return InstanceContextStorage.containsPath(filepath)
  },
  get directory() {
    return InstanceContextStorage.directory
  },
  disposeCurrent() {
    return lifecycle?.disposeCurrent() ?? Promise.resolve()
  },
  disposeAll() {
    return lifecycle?.disposeAll() ?? Promise.resolve()
  },
}
