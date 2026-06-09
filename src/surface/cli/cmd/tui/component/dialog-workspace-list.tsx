import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/surface/cli/cmd/tui/context/sdk"
import { useToast } from "@/surface/cli/cmd/tui/ui/toast"
import { useKeybind } from "@/surface/cli/cmd/tui/context/keybind"
import { DialogSessionList } from "@/surface/cli/cmd/tui/component/workspace/dialog-session-list"
import { setTimeout as sleep } from "node:timers/promises"

function scoped(sdk: ReturnType<typeof useSDK>, sync: ReturnType<typeof useSync>, workspaceID?: string) {
  return createOpencodeClient({
    baseUrl: sdk.url,
    fetch: sdk.fetch,
    directory: sync.data.path.directory || sdk.directory,
    experimental_workspaceID: workspaceID,
  })
}

async function openWorkspace(input: {
  dialog: ReturnType<typeof useDialog>
  route: ReturnType<typeof useRoute>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
  workspaceID: string
  forceCreate?: boolean
}) {
  const cacheSession = (session: Session) => {
    input.sync.set(
      "session",
      [...input.sync.data.session.filter((item) => item.id !== session.id), session].toSorted((a, b) =>
        a.id.localeCompare(b.id),
      ),
    )
  }

  const client = scoped(input.sdk, input.sync, input.workspaceID)
  const listed = input.forceCreate ? undefined : await client.session.list({ roots: true, limit: 1 })
  const session = listed?.data?.[0]
  if (session?.id) {
    cacheSession(session)
    input.route.navigate({
      type: "session",
      sessionID: session.id,
    })
    input.dialog.clear()
    return
  }
  let created: Session | undefined
  while (!created) {
    const result = await client.session.create({ workspaceID: input.workspaceID }).catch(() => undefined)
    if (!result) {
      input.toast.show({
        message: "Failed to open workspace",
        variant: "error",
      })
      return
    }
    if (result.response.status >= 500 && result.response.status < 600) {
      await sleep(1000)
      continue
    }
    if (!result.data) {
      input.toast.show({
        message: "Failed to open workspace",
        variant: "error",
      })
      return
    }
    created = result.data
  }
  cacheSession(created)
  input.route.navigate({
    type: "session",
    sessionID: created.id,
  })
  input.dialog.clear()
}

export function DialogWorkspaceList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const [toDelete, setToDelete] = createSignal<string>()
  const [counts, setCounts] = createSignal<Record<string, number | null | undefined>>({})

  const open = (workspaceID: string, forceCreate?: boolean) =>
    openWorkspace({
      dialog,
      route,
      sdk,
      sync,
      toast,
      workspaceID,
      forceCreate,
    })

  async function selectWorkspace(workspaceID: string) {
    if (workspaceID === "__local__") {
      if (localCount() > 0) {
        dialog.replace(() => <DialogSessionList localOnly={true} />)
        return
      }
      route.navigate({
        type: "home",
      })
      dialog.clear()
      return
    }
    const count = counts()[workspaceID]
    if (count && count > 0) {
      dialog.replace(() => <DialogSessionList workspaceID={workspaceID} />)
      return
    }

    if (count === 0) {
      await open(workspaceID)
      return
    }
    const client = scoped(sdk, sync, workspaceID)
    const listed = await client.session.list({ roots: true, limit: 1 }).catch(() => undefined)
    if (listed?.data?.length) {
      dialog.replace(() => <DialogSessionList workspaceID={workspaceID} />)
      return
    }
    await open(workspaceID)
  }

  const currentWorkspaceID = createMemo(() => {
    if (route.data.type === "session") {
      return sync.session.get(route.data.sessionID)?.workspaceID ?? "__local__"
    }
    return "__local__"
  })

  const localCount = createMemo(
    () => sync.data.session.filter((session) => !session.workspaceID && !session.parentID).length,
  )

  let run = 0
  createEffect(() => {
    const workspaces = sync.data.workspaceList
    const next = ++run
    if (!workspaces.length) {
      setCounts({})
      return
    }
    setCounts(Object.fromEntries(workspaces.map((workspace) => [workspace.id, undefined])))
    void Promise.all(
      workspaces.map(async (workspace) => {
        const client = scoped(sdk, sync, workspace.id)
        const result = await client.session.list({ roots: true }).catch(() => undefined)
        return [workspace.id, result ? (result.data?.length ?? 0) : null] as const
      }),
    ).then((entries) => {
      if (run !== next) return
      setCounts(Object.fromEntries(entries))
    })
  })

  const options = createMemo(() => [
    {
      title: "Local",
      value: "__local__",
      category: "Workspace",
      description: "Use the local machine",
      footer: `${localCount()} session${localCount() === 1 ? "" : "s"}`,
    },
    ...sync.data.workspaceList.map((workspace) => {
      const count = counts()[workspace.id]
      return {
        title:
          toDelete() === workspace.id
            ? `Delete ${workspace.id}? Press ${keybind.print("session_delete")} again`
            : workspace.id,
        value: workspace.id,
        category: workspace.type,
        description: workspace.branch ? `Branch ${workspace.branch}` : undefined,
        footer:
          count === undefined
            ? "Loading sessions..."
            : count === null
              ? "Sessions unavailable"
              : `${count} session${count === 1 ? "" : "s"}`,
      }
    }),
  ])

  onMount(() => {
    dialog.setSize("large")
    void sync.workspace.sync()
  })

  return (
    <DialogSelect
      title="Workspaces"
      skipFilter={true}
      options={options()}
      current={currentWorkspaceID()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        setToDelete(undefined)
        void selectWorkspace(option.value)
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (option.value === "__local__") return
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            const result = await sdk.client.experimental.workspace.remove({ id: option.value }).catch(() => undefined)
            setToDelete(undefined)
            if (result?.error) {
              toast.show({
                message: "Failed to delete workspace",
                variant: "error",
              })
              return
            }
            if (currentWorkspaceID() === option.value) {
              route.navigate({
                type: "home",
              })
            }
            await sync.workspace.sync()
          },
        },
      ]}
    />
  )
}
