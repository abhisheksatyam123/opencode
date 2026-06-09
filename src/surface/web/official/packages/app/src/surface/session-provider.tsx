import { createContext, type ParentProps, useContext } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { createHttpSurfaceBridge } from "./http-adapter"
import type { SurfaceBridge } from "./ports"

const SurfaceSessionBridgeContext = createContext<SurfaceBridge>()

export function SurfaceSessionBridgeProvider(props: ParentProps) {
  const sdk = useSDK()
  const server = useServer()
  const value = createHttpSurfaceBridge({
    baseUrl: sdk.url,
    directory: sdk.directory,
    server: server.current?.http,
    fetch: typeof window === "undefined" ? undefined : window.fetch.bind(window),
    event: sdk.event,
  })
  return <SurfaceSessionBridgeContext.Provider value={value}>{props.children}</SurfaceSessionBridgeContext.Provider>
}

export function useSurfaceSessionBridge() {
  const context = useContext(SurfaceSessionBridgeContext)
  if (!context) throw new Error("useSurfaceSessionBridge must be used within SurfaceSessionBridgeProvider")
  return context
}
