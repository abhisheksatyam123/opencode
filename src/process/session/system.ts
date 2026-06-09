import { Instance } from "@/config/project/instance"
import { notesRoot } from "@/notes/root"

import type { Provider } from "@/provider/provider"

export namespace SystemPrompt {
  // ── Phase 1e — memoization caches ──────────────────────────────────────────
  //
  // SystemPrompt.environmentStable is called on every loop step but its inputs
  // change rarely (model swap, project root, platform). Per-process module-level
  // caching turns an O(steps) cost into an O(distinct-keys) cost — typically
  // 1 entry per session.
  //
  // ── Action 2: cache-stable system prompt prefix ───────────────────────────
  //
  // The environment block USED to inline `Today's date: ${new Date().toDateString()}`
  // directly into the prompt body, AND its cache key included the date. That
  // meant:
  //   1. The system prompt body changed at midnight even if nothing else moved
  //   2. The Phase 1e memoization invalidated at midnight too
  //   3. The Anthropic / OpenAI prefix-hash cache invalidated at midnight (the
  //      remote upstream sees a new prefix and pays full input rate again)
  //
  // For users running long sessions across day boundaries (or just having
  // opencode open in the background), this was a 5-10x cost penalty at every
  // midnight rollover.
  //
  // Fix: split environment into TWO parts:
  //   - environmentStable() — workdir/worktree/platform/git, NO date.
  //     Cached on (providerID, api.id, directory, worktree, platform).
  //     Stays byte-stable across days.
  //   - environmentVolatile() — just the date, returned as a separate string
  //     so the caller can place it AFTER the cache marker (or in a separate
  //     non-cached system message).
  //
  // The cache stores the resolved string promise so concurrent callers
  // de-duplicate the underlying work.
  const environmentCache = new Map<string, Promise<string[]>>()

  function envCacheKey(model: Provider.Model): string {
    // NO date component — environmentStable is byte-stable across days.
    return [model.providerID, model.api.id, Instance.directory, Instance.worktree, process.platform].join("|")
  }

  /**
   * Stable, cache-friendly portion of the environment block. NO date,
   * NO time, no other per-second-volatile inputs. Same byte string every
   * call as long as the working directory + worktree + platform + model
   * are unchanged. Memoized via `environmentCache`.
   *
   * This is the part that should land BEFORE the cache_control marker
   * (Anthropic) or contribute to the prompt_cache_key prefix (OpenAI).
   */
  export async function environmentStable(model: Provider.Model): Promise<string[]> {
    const key = envCacheKey(model)
    const hit = environmentCache.get(key)
    if (hit) return hit
    const promise = (async () => {
      const project = Instance.project
      return [
        [
          `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
          `Here is some useful information about the environment you are running in:`,
          `<env>`,
          `  Working directory: ${Instance.directory}`,
          `  Workspace root folder: ${Instance.worktree}`,
          `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
          `  Platform: ${process.platform}`,
          `  Notes vault root: ${notesRoot()}`,
          // NOTE: date is intentionally NOT inlined here. See environmentVolatile().
          `</env>`,
        ].join("\n"),
      ]
    })()
    environmentCache.set(key, promise)
    // On rejection, evict the cache entry so the next call retries — we only
    // want to memoize successful resolutions.
    promise.catch(() => environmentCache.delete(key))
    return promise
  }

  /**
   * Volatile portion of the environment block — just the current date.
   * Returns a single short string the caller can append AFTER the cached
   * prefix (or skip entirely if the model doesn't need date awareness).
   *
   * Pure function — no memoization. The cost of computing one date string
   * per request is negligible compared to the cache invalidation savings.
   */
  export function environmentVolatile(): string {
    return `<runtime>\n  Today's date: ${new Date().toDateString()}\n</runtime>`
  }
}
