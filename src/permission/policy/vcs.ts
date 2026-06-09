export namespace VcsPolicy {
  export interface Bridge {
    readonly branch: () => Promise<string | undefined>
  }

  let bridge: Bridge | undefined

  export function registerBridge(next: Bridge): () => void {
    bridge = next
    return () => {
      if (bridge === next) bridge = undefined
    }
  }

  export async function branch(): Promise<string | undefined> {
    return bridge?.branch()
  }
}
