# opencode

Agent runtime + CLI/TUI/server. TypeScript on Bun. Effect-based composition. Vault-resident agent cards.

## Running OpenCode

OpenCode supports default TUI, web UI, and headless server modes.

### TUI Mode (default)

Starts the terminal UI (`$0` command in `src/index.ts`).

```bash
bun run src/index.ts
```

### Web Mode

Starts the API server and opens the web interface in your browser.

```bash
bun run src/index.ts web
```

Using a built Linux x64 binary:

```bash
# Local browser access
./dist/opencode-linux-x64/bin/opencode web --port 4096

# LAN access from another machine
./dist/opencode-linux-x64/bin/opencode web --hostname 0.0.0.0 --port 4097
# Then open http://<your-lan-ip>:4097 from the other machine.
# Use `hostname -I` to find the LAN IP.
```

For LAN binds, OpenCode prints write/read tokens unless auth is explicitly disabled. If a port is already in use, choose another port or pass `--port 0` to let OpenCode pick a free one.

### Server Mode (headless)

Starts the API server without opening a browser.

```bash
bun run src/index.ts serve
```

### TUI + Web Server

Runs TUI and starts a parallel web/API server (`--web`).

```bash
bun run src/index.ts --web
```

### Dev Mode

```bash
bun run dev        # forwards to src/index.ts (same CLI/TUI commands)
bun run dev web    # frontend dev server + backend serve process
```

### Network + Auth flags (`web`, `serve`, and `--web`)

```bash
# Bind to a specific interface/port (flag is --hostname, not --host)
bun run src/index.ts web --hostname 0.0.0.0 --port 4096

# mDNS + custom domain
bun run src/index.ts web --mdns --mdns-domain opencode.local

# Disable auth explicitly (unsafe on non-loopback)
bun run src/index.ts serve --hostname 0.0.0.0 --no-auth
```

By default, loopback binds (`127.0.0.1`) do not require auth tokens. For non-loopback binds, OpenCode auto-generates write/read tokens unless explicitly provided or auth is disabled.

```bash
OPENCODE_SERVER_PASSWORD="my-write-token" \
OPENCODE_SERVER_READ_PASSWORD="my-read-token" \
OPENCODE_SERVER_USERNAME="opencode" \
bun run src/index.ts web --hostname 0.0.0.0
```

There is no `--no-open` flag for `web`; use `serve` when you want to avoid auto-opening a browser.

## Core Workflow (Todo + Notes)

- The core execution loop is todo-driven and notes-vault-centric.
- Notes vault is the source of truth for long-lived state (plans, tasks, architecture notes, project notes).
- Runtime skill discovery is deprecated in core flow; command/session/server surfaces operate without requiring `skill` loading. Todo + notes remain the primary coordination system.

## Primary + Secondary Tooling

- Primary agent tool surface is fixed to two tools: `bash` and `task`.
- Secondary tooling should live in the notes vault at `<notes-root>/tools/`.
- The `bash` tool automatically prepends `<notes-root>/tools` to `PATH`, so secondary tools are invoked through `bash`.
- Secondary-tool layer is available both as:
  - API: `src/tool/secondary/index.ts`
  - CLI: `opencode tool list` and `opencode tool run <name> [args...]`

### Adding a Secondary Tool

1. Add an executable script/binary to `<notes-root>/tools/` (for example `lsp`).
2. (Optional) Add a card at `<notes-root>/atomic/tools/<name>.md` to improve script summary in bash tool descriptions.
3. Invoke it via `bash` by command name, same as any other CLI tool.

## Quickstart

```bash
bun install
bun run dev              # CLI in dev mode
bun run typecheck        # tsgo --noEmit
bun run lint             # eslint src/ --max-warnings=9999
bun run dep-check        # depcruise — module-boundary rules
bun test                 # vitest run
```

## Repository layout (current)

`src/` is a flat collection of module directories. No layered subdirectory hierarchy exists today.

```
src/
├── index.ts                    # CLI entry (yargs)
├── lsp.ts                      # public package entry — ./lsp
├── mcp.ts                      # public package entry — ./mcp
├── node.ts                     # public package entry — ./node
├── sql.d.ts                    # *.sql module declaration
│
├── foundation/                 # primitives shared by all modules
├── bus/                        # typed event channel
├── storage/                    # SQLite + json migration
├── filesystem/                 # FS port
├── config/                     # configuration + env
├── permission/                 # permission gating
├── provider/                   # LLM provider SDKs
├── notes/                      # vault I/O port
├── process/                    # process registry + lifecycle
├── tool/                       # tool definitions + dispatch
├── agent/                      # agent card loading + execution
├── workflow/                   # workflow orchestration
├── surface/                    # cross-surface orchestration
└── init/                       # composition root
```

## Test layout (current)

Tests mirror the flat `src/` structure. Most modules have a flat `test/<module>/` directory.

```
test/
├── foundation/
├── agent/
├── bus/
├── config/
├── filesystem/
├── notes/
├── permission/
├── process/
├── provider/
├── storage/
├── surface/
├── tool/
├── workflow/
├── boundary/                   # cross-module boundary tests
├── contract/                   # contract conformance tests
├── init/
└── regression/
```

## Path aliases (current)

Active aliases from `tsconfig.json`:

```jsonc
{
  // Glob — resolves any src/ path directly
  "@/*": ["./src/*"],

  // Foundation subtree
  "@foundation/*": ["./src/foundation/*"],

  // TUI subtree
  "@tui/*": ["./src/surface/cli/cmd/tui/*"],

  // Vendored packages (under src/foundation/vendor/)
  "@opencode-ai/util/*": ["./src/foundation/vendor/util/*"],
  "@opencode-ai/plugin": ["./src/foundation/vendor/plugin/index.ts"],
  "@opencode-ai/plugin/tool": ["./src/foundation/vendor/plugin/tool.ts"],
  "@opencode-ai/plugin/tui": ["./src/foundation/vendor/plugin/tui.ts"],
  "@opencode-ai/sdk": ["./src/foundation/vendor/sdk/index.ts"],
  // … other @opencode-ai/sdk/* sub-paths

  // @m/* aliases exist in tsconfig but point at target layered paths
  // (e.g. src/infrastructure/bus/index.ts) that do not yet exist on disk.
  // Most @m/* aliases are currently broken — see Target architecture below.
  // Working exceptions (src/init/* barrels that exist today):
  "@m/init": ["./src/init/index.ts"],
  "@m/account": ["./src/init/account/index.ts"],
  "@m/auth": ["./src/init/auth/index.ts"],
  "@m/installation": ["./src/init/installation/index.ts"],
  "@m/npm": ["./src/init/npm/index.ts"],
  "@m/nversion": ["./src/init/nversion/index.ts"],
  "@m/plugin": ["./src/init/plugin/index.ts"],
}
```

## Public package exports (current)

From `package.json`:

```jsonc
"exports": {
  "./*": "./src/*.ts"
}
```

This single glob maps `import "opencode/foo"` → `./src/foo.ts`. There are no named sub-path exports (`.`, `./node`, `./lsp`, `./mcp`) in the current `package.json`.

## Build · test · verify

```bash
bun run typecheck       # tsgo
bun run lint            # eslint
bun run dep-check       # depcruise
bun test                # vitest
bun run build           # production build (script/build.ts)
```

## Target architecture (migration goal)

> **Not yet enforced.** The sections below describe the intended end-state. Most modules have not yet been split into `contract/impl/wiring/` subdirectories, and dep-cruiser layer-direction rules are not fully active.

### L0–L5 layered layout (target)

```
src/
├── foundation/                 # L0 · primitives shared by ALL contracts
├── infrastructure/             # L1 · process-wide singletons (bus, storage, filesystem)
├── platform/                   # L2 · capability + identity (config, permission, provider, notes)
├── runtime/                    # L3 · execution machinery (process, tool, lsp, mcp)
├── domain/                     # L4 · business logic (agent, workflow, session)
├── interface/                  # L5 · entry surfaces (cli, server, surface, init)
└── support/                    # cross-cutting (foundation-only outbound)
```

Layer rule: `L_n` may import only from `L_<n`. Enforced by dep-cruiser once migration is complete.

### Per-module shape (target)

Each module will follow a `contract / impl / wiring` split:

```
<module>/
├── contract/                   # PURE. zero impl deps.
│   ├── port.ts                 #   operation signatures
│   ├── schema.ts               #   public data types
│   ├── error.ts                #   named errors
│   ├── event.ts                #   bus events
│   ├── identity.ts             #   branded IDs
│   ├── conformance.ts          #   adapter test suite
│   └── version.ts              #   CONTRACT_VERSION
│
├── impl/                       # PRIVATE to this module
│   └── adapter.ts
│
├── wiring/                     # Effect Layer composition
│   ├── layer.ts
│   └── test-layer.ts
│
└── index.ts                    # PUBLIC barrel — contract/* + wiring/* only, never impl/*
```

A contract is 5 things: **port** (signatures) · **schema** (data types) · **error** (named errors) · **event** (bus messages) · **identity** (branded IDs). A `conformance.ts` export lets any adapter prove behavioral substitutability.

### Import rules (target)

| From              | May import                                             | Forbidden                                 |
| ----------------- | ------------------------------------------------------ | ----------------------------------------- |
| `<m>/contract/`   | `foundation/*` only                                    | own `impl/`, own `wiring/`, other modules |
| `<m>/impl/`       | own `contract/`, lower-layer modules' `index.ts`       | other modules' `impl/` or `wiring/`       |
| `<m>/wiring/`     | own `contract/`, own `impl/`, lower modules' `wiring/` | direct cross-module impl reach-in         |
| `<m>/index.ts`    | own `contract/*`, own `wiring/{layer,test-layer}.ts`   | own `impl/*`                              |
| consumer of `<m>` | `<m>/index.ts` only                                    | `<m>/contract/<file>.ts`, `<m>/impl/*`    |

### Test layout (target)

```
test/<module>/
├── contract.test.ts            # conformance suite against default adapter
├── impl/<feature>.test.ts      # impl unit tests
└── integration/<scenario>.test.ts
```

## Notes

- Notes-vault-first: all durable workflow artifacts live under vault roots (`atomic/`, `project/`, `scratchpad/`).
- `src/` is currently flat (see Repository layout above). The L0–L5 layered structure and `contract/impl/wiring/` splits are migration targets, not current state.
