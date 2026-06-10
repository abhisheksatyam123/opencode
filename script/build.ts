#!/usr/bin/env bun
//
// build.ts — ZimaBlue minimal build
//
// Compiles the CLI to a single self-contained binary for the **current
// platform** under `dist/`. Derived from the original opencode build script
// but reduced to one target and no @opencode-ai/script dependency or
// GitHub release upload. Web/notes UI assets are embedded into the binary.
//
// Usage:
//   bun run build                  → dist/opencode-<os>-<arch>/bin/opencode
//   bun run build --skip-install   → skip cross-platform native deps install
//
// Requires:
//   - migration/<ts>_<slug>/migration.sql baked into the binary at compile time
//
// Note: models-snapshot.{js,d.ts} is no longer bundled. The runtime
// model catalog is sourced live from models.dev (or the user's
// OPENCODE_MODELS_PATH override). qpilot/qgenie proxy providers are
// wired directly in src/provider/provider.ts and do not depend on the
// models.dev catalog.
//
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import pkg from "../package.json"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
process.chdir(dir)

// ── flags ────────────────────────────────────────────────────────────────────
const skipInstall = process.argv.includes("--skip-install")

// ── 1. load migrations ───────────────────────────────────────────────────────
const migrationDirs = (await fs.promises.readdir(path.join(dir, "migration"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`✓ loaded ${migrations.length} migrations`)

// ── 2. resolve current target ────────────────────────────────────────────────
const os = process.platform
const arch = process.arch
if (arch !== "x64" && arch !== "arm64") {
  throw new Error(`unsupported arch: ${arch}`)
}
const name = [pkg.name, os === "win32" ? "windows" : os, arch].join("-")
const outDir = `dist/${name}`
const outBin = `${outDir}/bin/opencode`
console.log(`▶ building ${name}`)

// ── 3. clean dist ────────────────────────────────────────────────────────────
if (fs.existsSync("dist")) {
  await $`find dist -user $(id -u) -delete`.nothrow()
  await $`rm -rf dist`.nothrow()
}
await $`mkdir -p ${outDir}/bin`

// ── 4. install cross-platform native deps once (so Bun.build can pick the
//      right tree-sitter / parcel-watcher binary at compile time) ─────────────
if (!skipInstall) {
  console.log("Installing native deps for current platform …")
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`.nothrow()
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`.nothrow()
}

// ── 5. resolve parser worker (opentui's tree-sitter loader) ──────────────────
const parserWorker = fs.realpathSync(path.resolve(dir, "node_modules/@opentui/core/parser.worker.js"))
const workerPath = "./src/surface/cli/cmd/tui/worker.ts"
const bunfsRoot = os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")
const watcherPackage = `@parcel/watcher-${os}-${arch}${os === "linux" ? "-glibc" : ""}`

// ── 5b. build web ui ─────────────────────────────────────────────────────────
const webUIDir = path.join(dir, "src/surface/web")
const officialWebUIRoot = path.join(webUIDir, "official")
const officialWebUIApp = path.join(officialWebUIRoot, "packages/app")
const webUIOutDir = path.join(dir, "dist/web-ui")
type EmbeddedAsset = { type: string; data: string }
const webUIAssetMap: Record<string, EmbeddedAsset> = {}
const notesUIDir = path.join(dir, "src/surface/web/notes-ui")
const notesUIOutDir = path.join(dir, "dist/notes-ui")
const notesUIAssetMap: Record<string, EmbeddedAsset> = {}

async function embedAsset(file: string): Promise<EmbeddedAsset> {
  const data = Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")
  return { type: Bun.file(file).type || "application/octet-stream", data }
}

async function collectAssets(base: string, current = base, out: Record<string, EmbeddedAsset> = {}) {
  for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await collectAssets(base, full, out)
      continue
    }
    if (!entry.isFile()) continue
    const rel = path.relative(base, full).replaceAll("\\", "/")
    if (rel.endsWith(".map")) continue
    out[rel] = await embedAsset(full)
  }
  return out
}

async function resolveGhosttyWasm(officialRoot: string): Promise<string | undefined> {
  const direct = [
    path.join(officialRoot, "node_modules/ghostty-web/ghostty-vt.wasm"),
    path.join(officialRoot, "node_modules/ghostty-web/dist/ghostty-vt.wasm"),
  ]
  for (const candidate of direct) {
    if (fs.existsSync(candidate)) return candidate
  }

  const bunNodeModules = path.join(officialRoot, "node_modules/.bun")
  if (!fs.existsSync(bunNodeModules)) return

  const entries = await fs.promises.readdir(bunNodeModules, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("ghostty-web@")) continue
    const packageRoot = path.join(bunNodeModules, entry.name, "node_modules/ghostty-web")
    const candidates = [path.join(packageRoot, "ghostty-vt.wasm"), path.join(packageRoot, "dist/ghostty-vt.wasm")]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
  }
}

await fs.promises.rm(webUIOutDir, { recursive: true, force: true })
await fs.promises.mkdir(webUIOutDir, { recursive: true })

if (!fs.existsSync(path.join(officialWebUIApp, "package.json"))) {
  throw new Error("Unified official web ui is required at src/surface/web/official/packages/app")
}

if (!fs.existsSync(path.join(officialWebUIRoot, "node_modules"))) {
  console.log("Installing official web ui deps …")
  await $`bun install --cwd ${officialWebUIRoot}`
}
console.log("Building official web ui …")
await $`cd ${officialWebUIApp} && bun run build -- --outDir ${webUIOutDir} --emptyOutDir`
const ghosttyWasm = await resolveGhosttyWasm(officialWebUIRoot)
if (!ghosttyWasm) throw new Error("official web ui dependency ghostty-web/ghostty-vt.wasm not found")
const ghosttyWasmTarget = path.join(webUIOutDir, "ghostty-vt.wasm")
await fs.promises.copyFile(ghosttyWasm, ghosttyWasmTarget)
console.log(`✓ copied ghostty wasm → ${ghosttyWasmTarget}`)
Object.assign(webUIAssetMap, await collectAssets(webUIOutDir))
if (!webUIAssetMap["index.html"]) throw new Error("official web ui build did not produce index.html")
console.log(`✓ built official web ui → ${webUIOutDir}`)

const assetMapContent = `/**
 * Generated Web UI asset map — do not edit
 * Generated at build time by script/build.ts
 */
export default ${JSON.stringify(webUIAssetMap, null, 2)} as Record<string, { type: string; data: string }>
`

const assetMapPath = path.join(dir, "src/surface/server/opencode-web-ui.gen.ts")
await Bun.file(assetMapPath).write(assetMapContent)
console.log(`✓ generated asset map → ${assetMapPath}`)

// ── 5c. copy notes ui assets ────────────────────────────────────────────────
await fs.promises.mkdir(path.join(notesUIOutDir, "web"), { recursive: true })

const notesHTMLSrc = path.join(notesUIDir, "index.html")
const notesHTMLDest = path.join(notesUIOutDir, "index.html")
await fs.promises.copyFile(notesHTMLSrc, notesHTMLDest)
notesUIAssetMap["index.html"] = await embedAsset(notesHTMLDest)
console.log(`✓ copied notes ui html → ${notesHTMLDest}`)

for (const name of ["app.js", "style.css"]) {
  const source = path.join(notesUIDir, name)
  const target = path.join(notesUIOutDir, "web", name)
  await fs.promises.copyFile(source, target)
  notesUIAssetMap[`web/${name}`] = await embedAsset(target)
  console.log(`✓ copied notes ui asset → ${target}`)
}

const mermaidDistSrc = path.join(dir, "node_modules/mermaid/dist/mermaid.min.js")
const mermaidDistDest = path.join(notesUIOutDir, "web", "mermaid.min.js")
await fs.promises.copyFile(mermaidDistSrc, mermaidDistDest)
notesUIAssetMap["web/mermaid.min.js"] = await embedAsset(mermaidDistDest)
console.log(`✓ copied notes ui mermaid → ${mermaidDistDest}`)

const notesAssetMapContent = `/**
 * Generated Notes UI asset map — do not edit
 * Generated at build time by script/build.ts
 */
export default ${JSON.stringify(notesUIAssetMap, null, 2)} as Record<string, { type: string; data: string }>
`

const notesAssetMapPath = path.join(dir, "src/surface/server/opencode-notes-ui.gen.ts")
await Bun.file(notesAssetMapPath).write(notesAssetMapContent)
console.log(`✓ generated notes asset map → ${notesAssetMapPath}`)

// ── 5d. embed agent prompts ──────────────────────────────────────────────────
const agentPromptsDir = path.join(dir, "src", "agent", "prompts")
const agentPromptsMap: Record<string, string> = {}

async function collectPromptFiles(base: string, current = base) {
  for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await collectPromptFiles(base, full)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const rel = path.relative(base, full).replaceAll("\\", "/")
    agentPromptsMap[rel] = await Bun.file(full).text()
  }
}

await collectPromptFiles(agentPromptsDir)

const agentPromptsGenContent = `/**
 * Generated agent prompt map — do not edit
 * Generated at build time by script/build.ts
 * Run \`bun run build\` to regenerate.
 */
export const EMBEDDED_AGENT_PROMPTS: Record<string, string> = {
${Object.entries(agentPromptsMap)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join("\n")}
}
`

const agentPromptsGenPath = path.join(dir, "src", "agent", "agent-prompts.gen.ts")
await Bun.file(agentPromptsGenPath).write(agentPromptsGenContent)
console.log(`✓ generated agent prompts map → ${agentPromptsGenPath} (${Object.keys(agentPromptsMap).length} files)`)

// ── 6. compile ───────────────────────────────────────────────────────────────
const plugin = createSolidTransformPlugin()

await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp"],
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: `bun-${os === "win32" ? "windows" : os}-${arch}` as any,
    outfile: outBin,
    execArgv: [`--user-agent=opencode/${pkg.version}`, "--use-system-ca", "--"],
    windows: {},
  },
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  define: {
    OPENCODE_VERSION: `'${pkg.version}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'stable'`,
    OPENCODE_LIBC: os === "linux" ? `'glibc'` : "",
    OPENCODE_WATCHER_PACKAGE: `'${watcherPackage}'`,
  },
})

console.log(`✓ compiled → ${outBin}`)

// ── 7. smoke test ────────────────────────────────────────────────────────────
console.log(`Running smoke test: ${outBin} --version`)
try {
  const versionOutput = await $`${outBin} --version`.text()
  console.log(`✓ smoke test: ${versionOutput.trim()}`)
} catch (e) {
  console.error(`✗ smoke test failed:`, e)
  process.exit(1)
}

// ── 8. cleanup leftover bunfs tui dir + write package metadata ───────────────
await $`find ./${outDir}/bin/tui -user $(id -u) -delete 2>/dev/null || true`.nothrow()
await $`rm -rf ./${outDir}/bin/tui`.nothrow()
await Bun.file(`${outDir}/package.json`).write(
  JSON.stringify({ name, version: pkg.version, os: [os], cpu: [arch] }, null, 2),
)

console.log(`\n✓ build complete → ${outBin}`)
console.log(`  symlink to expose globally:  ln -sf $(pwd)/${outBin} ~/.local/bin/opencode`)
