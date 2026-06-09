import os from "node:os"
import path from "node:path"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
// vault-as-sole-filesystem (Stage 0.5, I0.2): cwd sidecar lives under
// <vault>/tmp/ so all opencode persistence shares one mount.
import { vaultPath } from "@/notes/root"

export interface CwdTracker {
  readonly sidecarPath: string
  readAfterRun(): Promise<string>
  recoverFromMissing(attempted: string): Promise<string>
  renderShellEpilogue(): string
  dispose(): Promise<void>
}

export interface CreateCwdTrackerOptions {
  readonly tmpDir: string
  readonly sessionId: string
  readonly normalizeNFC: boolean
}

export class CwdTrackerError extends Error {
  readonly _tag = "CwdTrackerError"
  readonly kind: "io" | "sidecar-missing" | "invariant"
  override readonly cause?: unknown

  constructor(kind: "io" | "sidecar-missing" | "invariant", message: string, cause?: unknown) {
    super(message)
    this.kind = kind
    this.cause = cause
  }
}

class CwdTrackerImpl implements CwdTracker {
  constructor(
    readonly sidecarPath: string,
    readonly normalizeNFC: boolean,
  ) {}

  async readAfterRun(): Promise<string> {
    try {
      const raw = (await readFile(this.sidecarPath, "utf8")).trim()
      if (!raw) throw new CwdTrackerError("sidecar-missing", `Empty cwd sidecar ${this.sidecarPath}`)
      return this.normalizeNFC ? raw.normalize("NFC") : raw
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return this.recoverFromMissing(process.cwd())
      }
      if (error instanceof CwdTrackerError) throw error
      throw new CwdTrackerError("io", `Failed read cwd sidecar ${this.sidecarPath}`, error)
    }
  }

  async recoverFromMissing(attempted: string): Promise<string> {
    let cur = attempted
    while (true) {
      try {
        await access(cur)
        return this.normalizeNFC ? cur.normalize("NFC") : cur
      } catch {
        const parent = path.dirname(cur)
        if (parent === cur) {
          return this.normalizeNFC ? process.cwd().normalize("NFC") : process.cwd()
        }
        cur = parent
      }
    }
  }

  renderShellEpilogue(): string {
    return `; __opencode_pwd=$(pwd -P 2>/dev/null); printf '%s' "$__opencode_pwd" >| ${JSON.stringify(this.sidecarPath)}`
  }

  async dispose(): Promise<void> {
    await rm(this.sidecarPath, { force: true })
  }
}

export function createCwdTracker(opts: CreateCwdTrackerOptions): CwdTracker {
  // vault-as-sole-filesystem (I0.2): default to vault tmp; explicit tmpDir
  // overrides preserved for tests that need an isolated dir.
  const dir = opts.tmpDir || vaultPath.tmpRoot()
  const sidecarPath = path.join(dir, `opencode-cwd-${opts.sessionId}.txt`)
  return new CwdTrackerImpl(sidecarPath, opts.normalizeNFC)
}

export async function createCwdTrackerInTemp(sessionId: string): Promise<CwdTracker> {
  // vault-as-sole-filesystem (I0.2): mkdtemp under <vault>/tmp/ instead of /tmp/.
  const dir = await mkdtemp(path.join(vaultPath.tmpRoot(), "opencode-cwd-"))
  return createCwdTracker({ tmpDir: dir, sessionId, normalizeNFC: process.platform === "darwin" })
}
