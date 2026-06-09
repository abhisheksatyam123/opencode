import path from "path"
import { Global } from "@/filesystem/global"
import { Filesystem } from "@/foundation/util/filesystem"
// gap-28-followup-4: NdjsonSafe stringify escapes U+2028 / U+2029 so the
// .jsonl file survives external line-aware tooling. parseLines centralizes
// the read-side split + filter + JSON.parse + skip-on-error boilerplate.
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"
import { appendFile, writeFile } from "fs/promises"

function calculateFrecency(entry?: { frequency: number; lastOpen: number }): number {
  if (!entry) return 0
  const daysSince = (Date.now() - entry.lastOpen) / 86400000 // ms per day
  const weight = 1 / (1 + daysSince)
  return entry.frequency * weight
}

const MAX_FRECENCY_ENTRIES = 1000

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const frecencyPath = path.join(Global.Path.state, "frecency.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(frecencyPath).catch(() => "")
      // gap-28-followup-4: NdjsonSafe.parseLines centralizes the
      // split + filter + JSON.parse + skip-on-error boilerplate.
      const lines = NdjsonSafe.parseLines<{ path: string; frequency: number; lastOpen: number }>(text)

      const latest = lines.reduce(
        (acc, entry) => {
          acc[entry.path] = entry
          return acc
        },
        {} as Record<string, { path: string; frequency: number; lastOpen: number }>,
      )

      const sorted = Object.values(latest)
        .sort((a, b) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)

      setStore(
        "data",
        Object.fromEntries(
          sorted.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      )

      if (sorted.length > 0) {
        const content = sorted.map((entry) => NdjsonSafe.stringify(entry)).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      data: {} as Record<string, { frequency: number; lastOpen: number }>,
    })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(process.cwd(), filePath)
      const newEntry = {
        frequency: (store.data[absolutePath]?.frequency || 0) + 1,
        lastOpen: Date.now(),
      }
      setStore("data", absolutePath, newEntry)
      appendFile(frecencyPath, NdjsonSafe.stringify({ path: absolutePath, ...newEntry }) + "\n").catch(() => {})

      if (Object.keys(store.data).length > MAX_FRECENCY_ENTRIES) {
        const sorted = Object.entries(store.data)
          .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
          .slice(0, MAX_FRECENCY_ENTRIES)
        setStore("data", Object.fromEntries(sorted))
        const content = sorted.map(([path, entry]) => NdjsonSafe.stringify({ path, ...entry })).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(process.cwd(), filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
