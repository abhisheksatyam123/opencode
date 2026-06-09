import { Effect, Layer, ServiceMap, Stream } from "effect"
import path from "path"
import { fileURLToPath } from "node:url"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { FileWatcher } from "@/filesystem/file/watcher"
import { Snapshot } from "@/storage/snapshot"
import { Log } from "@/foundation/util/log"
import { Process } from "@/foundation/util/process"
import { Instance } from "@/config/project/instance"
import z from "zod"
import { VcsPolicy } from "@/permission/policy/vcs"

export namespace Vcs {
  const log = Log.create({ service: "vcs" })

  const logText = (value: string | Uint8Array) => {
    const text = typeof value === "string" ? value : value.toString()
    return text.length > 500 ? `${text.slice(0, 500)}...` : text
  }

  type GitKind = "added" | "deleted" | "modified"
  type GitBase = {
    readonly name: string
    readonly ref: string
  }
  type GitItem = {
    readonly file: string
    readonly code: string
    readonly status: GitKind
  }
  type GitStat = {
    readonly file: string
    readonly additions: number
    readonly deletions: number
  }
  type PerforceItem = {
    depotFile: string
    action: string
  }

  const GIT_CFG = [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.symlinks=true",
    "-c",
    "core.quotepath=false",
  ] as const

  const runGit = Effect.fnUntraced(function* (cwd: string, args: string[]) {
    const out = yield* Effect.promise(() => Process.run(["git", ...GIT_CFG, ...args], { cwd, nothrow: true }))
    return {
      exitCode: out.code,
      text: () => out.stdout.toString(),
      stdout: out.stdout,
      stderr: out.stderr,
    }
  })

  const runP4 = Effect.fnUntraced(function* (cwd: string, args: string[]) {
    const out = yield* Effect.promise(() => Process.run(["p4", ...args], { cwd, nothrow: true }))
    return {
      exitCode: out.code,
      text: () => out.stdout.toString(),
      stdout: out.stdout,
      stderr: out.stderr,
    }
  })

  const textGit = Effect.fnUntraced(function* (cwd: string, args: string[]) {
    return (yield* runGit(cwd, args)).text()
  })

  const linesGit = Effect.fnUntraced(function* (cwd: string, args: string[]) {
    return (yield* textGit(cwd, args))
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  })

  const refsGit = Effect.fnUntraced(function* (cwd: string) {
    return yield* linesGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  })

  const configuredDefaultBranch = Effect.fnUntraced(function* (cwd: string, list: string[]) {
    const result = yield* runGit(cwd, ["config", "init.defaultBranch"])
    const name = result.text().trim()
    if (!name || !list.includes(name)) return
    return { name, ref: name } satisfies GitBase
  })

  const primaryRemote = Effect.fnUntraced(function* (cwd: string) {
    const list = yield* linesGit(cwd, ["remote"])
    if (list.includes("origin")) return "origin"
    if (list.length === 1) return list[0]
    if (list.includes("upstream")) return "upstream"
    return list[0]
  })

  const branchGit = Effect.fnUntraced(function* (cwd: string) {
    const result = yield* runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (result.exitCode !== 0) return
    const text = result.text().trim()
    return text || undefined
  })

  const prefixGit = Effect.fnUntraced(function* (cwd: string) {
    const result = yield* runGit(cwd, ["rev-parse", "--show-prefix"])
    if (result.exitCode !== 0) return ""
    return result.text().trim()
  })

  const defaultBranchGit = Effect.fnUntraced(function* (cwd: string) {
    const remote = yield* primaryRemote(cwd)
    if (remote) {
      const head = yield* runGit(cwd, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])
      if (head.exitCode === 0) {
        const ref = head.text().trim().replace(/^refs\/remotes\//, "")
        const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
        if (name) return { name, ref } satisfies GitBase
      }
    }

    const list = yield* refsGit(cwd)
    const configured = yield* configuredDefaultBranch(cwd, list)
    if (configured) return configured
    if (list.includes("main")) return { name: "main", ref: "main" } satisfies GitBase
    if (list.includes("master")) return { name: "master", ref: "master" } satisfies GitBase
  })

  const hasHeadGit = Effect.fnUntraced(function* (cwd: string) {
    const result = yield* runGit(cwd, ["rev-parse", "--verify", "HEAD"])
    return result.exitCode === 0
  })

  const mergeBaseGit = Effect.fnUntraced(function* (cwd: string, base: string, head = "HEAD") {
    const result = yield* runGit(cwd, ["merge-base", base, head])
    if (result.exitCode !== 0) return
    const text = result.text().trim()
    return text || undefined
  })

  const showGit = Effect.fnUntraced(function* (cwd: string, ref: string, file: string, prefix = "") {
    const target = prefix ? `${prefix}${file}` : file
    const result = yield* runGit(cwd, ["show", `${ref}:${target}`])
    if (result.exitCode !== 0) return ""
    if (result.stdout.includes(0)) return ""
    return result.text()
  })

  const count = (text: string) => {
    if (!text) return 0
    if (!text.endsWith("\n")) return text.split("\n").length
    return text.slice(0, -1).split("\n").length
  }

  const work = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string, file: string) {
    const full = path.join(cwd, file)
    if (!(yield* fs.exists(full).pipe(Effect.orDie))) return ""
    const buf = yield* fs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
    if (Buffer.from(buf).includes(0)) return ""
    return Buffer.from(buf).toString("utf8")
  })

  const nums = (list: GitStat[]) =>
    new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

  const merge = (...lists: GitItem[][]) => {
    const out = new Map<string, GitItem>()
    lists.flat().forEach((item) => {
      if (!out.has(item.file)) out.set(item.file, item)
    })
    return [...out.values()]
  }

  const files = Effect.fnUntraced(function* (
    fs: AppFileSystem.Interface,
    cwd: string,
    ref: string | undefined,
    list: GitItem[],
    map: Map<string, { additions: number; deletions: number }>,
  ) {
    const base = ref ? yield* prefixGit(cwd) : ""
    const next = yield* Effect.forEach(
      list,
      (item) =>
        Effect.gen(function* () {
          const before = item.status === "added" || !ref ? "" : yield* showGit(cwd, ref, item.file, base)
          const after = item.status === "deleted" ? "" : yield* work(fs, cwd, item.file)
          const stat = map.get(item.file)
          return {
            file: item.file,
            before,
            after,
            additions: stat?.additions ?? (item.status === "added" ? count(after) : 0),
            deletions: stat?.deletions ?? (item.status === "deleted" ? count(before) : 0),
            status: item.status,
          } satisfies Snapshot.FileDiff
        }),
      { concurrency: 8 },
    )
    return next.toSorted((a, b) => a.file.localeCompare(b.file))
  })

  const gitKind = (code: string): GitKind => {
    if (code === "??") return "added"
    if (code.includes("U")) return "modified"
    if (code.includes("A") && !code.includes("D")) return "added"
    if (code.includes("D") && !code.includes("A")) return "deleted"
    return "modified"
  }

  const nuls = (text: string) => text.split("\0").filter(Boolean)
  const PROJECT_PATHSPEC = "."

  const statusGit = Effect.fnUntraced(function* (cwd: string) {
    return nuls(
      yield* textGit(cwd, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "-z",
        "--",
        PROJECT_PATHSPEC,
      ]),
    ).flatMap((item) => {
      const file = item.slice(3)
      if (!file) return []
      const code = item.slice(0, 2)
      return [{ file, code, status: gitKind(code) } satisfies GitItem]
    })
  })

  const diffGit = Effect.fnUntraced(function* (cwd: string, ref: string) {
    const list = nuls(
      yield* textGit(cwd, ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", PROJECT_PATHSPEC]),
    )
    return list.flatMap((code, idx) => {
      if (idx % 2 !== 0) return []
      const file = list[idx + 1]
      if (!code || !file) return []
      return [{ file, code, status: gitKind(code) } satisfies GitItem]
    })
  })

  const statsGit = Effect.fnUntraced(function* (cwd: string, ref: string) {
    return nuls(
      yield* textGit(cwd, ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", PROJECT_PATHSPEC]),
    )
      .flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies GitStat,
        ]
      })
  })


  const p4Records = (text: string) => {
    const out: PerforceItem[] = []
    let current: Partial<PerforceItem> = {}
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\.\.\.\s+(\S+)\s+(.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2]?.trim() ?? ""
      if (key === "depotFile") {
        if (current.depotFile && current.action) out.push(current as PerforceItem)
        current = { depotFile: value }
      } else if (key === "action") {
        current.action = value
      }
    }
    if (current.depotFile && current.action) out.push(current as PerforceItem)
    return out
  }

  const perforceKind = (action: string): GitKind => {
    if (action === "add" || action === "branch" || action === "move/add") return "added"
    if (action === "delete" || action === "move/delete") return "deleted"
    return "modified"
  }

  const p4Where = Effect.fnUntraced(function* (cwd: string, depotFile: string) {
    const result = yield* runP4(cwd, ["-ztag", "where", depotFile])
    if (result.exitCode !== 0) return
    for (const line of result.text().split(/\r?\n/)) {
      const match = line.match(/^\.\.\.\s+path\s+(.*)$/)
      if (!match) continue
      const local = match[1]?.trim()
      if (local) return local
    }
  })

  const p4Print = Effect.fnUntraced(function* (cwd: string, depotFile: string) {
    const result = yield* runP4(cwd, ["print", "-q", `${depotFile}#have`])
    if (result.exitCode !== 0) return ""
    if (result.stdout.includes(0)) return ""
    return result.text()
  })

  const statText = (before: string, after: string) => {
    const left = before ? before.replace(/\r\n/g, "\n").split("\n") : []
    const right = after ? after.replace(/\r\n/g, "\n").split("\n") : []
    if (left.at(-1) === "") left.pop()
    if (right.at(-1) === "") right.pop()
    let start = 0
    while (start < left.length && start < right.length && left[start] === right[start]) start++
    let endLeft = left.length - 1
    let endRight = right.length - 1
    while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) {
      endLeft--
      endRight--
    }
    return {
      additions: Math.max(0, endRight - start + 1),
      deletions: Math.max(0, endLeft - start + 1),
    }
  }

  const projectRelative = (cwd: string, localPath: string) => {
    const full = localPath.startsWith("file://") ? fileURLToPath(localPath) : path.resolve(cwd, localPath)
    const rel = path.relative(cwd, full)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
    return rel.split(path.sep).join("/")
  }

  const perforce = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string) {
    log.info("perforce.diff.start", { cwd })
    const opened = yield* runP4(cwd, ["-ztag", "opened", "..."])
    if (opened.exitCode !== 0) {
      log.warn("perforce.diff.opened_failed", {
        cwd,
        exitCode: opened.exitCode,
        stderr: logText(opened.stderr),
      })
      return []
    }
    const records = p4Records(opened.text())
    const next = yield* Effect.forEach(
      records,
      (item) =>
        Effect.gen(function* () {
          const local = yield* p4Where(cwd, item.depotFile)
          const file = local ? projectRelative(cwd, local) : undefined
          if (!file) return
          const status = perforceKind(item.action)
          const before = status === "added" ? "" : yield* p4Print(cwd, item.depotFile)
          const after = status === "deleted" ? "" : yield* work(fs, cwd, file)
          const stat = statText(before, after)
          return {
            file,
            before,
            after,
            additions: stat.additions,
            deletions: stat.deletions,
            status,
          } satisfies Snapshot.FileDiff
        }).pipe(Effect.catch(() => Effect.succeed(undefined as Snapshot.FileDiff | undefined))),
      { concurrency: 8 },
    )
    const filtered: Snapshot.FileDiff[] = []
    for (const item of next) if (item) filtered.push(item)
    const statusCounts = filtered.reduce(
      (acc, item) => {
        const status = item.status ?? "modified"
        acc[status]++
        return acc
      },
      { added: 0, deleted: 0, modified: 0 },
    )
    log.info("perforce.diff.complete", {
      cwd,
      openedCount: records.length,
      diffCount: filtered.length,
      skippedCount: records.length - filtered.length,
      statusCounts,
    })
    return filtered.toSorted((a, b) => a.file.localeCompare(b.file))
  })
  const track = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string, ref: string | undefined) {
    if (!ref) return yield* files(fs, cwd, ref, yield* statusGit(cwd), new Map())
    const [list, stats] = yield* Effect.all([statusGit(cwd), statsGit(cwd, ref)], { concurrency: 2 })
    return yield* files(fs, cwd, ref, list, nums(stats))
  })

  const compare = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string, ref: string) {
    const [list, stats, extra] = yield* Effect.all([diffGit(cwd, ref), statsGit(cwd, ref), statusGit(cwd)], {
      concurrency: 3,
    })
    return yield* files(
      fs,
      cwd,
      ref,
      merge(
        list,
        extra.filter((item) => item.code === "??"),
      ),
      nums(stats),
    )
  })

  export const Mode = z.enum(["git", "branch", "perforce"])
  export type Mode = z.infer<typeof Mode>

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string().optional(),
      default_branch: z.string().optional(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly branch: () => Effect.Effect<string | undefined>
    readonly defaultBranch: () => Effect.Effect<string | undefined>
    readonly diff: (mode: Mode) => Effect.Effect<Snapshot.FileDiff[]>
  }

  interface State {
    current: string | undefined
    root: GitBase | undefined
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Vcs") {}

  export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Bus.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const bus = yield* Bus.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Vcs.state")((ctx) =>
          Effect.gen(function* () {
            if (ctx.project.vcs !== "git") {
              return { current: undefined, root: undefined }
            }

            const get = Effect.fnUntraced(function* () {
              return yield* branchGit(ctx.directory)
            })
            const [current, root] = yield* Effect.all([branchGit(ctx.directory), defaultBranchGit(ctx.directory)], {
              concurrency: 2,
            })
            const value = { current, root }
            log.info("initialized", { branch: value.current, default_branch: value.root?.name })

            yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
              Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
              Stream.runForEach((_evt) =>
                Effect.gen(function* () {
                  const next = yield* get()
                  if (next !== value.current) {
                    log.info("branch changed", { from: value.current, to: next })
                    value.current = next
                    yield* bus.publish(Event.BranchUpdated, { branch: next })
                  }
                }),
              ),
              Effect.forkScoped,
            )

            return value
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("Vcs.init")(function* () {
          yield* InstanceState.get(state)
        }),
        branch: Effect.fn("Vcs.branch")(function* () {
          return yield* InstanceState.use(state, (x) => x.current)
        }),
        defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
          return yield* InstanceState.use(state, (x) => x.root?.name)
        }),
        diff: Effect.fn("Vcs.diff")(function* (mode: Mode) {
          const value = yield* InstanceState.get(state)
          if (mode === "perforce") return yield* perforce(fs, Instance.directory)
          if (Instance.project.vcs !== "git") return []
          if (mode === "git") {
            return yield* track(fs, Instance.directory, (yield* hasHeadGit(Instance.directory)) ? "HEAD" : undefined)
          }

          if (!value.root) return []
          if (value.current && value.current === value.root.name) return []
          const ref = yield* mergeBaseGit(Instance.directory, value.root.ref)
          if (!ref) return []
          return yield* compare(fs, Instance.directory, ref)
        }),
      })
    }),
  )

  const defaultLayer = layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function init() {
    return runPromise((svc) => svc.init())
  }

  export async function branch() {
    return runPromise((svc) => svc.branch())
  }

  export async function defaultBranch() {
    return runPromise((svc) => svc.defaultBranch())
  }

  export async function diff(mode: Mode) {
    return runPromise((svc) => svc.diff(mode))
  }
}

VcsPolicy.registerBridge({
  branch: () => Vcs.branch(),
})
