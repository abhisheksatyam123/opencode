import path from "path"
import { Global } from "@/filesystem/global"
import { Filesystem } from "@/foundation/util/filesystem"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"
import { appendFile, writeFile } from "fs/promises"
// gap-28-followup-3: NdjsonSafe.stringify escapes U+2028 / U+2029 so the
// .jsonl file survives external line-aware tooling (jq, grep -c '^', wc -l).
// JSON.stringify emits those chars raw per ECMA-404; consumers that treat
// them as line terminators (per ECMA-262) silently cut entries.
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import type { PromptInfo } from "@/surface/cli/cmd/tui/component/prompt/history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

const MAX_STASH_ENTRIES = 50

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const stashPath = path.join(Global.Path.state, "prompt-stash.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(stashPath).catch(() => "")
      // gap-28-followup-4: NdjsonSafe.parseLines centralizes the
      // split + filter + JSON.parse + skip-on-error boilerplate.
      const lines = NdjsonSafe.parseLines<StashEntry>(text).slice(-MAX_STASH_ENTRIES)

      setStore("entries", lines)

      // Rewrite file with only valid entries to self-heal corruption
      if (lines.length > 0) {
        const content = lines.map((line) => NdjsonSafe.stringify(line)).join("\n") + "\n"
        writeFile(stashPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      entries: [] as StashEntry[],
    })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) {
          const content = store.entries.map((line) => NdjsonSafe.stringify(line)).join("\n") + "\n"
          writeFile(stashPath, content).catch(() => {})
          return
        }

        appendFile(stashPath, NdjsonSafe.stringify(stash) + "\n").catch(() => {})
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(
          produce((draft) => {
            draft.entries.pop()
          }),
        )
        const content =
          store.entries.length > 0 ? store.entries.map((line) => NdjsonSafe.stringify(line)).join("\n") + "\n" : ""
        writeFile(stashPath, content).catch(() => {})
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(
          produce((draft) => {
            draft.entries.splice(index, 1)
          }),
        )
        const content =
          store.entries.length > 0 ? store.entries.map((line) => NdjsonSafe.stringify(line)).join("\n") + "\n" : ""
        writeFile(stashPath, content).catch(() => {})
      },
    }
  },
})
