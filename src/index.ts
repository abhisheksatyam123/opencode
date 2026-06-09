import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "@/surface/cli/cmd/run"
import { GenerateCommand } from "@/surface/cli/cmd/generate"
import { Log } from "@/foundation/util/log"
import { ConsoleCommand } from "@/surface/cli/cmd/account"
import { ProvidersCommand } from "@/surface/cli/cmd/providers"
import { AgentCommand } from "@/surface/cli/cmd/agent"
import { UpgradeCommand } from "@/surface/cli/cmd/upgrade"
import { UninstallCommand } from "@/surface/cli/cmd/uninstall"
import { VaultCommand } from "@/surface/cli/cmd/vault"
import { ModelsCommand } from "@/surface/cli/cmd/models"
import { UI } from "@/surface/cli/ui"
import { resolveNetworkOptions } from "@/surface/cli/network"
import { Installation } from "@/init/installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "@/surface/cli/error"
import { ServeCommand } from "@/surface/cli/cmd/serve"
import { Filesystem } from "@/foundation/util/filesystem"
import { DebugCommand } from "@/surface/cli/cmd/debug"
import { StatsCommand } from "@/surface/cli/cmd/stats"
import { GithubCommand } from "@/surface/cli/cmd/github"
import { ExportCommand } from "@/surface/cli/cmd/export"
import { ImportCommand } from "@/surface/cli/cmd/import"
import { AttachCommand } from "@/surface/cli/cmd/tui/attach"
import { TuiThreadCommand } from "@/surface/cli/cmd/tui/thread"
import { AcpCommand } from "@/surface/cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "@/surface/cli/cmd/web"
import { PrCommand } from "@/surface/cli/cmd/pr"
import { SessionCommand } from "@/surface/cli/cmd/session"
import { DbCommand } from "@/surface/cli/cmd/db"
import { ToolCommand } from "@/surface/cli/cmd/tool"
import path from "path"
import { Global } from "@/filesystem/global"
import { JsonMigration } from "@/storage/json-migration"
import { Gc } from "@/storage/gc"
import { Database } from "@/storage/db"
import { SessionTable } from "@/process/session/session.sql"
import { Phase } from "@/workflow/phase"
import { RuntimeRole } from "@/workflow/runtime-role"
import { DispatchReason } from "@/workflow/dispatch-reason"
import { BootstrapSeed } from "@/workflow/bootstrap-seed"
import { ToolCard } from "@/tool/card"
import { Policy } from "@/permission/policy"
import { InitRegistry } from "@/init"
import { PreemptionSweep } from "@/process/session/preemption-sweep"
import { Quota } from "@/process/session/quota"
import { MessageType } from "@/workflow/message-type"
import { Bus } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"
import { markPacketStale } from "@/process/session/context-packet"
import { errorMessage } from "@/foundation/util/error"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { PluginCommand } from "@/surface/cli/cmd/plug"
import { Heap } from "@/surface/cli/heap"
import { Federation } from "@/notes/federation"
import { Layer } from "effect"
import { FoundationLayer } from "./foundation/layer"
import { BusLayer } from "@/bus/wiring/layer"
import { StorageLayer } from "@/storage/wiring/layer"
import { FilesystemLayer } from "@/filesystem/wiring/layer"
import { ConfigLayer } from "@/config/layer"
import { ProviderLayer } from "@/provider/layer"
import { PermissionLayer } from "@/permission/layer"
import { ProcessLayer } from "@/process/layer"
import { ToolLayer } from "@/tool/layer"
import { AgentLayer } from "@/agent/layer"
import { WorkflowLayer } from "@/workflow/layer"
import { SurfaceLayer } from "@/surface/layer"
import { InitLayer } from "@/init/layer"
import { Config } from "@/config/config"
import { Flag } from "@/foundation/flag/flag"
import { Server } from "@/surface/server/server"

export const ProductionLayer = Layer.mergeAll(
  FoundationLayer,
  BusLayer,
  StorageLayer,
  FilesystemLayer,
  ConfigLayer,
  ProviderLayer,
  PermissionLayer,
  ProcessLayer,
  ToolLayer,
  AgentLayer,
  WorkflowLayer,
  SurfaceLayer,
  InitLayer,
)

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("web", {
    describe: "start web server alongside TUI",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "ERROR"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })

    // Legacy XDG migration is retired: opencode.json lives only at
    // <vault>/etc/opencode.json and the session DB only at
    // <vault>/state/session/. The discovery layer enumerates exactly two
    // paths (vault + workspace), so XDG is never consulted.

    // The DB migration marker keys off Database.Path so relocated vault
    // state does not accidentally re-trigger a one-time migration.
    const marker = Database.Path
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(Database.Client().$client, {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }

    // Bootstrap seeds minimal vault cards on first boot (or whenever one
    // of the atomic subtrees is empty). This keeps registries populated
    // unless the operator explicitly clears the vault. Failures are
    // swallowed so boot continues and registry load() falls back to
    // in-code defaults.
    await BootstrapSeed.run().catch((err) => {
      Log.Default.warn("bootstrap-seed.run.failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    })

    // InitRegistry wraps each registry load() in a ServiceLoader and
    // preserves WARN-only failure semantics: loaders do not throw on their
    // own, and registries accumulate errors via Registry.errors().
    //
    // When init cards exist under <vault>/atomic/init/, boot order is
    // manifest-driven and topo-sorted by `depends_on`; otherwise the
    // registration order below is used.
    // Empty-vault path falls back to registration order per InitRegistry
    // §I1 — byte-identical to the legacy Promise.all semantics.
    //
    // Authoritative refs:
    //   project/software/opencode/specification/contract/init-registry.md
    //   scratchpad/task/opencode/active/todo-stage-9-init-system.md
    //
    // Failure handling (consumer obligation §267): RequiredServiceFailed
    // is surfaced to stderr before exit; optional-service degraded paths
    // are logged but allow boot to continue.
    const swallow = (name: string) => (err: unknown) => {
      Log.Default.warn(`${name}-registry.load.failed`, {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      const result = await InitRegistry.boot([
        { name: "phase", load: () => Phase.load().catch(swallow("phase")) },
        { name: "runtime-role", load: () => RuntimeRole.load().catch(swallow("runtime-role")) },
        { name: "dispatch-reason", load: () => DispatchReason.load().catch(swallow("dispatch-reason")) },
        { name: "policy", load: () => Policy.load().catch(swallow("policy")) },
        { name: "tool-card", load: () => ToolCard.load().catch(swallow("tool-card")) },
        // MessageTypeRegistry enables typed IPC. Older vaults do not need
        // an init card: empty-vault boot runs this registration-order
        // loader, and populated vaults skip unknown services without
        // failing so the registry remains manually reloadable.
        { name: "message-type", load: () => MessageType.load().catch(swallow("message-type")) },
        // PreemptionSweep depends on Policy for interval/threshold and
        // ProcessRegistry for snapshot list/signal.
        // No-op when policy.scheduler.preemption_check_ms is null/0.
        // The empty-vault fallback path runs loaders in this registration
        // order; the manifest-driven path uses
        // <vault>/atomic/init/0070-preemption-sweep.md to declare
        // depends_on=[policy].
        PreemptionSweep.loader,
        // Quota.subscribe wires ProcessEvent.{Spawned,Exited} to the
        // side-map cache and child_pids.
        // Idempotent + bus-not-bootstrapped tolerant; failures degrade
        // silently (cache miss falls back to O(depth) walk per
        // scheduler-quota.md §Hierarchical aggregation).
        {
          name: "quota-bus-subscribe" as const,
          load: async () => {
            try {
              Quota.subscribe()
            } catch (err) {
              swallow("quota-bus-subscribe")(err)
            }
          },
        },
      ])
      if (result.degraded.length > 0) {
        Log.Default.warn("init-registry.boot.degraded", {
          services: result.degraded,
          errors: Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [k, v.message])),
        })
      }
    } catch (err) {
      // Required service failed AND init-card classified it as required:true.
      // Surface diagnostic to stderr per consumer obligation §267 before
      // letting the error propagate; the engine treats this as fatal.
      const failed = err as { name?: string; data?: { service?: string; diagnostic?: string } }
      if (failed?.name === "InitRegistryRequiredServiceFailed") {
        process.stderr.write(
          `[BOOT FATAL] required service "${failed.data?.service ?? "unknown"}" failed: ${failed.data?.diagnostic ?? "no diagnostic"}\n`,
        )
      } else if (failed?.name === "InitRegistryCycleDetected") {
        process.stderr.write(
          `[BOOT FATAL] init-card depends_on cycle detected: ${JSON.stringify((err as { data?: { cycle?: string[] } }).data?.cycle ?? [])}\n`,
        )
      }
      throw err
    }

    // Active session ids fetched lazily from the DB so an empty / fresh
    // vault still boots without forcing schema queries before they're safe.
    // Used by I0.5 GC AND by I7.3 reload-bridge below.
    const activeSessionIds = (): string[] => {
      try {
        return Database.use((db) => db.select({ id: SessionTable.id }).from(SessionTable).all()).map(
          (r) => r.id as string,
        )
      } catch {
        return []
      }
    }

    // Hot-reload wiring: each registry watches its vault subtree
    // (debounced) and re-runs `load()` on *.md mutations.
    // Bus subscriber bridges `registry.reloaded` events to `markPacketStale`
    // so every active session's context packet rebuilds against fresh
    // registry state on the NEXT dispatch (mid-task delegations stay frozen
    // against their pre-reload snapshot per L3 §atomic-swap-and-reload + R4).
    //
    // Env-gated by OPENCODE_HOT_RELOAD=1; off by default for deterministic
    // cold-boot until field experience proves zero flake. Manual
    // `Registry.reload()` is the always-available fallback.
    if (process.env["OPENCODE_HOT_RELOAD"] === "1") {
      try {
        Phase.startWatcher()
        RuntimeRole.startWatcher()
        DispatchReason.startWatcher()
        Policy.startWatcher()
        MessageType.startWatcher()
        Federation.startWatcher()
        Log.Default.info("registry.watch.started", {
          kinds: ["phase", "runtime-role", "dispatch-reason", "policy", "message-type"],
          message: "Vault-backed L3 registry hot-reload active. Mutate vault cards to trigger live reload.",
        })
      } catch (err) {
        Log.Default.warn("registry.watch.start.failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Bus subscriber wiring is always active because manual
    // `Registry.reload()` calls also fire the event and operators expect
    // packet-stale propagation.
    try {
      Bus.subscribe(RegistryEvent.Reloaded, (evt) => {
        const sids = activeSessionIds()
        for (const sid of sids) {
          try {
            markPacketStale(sid, `registry-reloaded:${evt.properties.kind}`)
          } catch {
            /* swallow — packet-stale is best-effort signal */
          }
        }
      })
    } catch (err) {
      Log.Default.warn("registry.reloaded.subscribe.failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // GC sweep runs once at boot and then every 6h. It never throws;
    // engine boot survives any failure.
    Gc.run({ trigger: "boot", activeSessionIds: activeSessionIds() })
    Gc.startInterval(() => ({ activeSessionIds: activeSessionIds() }))

    const config = await Config.getGlobal()

    // Mode A: Parallel web server alongside TUI — AC-13
    // Gated by: --web flag > OPENCODE_WEB env > config.server.web
    // Insertion point: after InitRegistry.boot() + GC, before TUI command handler
    const webEnabled = Boolean(opts.web) || Flag.OPENCODE_WEB || (config?.server?.web ?? false)
    if (webEnabled) {
      const networkOpts = await resolveNetworkOptions({
        port: config?.server?.port ?? 0,
        hostname: config?.server?.hostname ?? "127.0.0.1",
        mdns: config?.server?.mdns ?? false,
        "mdns-domain": config?.server?.mdnsDomain ?? "opencode.local",
        cors: config?.server?.cors ?? [],
        web: true,
        "no-auth": config?.server?.noAuth ?? false,
        "permission-mode": config?.server?.permissionMode ?? "default",
      }).catch(() => ({
        port: 0,
        hostname: "127.0.0.1",
        mdns: false,
        mdnsDomain: "opencode.local",
        cors: [],
        web: true,
        password: undefined as string | undefined,
        readPassword: undefined as string | undefined,
        username: "opencode",
        noAuth: false,
        permissionMode: "default",
      }))

      Server.listen({
        port: networkOpts.port,
        hostname: networkOpts.hostname,
        mdns: networkOpts.mdns,
        mdnsDomain: networkOpts.mdnsDomain,
        cors: networkOpts.cors,
        password: networkOpts.password,
        readPassword: networkOpts.readPassword,
        noAuth: networkOpts.noAuth,
        username: networkOpts.username,
        permissionMode: networkOpts.permissionMode as "default" | "plan" | "bypass",
      })
        .then((listener) => {
          // Print URL to stderr (TUI owns stdout) — AC-13
          const url = `http://${networkOpts.hostname === "0.0.0.0" ? "localhost" : networkOpts.hostname}:${listener.port}`
          process.stderr.write(`  opencode web server:  ${Hyperlink.create(url)}\n`)
          if (networkOpts.password && !Flag.OPENCODE_SERVER_PASSWORD) {
            process.stderr.write(`  Write token:          ${networkOpts.password}\n`)
            if (networkOpts.readPassword && !Flag.OPENCODE_SERVER_READ_PASSWORD) {
              process.stderr.write(`  Read token:           ${networkOpts.readPassword}\n`)
            }
          }
          // Cleanup on process exit
          const cleanup = () => {
            listener.stop(true).catch(() => {})
          }
          process.once("SIGINT", cleanup)
          process.once("SIGTERM", cleanup)
          process.once("exit", cleanup)
        })
        .catch((err) => {
          process.stderr.write(
            `  opencode web server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        })
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(VaultCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .command(ToolCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, unknown> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      Object.assign(data, obj.data)
    }
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
