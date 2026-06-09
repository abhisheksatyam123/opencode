import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { Bus } from "@/bus"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()

  return (
    <DialogSelect
      title="Subagent Actions"
      options={[
        {
          title: "Open",
          value: "subagent.view",
          description: "the subagent's session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
        {
          title: "Pause",
          value: "subagent.pause",
          description: "pause the subagent execution",
          onSelect: (dialog) => {
            Bus.publish(Bus.SubagentPause, { sessionID: props.sessionID })
            dialog.clear()
          },
        },
        {
          title: "Resume",
          value: "subagent.resume",
          description: "resume the subagent execution",
          onSelect: (dialog) => {
            Bus.publish(Bus.SubagentResume, { sessionID: props.sessionID })
            dialog.clear()
          },
        },
        {
          title: "Change Model",
          value: "subagent.change-model",
          description: "switch the subagent to a different model",
          onSelect: (dialog) => {
            dialog.replace(() => <DialogSubagentModel sessionID={props.sessionID} />)
          },
        },
      ]}
    />
  )
}

export function DialogSubagentModel(props: { sessionID: string }) {
  const sync = useSync()
  const dialog = useDialog()

  const options = createMemo(() => {
    const result: Array<{ title: string; value: string; description: string; onSelect: () => void }> = []

    const sortedProviders = [...sync.data.provider].sort((a, b) => a.name.localeCompare(b.name))

    for (const provider of sortedProviders) {
      for (const [modelID, info] of Object.entries(provider.models)) {
        if (info.status === "deprecated") continue
        result.push({
          title: info.name ?? modelID,
          value: `${provider.id}/${modelID}`,
          description: provider.name,
          onSelect: () => {
            sync.set("subagent_model", props.sessionID, {
              providerID: provider.id,
              modelID,
              pending: false,
            })
            Bus.publish(Bus.SubagentModelChange, {
              sessionID: props.sessionID,
              model: `${provider.id}/${modelID}`,
            })
            dialog.clear()
          },
        })
      }
    }

    return result
  })

  return <DialogSelect title="Change Subagent Model" options={options()} />
}
