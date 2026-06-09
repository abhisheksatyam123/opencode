import { SurfaceStatsTab } from "@/pages/session/surface-tabs/stats-tab"

export function SurfaceAgentManagerTab(props: { sessionID?: string }) {
  return <SurfaceStatsTab sessionID={props.sessionID} />
}
