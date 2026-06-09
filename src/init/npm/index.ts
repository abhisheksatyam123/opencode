import semver from "semver"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { vaultPath } from "@/foundation/notes-root"
import { Log } from "@/foundation/util/log"
import path from "path"
import { readdir, rm } from "fs/promises"
import { Filesystem } from "@/foundation/util/filesystem"
import { Flock } from "@/foundation/util/flock"
// gap-runtime-1: Runtime.isBun() centralizes the `typeof Bun !== "undefined"`
// check that's needed to pick the right import.meta.resolve overload.
import { Runtime } from "@/foundation/util/runtime"
// gap-abort-followup-3: bound the npm registry fetch with a 10s timeout.
import { abortAfter } from "@/foundation/util/abort"
import { Arborist } from "@npmcli/arborist"

export namespace Npm {
  const log = Log.create({ service: "npm" })
  const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

  export const InstallFailedError = NamedError.create(
    "NpmInstallFailedError",
    z.object({
      pkg: z.string(),
    }),
  )

  export function sanitize(pkg: string) {
    if (!illegal) return pkg
    return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
  }

  function directory(pkg: string) {
    return path.join(vaultPath.cache("global"), "packages", sanitize(pkg))
  }

  function resolveEntryPoint(name: string, dir: string) {
    let entrypoint: string | undefined
    try {
      entrypoint = Runtime.isBun() ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
    } catch {}
    const result = {
      directory: dir,
      entrypoint,
    }
    return result
  }

  export async function outdated(pkg: string, cachedVersion: string): Promise<boolean> {
    // gap-abort-followup-3: bound the npm registry fetch with a 10s
    // timeout. Without this, a slow registry could hang plugin install
    // / version-check loops forever. The catch path falls through to
    // the cached version (same shape as a 5xx response).
    const aborter = abortAfter(10_000)
    const response = await fetch(`https://registry.npmjs.org/${pkg}`, { signal: aborter.signal })
      .catch((err) => {
        log.warn("Failed to fetch from registry, using cached", {
          pkg,
          cachedVersion,
          error: err?.name === "AbortError" ? "timeout (10s)" : (err?.message ?? String(err)),
        })
        return undefined
      })
      .finally(() => aborter.clearTimeout())
    if (!response || !response.ok) {
      if (response && !response.ok) {
        log.warn("Failed to resolve latest version, using cached", { pkg, cachedVersion })
      }
      return false
    }

    const data = (await response.json()) as { "dist-tags"?: { latest?: string } }
    const latestVersion = data?.["dist-tags"]?.latest
    if (!latestVersion) {
      log.warn("No latest version found, using cached", { pkg, cachedVersion })
      return false
    }

    const range = /[\s^~*xX<>|=]/.test(cachedVersion)
    if (range) return !semver.satisfies(latestVersion, cachedVersion)

    return semver.lt(cachedVersion, latestVersion)
  }

  export async function add(pkg: string) {
    const dir = directory(pkg)
    await using _ = await Flock.acquire(`npm-install:${Filesystem.resolve(dir)}`)
    log.info("installing package", {
      pkg,
    })

    const arborist = new Arborist({
      path: dir,
      binLinks: true,
      progress: false,
      savePrefix: "",
      ignoreScripts: true,
    })
    const tree = await arborist.loadVirtual().catch(() => {})
    if (tree) {
      const first = tree.edgesOut.values().next().value?.to
      if (first) {
        return resolveEntryPoint(first.name, first.path)
      }
    }

    const result = await arborist
      .reify({
        add: [pkg],
        save: true,
        saveType: "prod",
      })
      .catch((cause) => {
        throw new InstallFailedError(
          { pkg },
          {
            cause,
          },
        )
      })

    const first = result.edgesOut.values().next().value?.to
    if (!first) throw new InstallFailedError({ pkg })
    return resolveEntryPoint(first.name, first.path)
  }

  export async function install(dir: string) {
    await using _ = await Flock.acquire(`npm-install:${dir}`)
    log.info("checking dependencies", { dir })

    const reify = async () => {
      const arb = new Arborist({
        path: dir,
        binLinks: true,
        progress: false,
        savePrefix: "",
        ignoreScripts: true,
      })
      await arb.reify().catch(() => {})
    }

    if (!(await Filesystem.exists(path.join(dir, "node_modules")))) {
      log.info("node_modules missing, reifying")
      await reify()
      return
    }

    const pkg = await Filesystem.readJson(path.join(dir, "package.json")).catch(() => ({}))
    const lock = await Filesystem.readJson(path.join(dir, "package-lock.json")).catch(() => ({}))

    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ])

    const root = lock.packages?.[""] || {}
    const locked = new Set([
      ...Object.keys(root.dependencies || {}),
      ...Object.keys(root.devDependencies || {}),
      ...Object.keys(root.peerDependencies || {}),
      ...Object.keys(root.optionalDependencies || {}),
    ])

    for (const name of declared) {
      if (!locked.has(name)) {
        log.info("dependency not in lock file, reifying", { name })
        await reify()
        return
      }
    }

    log.info("dependencies in sync")
  }

  export async function which(pkg: string) {
    const dir = directory(pkg)
    const binDir = path.join(dir, "node_modules", ".bin")

    const pick = async () => {
      const files = await readdir(binDir).catch(() => [])
      if (files.length === 0) return undefined
      if (files.length === 1) return files[0]
      // Multiple binaries — resolve from package.json bin field like npx does
      const pkgJson = await Filesystem.readJson<{ bin?: string | Record<string, string> }>(
        path.join(dir, "node_modules", pkg, "package.json"),
      ).catch(() => undefined)
      if (pkgJson?.bin) {
        const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
        const bin = pkgJson.bin
        if (typeof bin === "string") return unscoped
        const keys = Object.keys(bin)
        if (keys.length === 1) return keys[0]
        return bin[unscoped] ? unscoped : keys[0]
      }
      return files[0]
    }

    const bin = await pick()
    if (bin) return path.join(binDir, bin)

    await rm(path.join(dir, "package-lock.json"), { force: true })
    await add(pkg)
    const resolved = await pick()
    if (!resolved) return
    return path.join(binDir, resolved)
  }
}
