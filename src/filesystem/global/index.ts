// vault-as-sole-filesystem migration (Stage 0.5, leaf I0.2)
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   vault-as-sole-filesystem.md
//
// `Global.Path.*` keys are preserved as a backwards-compat surface but every
// path now resolves under `<notesRoot()>` instead of XDG / homedir. The
// `xdg-basedir` import is gone — vault is the only mount.
//
// Migration map (legacy → vault):
//   data    → state/data        (auth.json, opencode.db marker, mcp-auth.json)
//   cache   → cache/global       (regenerable downloads keyed by "global")
//   config  → etc                (opencode.json, opencode.jsonc, themes/, …)
//   state   → state/global       (kv.json, model.json, prompt-history.jsonl, locks/)
//   log     → log/global         (rotated session logs, tool logs)
//   bin     → cache/bin          (rg, eslint binaries — regenerable, downloaded on demand)
//   home    → dirname(notesRoot) (DISPLAY ONLY — for `~`-substitution in TUI; never used as storage destination)
// -------------------------------------------------------------------------

import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "@/foundation/util/filesystem"
import { vaultPath, notesRoot } from "@/notes/root"

export namespace Global {
  function workspaceHome() {
    const env = process.env.OPENCODE_WORKSPACE_HOME?.trim()
    if (env) return env
    const root = path.dirname(notesRoot())
    if (root && root !== "." && root !== "/") return root
    return os.homedir()
  }

  export const Path = {
    /**
     * Workspace home (default: parent of notes root, e.g.
     * `/local/mnt/workspace` for `/local/mnt/workspace/notes`) —
     * DISPLAY ONLY. Used for `~`-substitution in TUI and Web UI path
     * rendering. MUST NOT be used as a storage destination. All
     * persistent paths route through `vaultPath.*`.
     * Test override via OPENCODE_TEST_HOME preserved for legacy tests.
     */
    get home() {
      return process.env.OPENCODE_TEST_HOME || workspaceHome()
    },

    /** Was `~/.local/share/opencode/`. Now `<vault>/state/data/`. */
    get data() {
      return vaultPath.state("data")
    },

    /** Was `~/.cache/opencode/bin/`. Now `<vault>/cache/bin/`. */
    get bin() {
      return vaultPath.cache("bin")
    },

    /** Was `~/.local/share/opencode/log/`. Now `<vault>/log/global/`. */
    get log() {
      return vaultPath.logDir("global")
    },

    /** Was `~/.cache/opencode/`. Now `<vault>/cache/global/`. */
    get cache() {
      return vaultPath.cache("global")
    },

    /** Was `~/.config/opencode/`. Now `<vault>/etc/`. */
    get config() {
      return vaultPath.etc()
    },

    /** Was `~/.local/state/opencode/`. Now `<vault>/state/global/`. */
    get state() {
      return vaultPath.state("global")
    },
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
  // Ensure the vault tmp subtree exists on first boot. Empty-vault
  // tolerance is invariant I3 of vault-as-sole-filesystem. Other class
  // subtrees are created on demand by their first writer.
  fs.mkdir(vaultPath.tmpRoot(), { recursive: true }),
])

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
