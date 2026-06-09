import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import { Bus } from "@/bus"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import { Flag } from "@/foundation/flag/flag"
import { Permission } from "@/permission"
import { AppFileSystem } from "@/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@/foundation/util/glob"
import { Log } from "@/foundation/util/log"
import { Discovery } from "./discovery"
import { projectRoot, sharedRoot } from "@/tool/notes/paths"
export * from "./contract/port"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const SKILL_SYSTEM_DISABLED = process.env.OPENCODE_DISABLE_SKILL_SYSTEM === "1"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const EXTERNAL_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"
  const EXTERNAL_DIRS = [".claude/skills", ".agents/skills"]

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  type SkillAgent = { permission: Permission.Ruleset }

  type State = {
    skills: Record<string, Info>
    dirs: Set<string>
  }

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly all: () => Effect.Effect<Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly available: (agent?: SkillAgent) => Effect.Effect<Info[]>
  }

  const add = Effect.fnUntraced(function* (state: State, match: string, bus: Bus.Interface) {
    const md = yield* Effect.tryPromise({
      try: () => ConfigMarkdown.parse(match),
      catch: (err) => err,
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (err) {
          const message = ConfigMarkdown.FrontmatterError.isInstance(err)
            ? err.data.message
            : `Failed to parse skill ${match}`
          yield* bus.publish(Config.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
          log.error("failed to load skill", { skill: match, err })
          return undefined
        }),
      ),
    )

    if (!md) return

    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    if (!parsed.success) return

    if (state.skills[parsed.data.name]) {
      log.warn("duplicate skill name", {
        name: parsed.data.name,
        existing: state.skills[parsed.data.name].location,
        duplicate: match,
      })
    }

    state.dirs.add(path.dirname(match))
    state.skills[parsed.data.name] = {
      name: parsed.data.name,
      description: parsed.data.description,
      location: match,
      content: md.content,
    }
  })

  const scan = Effect.fnUntraced(function* (
    state: State,
    bus: Bus.Interface,
    root: string,
    pattern: string,
    opts?: { dot?: boolean; scope?: string },
  ) {
    const matches = yield* Effect.tryPromise({
      try: () =>
        Glob.scan(pattern, {
          cwd: root,
          absolute: true,
          include: "file",
          symlink: true,
          dot: opts?.dot,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => {
        if (!opts?.scope) return Effect.die(error)
        log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
        return Effect.succeed([] as string[])
      }),
    )

    yield* Effect.forEach(matches, (match) => add(state, match, bus), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  /**
   * Add a notes-vault skill from a .md file. The skill name is derived from
   * the filename (without .md extension). Requires a `description` field in
   * frontmatter. Unlike SKILL.md skills, the name is NOT required in frontmatter.
   */
  const addNotesVaultSkill = Effect.fnUntraced(function* (state: State, filePath: string) {
    const md = yield* Effect.tryPromise({
      try: () => ConfigMarkdown.parse(filePath),
      catch: (err) => err,
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (err) {
          log.error("failed to load notes vault skill", { skill: filePath, err })
          return undefined
        }),
      ),
    )

    if (!md) return

    const description = md.data?.description
    if (!description || typeof description !== "string") return

    const name = path.basename(filePath, ".md")
    if (!name) return

    if (state.skills[name]) {
      log.warn("duplicate skill name (notes vault)", {
        name,
        existing: state.skills[name].location,
        duplicate: filePath,
      })
    }

    state.dirs.add(path.dirname(filePath))
    state.skills[name] = {
      name,
      description,
      location: filePath,
      content: md.content,
    }
  })

  /**
   * Scan a notes-vault skill directory for *.md files and add each as a skill.
   */
  const scanNotesVaultDir = Effect.fnUntraced(function* (state: State, dir: string, fsys: AppFileSystem.Interface) {
    if (!(yield* fsys.isDir(dir))) return

    const matches = yield* Effect.tryPromise({
      try: () =>
        Glob.scan("*.md", {
          cwd: dir,
          absolute: true,
          include: "file",
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => {
        log.error("failed to scan notes vault skill dir", { dir, error })
        return Effect.succeed([] as string[])
      }),
    )

    yield* Effect.forEach(matches, (match) => addNotesVaultSkill(state, match), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  const loadSkills = Effect.fnUntraced(function* (
    state: State,
    config: Config.Interface,
    discovery: Discovery.Interface,
    bus: Bus.Interface,
    fsys: AppFileSystem.Interface,
    directory: string,
    worktree: string,
    _projectName?: string,
  ) {
    if (SKILL_SYSTEM_DISABLED) {
      log.info("skill system disabled by env flag")
      return
    }

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(os.homedir(), dir)
        if (!(yield* fsys.isDir(root))) continue
        yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
      }

      const upDirs = yield* fsys
        .up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))

      for (const root of upDirs) {
        yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
      }

      // Notes-vault skill scanning — vault is the canonical source.
      // General skills:  ~/notes/atomic/skill/                   (sharedRoot()/skill/)
      // Project skills:  ~/notes/project/software/<n>/skill/     (projectRoot()/skill/)
      const disableExternal =
        Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS ||
        process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS === "true" ||
        process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS === "1"
      if (!disableExternal) {
        yield* scanNotesVaultDir(state, path.join(sharedRoot(), "skill"), fsys)
        yield* scanNotesVaultDir(state, path.join(projectRoot(), "skill"), fsys)
      }
    }

    const configDirs = yield* config.directories()
    for (const dir of configDirs) {
      yield* scan(state, bus, dir, OPENCODE_SKILL_PATTERN)
    }

    const cfg = yield* config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(yield* fsys.isDir(dir))) {
        log.warn("skill path not found", { path: dir })
        continue
      }

      yield* scan(state, bus, dir, SKILL_PATTERN)
    }

    for (const url of cfg.skills?.urls ?? []) {
      const pulledDirs = yield* discovery.pull(url)
      for (const dir of pulledDirs) {
        state.dirs.add(dir)
        yield* scan(state, bus, dir, SKILL_PATTERN)
      }
    }

    log.info("init", { count: Object.keys(state.skills).length })
  })

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Skill") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const bus = yield* Bus.Service
      const fsys = yield* AppFileSystem.Service
      const config = yield* Config.Service
      const state = yield* InstanceState.make(
        Effect.fn("Skill.state")(function* (ctx) {
          const s: State = { skills: {}, dirs: new Set() }
          yield* loadSkills(s, config, discovery, bus, fsys, ctx.directory, ctx.worktree, ctx.project?.name)
          return s
        }),
      )

      const getState = InstanceState.get(state).pipe(Effect.provideService(Config.Service, config))

      const get = (name: string) => Effect.map(getState, (s) => s.skills[name])
      const all = () => Effect.map(getState, (s) => Object.values(s.skills))
      const dirs = () => Effect.map(getState, (s) => Array.from(s.dirs))
      const available = (agent?: SkillAgent) =>
        Effect.map(getState, (s) => {
          const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
          if (!agent) return list
          return list.filter((skill) => {
            return Permission.evaluate("skill", skill.name, agent.permission).action !== "deny"
          })
        })

      return Service.of({ get, all, dirs, available })
    }),
  )

  // defaultLayer: for embedding in other services (Config must be provided by caller)
  export const defaultLayer = layer.pipe(
    Layer.provide(Discovery.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(AppFileSystem.defaultLayer),
  )

  // standaloneLayer: for static methods / makeRuntime (self-contained with Config)
  const standaloneLayer = defaultLayer.pipe(Layer.provide(Config.defaultLayer))

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) return "No skills are currently available."

    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
        "</available_skills>",
      ].join("\n")
    }

    return ["## Available Skills", ...list.map((skill) => `- **${skill.name}**: ${skill.description}`)].join("\n")
  }

  // Use isolated memo map to avoid test ordering issues where other services
  // corrupt the shared memo map.
  const { runPromise } = makeRuntime(Service, standaloneLayer, { isolatedMemoMap: true })

  export async function get(name: string) {
    return runPromise((skill) => skill.get(name))
  }

  export async function all() {
    return runPromise((skill) => skill.all())
  }

  export async function dirs() {
    return runPromise((skill) => skill.dirs())
  }

  export async function available(agent?: SkillAgent) {
    return runPromise((skill) => skill.available(agent))
  }
}
