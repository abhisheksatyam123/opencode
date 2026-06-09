import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"
import type { Snapshot } from "@/storage/snapshot"
import { useExit } from "@/surface/cli/cmd/tui/context/exit"
import { useArgs } from "@/surface/cli/cmd/tui/context/args"
import { batch, onMount } from "solid-js"
import { Log } from "@/foundation/util/log"
import type { Path } from "@opencode-ai/sdk"
import type { Workspace } from "@opencode-ai/sdk/v2"
import { ConsoleState, emptyConsoleState, type ConsoleState as ConsoleStateType } from "@/config/console-state"

type TodoSectionSnapshot = {
  title: string
  body: string
}

type SessionTodoSnapshot = {
  todos?: Todo[]
  tree?: Todo[]
  progress_tail?: string[]
  context?: string
  learnings_by_agent?: Record<string, string[]>
  open_questions?: string[]
  working_memory?: Record<string, string>
  verification_results?: string
  messages_recent?: string[]
  task_path?: string
  taskPath?: string
  sections?: TodoSectionSnapshot[]
}

type MessageWithModel = Message & {
  providerID?: unknown
  modelID?: unknown
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleStateType
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      subagent_model: {
        [sessionID: string]: {
          providerID: string
          modelID: string
          pending?: boolean
        }
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      todo_tree: {
        [sessionID: string]: Todo[]
      }
      workspace_todos: Todo[]
      attached_todo_ids: {
        [sessionID: string]: string[]
      }
      attached_todo_labels: {
        [sessionID: string]: Record<string, string>
      }
      todo_sections: {
        [sessionID: string]: {
          context?: string
          learnings_by_agent?: Record<string, string[]>
          open_questions?: string[]
          working_memory?: Record<string, string>
          verification_results?: string
          messages_recent?: string[]
          /** Server wire field. Prefer taskPath in UI code. */
          task_path?: string
          taskPath?: string
          sections?: { title: string; body: string }[]
          progress_tail?: string[]
        }
      }
      progress_tail: {
        [sessionID: string]: string[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
      workspaceList: Workspace[]
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      subagent_model: {},
      session_diff: {},
      todo: {},
      todo_tree: {},
      workspace_todos: [],
      attached_todo_ids: {},
      attached_todo_labels: {},
      todo_sections: {},
      progress_tail: {},
      message: {},
      part: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
      workspaceList: [],
    })

    const sdk = useSDK()

    async function syncWorkspaces() {
      const result = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!result?.data) return
      setStore("workspaceList", reconcile(result.data))
    }

    sdk.event.listen((e) => {
      const event = e.details
      switch (event.type) {
        case "server.instance.disposed":
          bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "task.updated":
          {
            const properties = event.properties as typeof event.properties & {
              workspace_todos?: Todo[]
              task_path?: string
              attached_todo_ids?: string[]
              attached_todo_labels?: Record<string, string>
            }
            setStore("todo", properties.sessionID, properties.todos)
            if (properties.tree) {
              setStore("todo_tree", properties.sessionID, properties.tree)
            }
            if (properties.progress_tail) {
              setStore("progress_tail", properties.sessionID, properties.progress_tail)
            }
            if (properties.workspace_todos !== undefined) {
              setStore("workspace_todos", properties.workspace_todos)
            }
            if (properties.attached_todo_ids !== undefined) {
              setStore("attached_todo_ids", properties.sessionID, properties.attached_todo_ids)
            }
            if (properties.attached_todo_labels !== undefined) {
              setStore("attached_todo_labels", properties.sessionID, properties.attached_todo_labels)
            }
            if (
              properties.context !== undefined ||
              properties.learnings_by_agent !== undefined ||
              properties.open_questions !== undefined ||
              properties.working_memory !== undefined ||
              properties.verification_results !== undefined ||
              properties.messages_recent !== undefined ||
              properties.task_path !== undefined ||
              properties.sections !== undefined ||
              properties.progress_tail !== undefined
            ) {
              setStore("todo_sections", properties.sessionID, {
                context: properties.context,
                learnings_by_agent: properties.learnings_by_agent,
                open_questions: properties.open_questions,
                working_memory: properties.working_memory,
                verification_results: properties.verification_results,
                messages_recent: properties.messages_recent,
                task_path: properties.task_path,
                taskPath: properties.task_path,
                sections: properties.sections,
                progress_tail: properties.progress_tail,
              })
            }
          }
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const info = event.properties.info as MessageWithModel
          if (info?.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
            setStore("subagent_model", info.sessionID, {
              providerID: info.providerID,
              modelID: info.modelID,
              pending: false,
            })
          }
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = sdk.client.session
        .list({ start: start })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({}, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({}, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({}, { throwOnError: true })
        .then((x) => ConsoleState.parse(x.data))
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({}, { throwOnError: true })
      const configPromise = sdk.client.config.get({}, { throwOnError: true })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
            sdk.client.session.status().then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
            sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
            syncWorkspaces(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          await exit(e)
        })
    }

    onMount(() => {
      bootstrap()
    })

    const fullSyncedSessions = new Set<string>()
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              const todoResp = todo.data as SessionTodoSnapshot | undefined
              draft.todo[sessionID] = todoResp?.todos ?? []
              if (todoResp?.tree) draft.todo_tree[sessionID] = todoResp.tree
              if (todoResp?.progress_tail) draft.progress_tail[sessionID] = todoResp.progress_tail
              if (
                todoResp?.context !== undefined ||
                todoResp?.learnings_by_agent !== undefined ||
                todoResp?.open_questions !== undefined ||
                todoResp?.working_memory !== undefined ||
                todoResp?.verification_results !== undefined ||
                todoResp?.messages_recent !== undefined ||
                todoResp?.taskPath !== undefined ||
                todoResp?.task_path !== undefined ||
                todoResp?.sections !== undefined ||
                todoResp?.progress_tail !== undefined
              ) {
                draft.todo_sections[sessionID] = {
                  context: todoResp.context,
                  learnings_by_agent: todoResp.learnings_by_agent,
                  open_questions: todoResp.open_questions,
                  working_memory: todoResp.working_memory,
                  verification_results: todoResp.verification_results,
                  messages_recent: todoResp.messages_recent,
                  task_path: todoResp.task_path,
                  taskPath: todoResp.taskPath ?? todoResp.task_path,
                  sections: todoResp.sections,
                  progress_tail: todoResp.progress_tail,
                }
              }
              draft.message[sessionID] = messages.data!.map((x) => x.info)
              for (const message of messages.data!) {
                draft.part[message.info.id] = message.parts
              }
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      workspace: {
        get(workspaceID: string) {
          return store.workspaceList.find((workspace) => workspace.id === workspaceID)
        },
        sync: syncWorkspaces,
      },
      bootstrap,
    }
    return result
  },
})
