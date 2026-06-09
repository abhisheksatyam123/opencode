import { createContext, type ParentProps, useContext } from "solid-js"

export type DiagramRuntime = {
  getMermaidScriptUrl: () => string
  renderPlantUML: (source: string) => Promise<string>
}

const DiagramContext = createContext<DiagramRuntime | null>(null)

export function DiagramProvider(props: ParentProps<{ value?: DiagramRuntime | null }>) {
  return <DiagramContext.Provider value={props.value ?? null}>{props.children}</DiagramContext.Provider>
}

export function useDiagram() {
  return useContext(DiagramContext) ?? null
}
