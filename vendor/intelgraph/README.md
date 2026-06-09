# intelgraph

`intelgraph` is a plugin-based code intelligence graph: it extracts structural
facts about your codebase (symbols, calls, imports, type references, inheritance,
JSX components, …) into an embedded SQLite graph and exposes them through 97+
query intents over an HTTP JSON API and a built-in CLI.

Several extractor plugins ship today:

- **`clangd-core`** for C/C++, backed by a persistent clangd LSP daemon.
- **`ts-core`** for TypeScript / JavaScript / JSX / TSX, using `tree-sitter`
  with no LSP required. Produces a richly annotated graph with cross-file call
  resolution, type references from signatures and bodies, JSX component edges,
  inheritance, and 17+ resolution kinds per call edge.

Visualization tools (such as `tui-relation-window`) consume the query layer
over the HTTP JSON API. The same query intents are also exposed by `npm run snapshot:stats`
which prints a workspace dashboard for any TS or C/C++ project.

## What it does

- starts or reuses a workspace-scoped clangd service for C/C++ extraction
- runs the ts-core tree-sitter extractor for TypeScript/JS workspaces
- writes facts into an embedded SQLite graph (`.intelgraph/intelligence.db` by
  default)
- exposes 97+ structural query intents via `POST /api/query` HTTP JSON API
- ships a standalone HTTP server (`npm run serve`) and a `snapshot:stats` CLI
  that prints a per-workspace dashboard in text, JSON, or markdown

## Runtime modes

### HTTP JSON API server (default)

`intelgraph` always starts an HTTP JSON API server on the configured port
(default: 7777). Use `POST /api/query` to run intelligence queries.

```bash
intelgraph --port 7777 --root /path/to/workspace
```

### Standalone serve mode

Use `npm run serve` (or `src/bin/serve.ts`) for a standalone HTTP server
without the daemon lifecycle:

```bash
npm run serve -- /path/to/workspace --port=7777
```

## Quick start

### 1. Build

```bash
bun install
bun run build
```

This produces `dist/index.js` and `dist/bridge.js`.

### 2. Start the HTTP API server

```bash
bun dist/index.js --port 7777 --root /path/to/your/workspace
```

Or use the standalone serve script:

```bash
npm run serve -- /path/to/your/workspace --port=7777
```

Notes:

- `--root` should point at the workspace that contains `compile_commands.json`
- `--clangd` is optional if `clangd` is already on `PATH`

### 3. Query the API

```bash
curl -s -X POST http://localhost:7777/api/query \
  -H 'Content-Type: application/json' \
  -d '{"intent": "direct_callers", "symbol": "vfs_read"}' | jq .
```

## Tool surface

The authoritative tool registry lives in `src/tools/index.ts`. The current source
defines 34 tools (callable via `POST /api/query` with `"tool": "<name>"`):

- `lsp_hover`
- `lsp_definition`
- `lsp_declaration`
- `lsp_type_definition`
- `lsp_references`
- `lsp_implementation`
- `lsp_document_highlight`
- `lsp_document_symbol`
- `lsp_workspace_symbol`
- `lsp_folding_range`
- `lsp_signature_help`
- `lsp_incoming_calls`
- `lsp_indirect_callers`
- `lsp_outgoing_calls`
- `lsp_supertypes`
- `lsp_subtypes`
- `lsp_rename`
- `lsp_format`
- `lsp_inlay_hints`
- `lsp_diagnostics`
- `lsp_code_action`
- `lsp_file_status`
- `lsp_index_status`
- `lsp_reason_chain`
- `lsp_runtime_flow`
- `backend_health`
- `intelligence_backend_info`
- `get_callers`
- `intelligence_query`
- `intelligence_graph`
- `intelligence_graph_diff`
- `intelligence_ingest`
- `intelligence_snapshot`
- `intelligence_extract_file`

These tools return readable plain text rather than raw JSON. Many of them also
append readiness hints while background indexing is still in progress.

## Configuration

### CLI options

```text
--root <path>         Workspace root. Defaults to .intelgraph.json, then cwd.
--port <number>       HTTP port (default: 7777).
--clangd <path>       Path to clangd binary. Defaults to "clangd".
--clangd-args <args>  Extra clangd args, comma-separated.
```

### Workspace config file

You can commit a `.intelgraph.json` file at the workspace root:

```json
{
  "clangd": "/usr/local/bin/clangd-20",
  "args": [
    "--background-index",
    "--enable-config",
    "--log=error"
  ],
  "enabled": true
}
```

Precedence is:

1. CLI flags
2. `.intelgraph.json`
3. built-in defaults

### Example `.clangd` file

You can still use clangd's own `.clangd` configuration in the target workspace:

```yaml
CompileFlags:
  Add:
    - -ferror-limit=0
  Remove:
    - -m*
    - -f*san

Index:
  Background: Build

Diagnostics:
  ClangTidy:
    Add: []
    Remove: ['*']

InlayHints:
  Enabled: Yes
  ParameterNames: Yes
  DeducedTypes: Yes
```

## Architecture at a glance

```text
HTTP client (curl / agent / OpenCode wrapper)
        |
        | POST /api/query  GET /api/graph  GET /api/health
        v
intelgraph HTTP JSON API server
        |
        | shared LSP client
        v
bridge socket or direct stdio
        |
        v
clangd
        |
        v
workspace source tree + background index
```

Important detail: the bridge layer keeps one active TCP socket at a time and
relies on higher-level reconnect logic.

## Persistence model

Per-workspace runtime state is stored under the workspace root:

- `.intelgraph-state.json` — saved bridge/HTTP daemon metadata
- `.intelgraph-spawn.lock` — coordination file to avoid duplicate daemon spawn

Log files are written to `~/.local/share/intelgraph/logs/`:

- `intelgraph.log` — main server log (override with `INTELGRAPH_LOG_DIR`)
- `intelgraph-bridge.log` — detached bridge log (written to workspace root)

## Manual operation examples

### Start the HTTP API server

```bash
bun dist/index.js \
  --port 7777 \
  --root /path/to/workspace \
  --clangd /usr/local/bin/clangd-20
```

### Query the API

```bash
# Health check
curl http://localhost:7777/api/health

# Intelligence query
curl -s -X POST http://localhost:7777/api/query \
  -H 'Content-Type: application/json' \
  -d '{"intent": "direct_callers", "symbol": "vfs_read"}' | jq .
```

### Keep a server alive with tmux

For large codebases you may still prefer to keep a manually launched server in
`tmux`:

```bash
tmux new-session -d -s intelgraph \
  "bun /path/to/intelgraph/dist/index.js --port 7777 --root /path/to/workspace"
```

## Development

Useful commands:

```bash
bun run build
bun run test
bun run test:unit
bun run test:integration
bun run test:e2e
bun run typecheck
```

Detailed test/config/docs now live in the notes vault under `/local/mnt/workspace/notes/project/software/intelgraph/`.

## Troubleshooting

### `compile_commands.json` is missing

Make sure the workspace root contains a compilation database clangd can use.

### `clangd` cannot be found

Pass `--clangd /full/path/to/clangd-20` or add clangd to `PATH`.

### Initial indexing is slow

That is expected on large C/C++ repositories. The point of the detached daemon
mode is to pay that cost once, then reuse the warm index.

### Existing daemon seems stale

Delete the workspace-local `.intelgraph-state.json` and restart.

### Need logs

Check:

- `~/.local/share/intelgraph/logs/intelgraph.log` — main server log
- `<workspace>/intelgraph-bridge.log` — detached bridge log
- Set `INTELGRAPH_LOG_DIR` to override the log directory

## More docs

- `doc/project/data/schema/sqlite-graph-schema.md` — **embedded SQLite intelligence schema** (tables, indexes, edge kinds, the join shape every query uses)
- `doc/project/architecture/extraction-pipeline.md` — **extraction pipeline**: how IExtractor plugins, the FactBus, and the SQLite store fit together
- `doc/atomic/domain/graph-db/philosophy-graph-instrumentation.md` — **core philosophy**: persistent LSP, graph model, intent-driven queries
- `doc/diagrams/intelgraph-architecture.puml` — PlantUML component diagram (basic runtime)
- `doc/diagrams/intelgraph-complete-architecture.puml` — **PlantUML complete architecture (multi-client + PostgreSQL)**

### Render the PlantUML diagrams

If you have PlantUML installed locally:

```bash
# Basic runtime architecture
plantuml doc/diagrams/intelgraph-architecture.puml

# Complete architecture with PostgreSQL intelligence store
plantuml doc/diagrams/intelgraph-complete-architecture.puml
```

This generates diagram images next to the `.puml` source files.

## License

MIT
