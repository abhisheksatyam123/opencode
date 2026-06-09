export interface ConfigAccountBridge {
  readonly activeOrg: () => Promise<
    | {
        account: { id: unknown; url: string }
        org: { id: unknown; name: string }
      }
    | undefined
  >
  readonly config: (accountID: unknown, orgID: unknown) => Promise<Record<string, unknown> | undefined>
  readonly token: (accountID: unknown) => Promise<string | undefined>
}

let bridge: ConfigAccountBridge | undefined

export function registerConfigAccountBridge(next: ConfigAccountBridge): () => void {
  bridge = next
  return () => {
    if (bridge === next) bridge = undefined
  }
}

export const ConfigAccount = {
  activeOrg() {
    return bridge?.activeOrg() ?? Promise.resolve(undefined)
  },
  config(accountID: unknown, orgID: unknown) {
    return bridge?.config(accountID, orgID) ?? Promise.resolve(undefined)
  },
  token(accountID: unknown) {
    return bridge?.token(accountID) ?? Promise.resolve(undefined)
  },
}
