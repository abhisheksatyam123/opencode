import { createStore } from "solid-js/store"
import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"
import { Flag } from "@/foundation/flag/flag"
import type { PromptInfo } from "@/surface/cli/cmd/tui/component/prompt/history"

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
  workspaceID?: string
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    // flag-followup-1: route through Flag.OPENCODE_ROUTE so env-var
    // consumers are discoverable in one place. JSON.parse stays in the
    // consumer because the Flag namespace stores the raw string.
    const [store, setStore] = createStore<Route>(
      Flag.OPENCODE_ROUTE
        ? JSON.parse(Flag.OPENCODE_ROUTE)
        : {
            type: "home",
          },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
