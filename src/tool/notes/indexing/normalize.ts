import * as fs from "fs/promises"
import { LSP } from "@/provider/lsp"
import { withTimeout } from "@/foundation/util/timeout"
import { SAVE_TIMEOUT, SAVE_RETRY } from "@/tool/notes/types"
import { log } from "@/tool/notes/logger"
import { hasLsp, touch } from "@/tool/notes/indexing/client"

// ---------------------------------------------------------------------------
// On-save normalization via textDocument/willSaveWaitUntil.
//
// markdown-oxide's notes/normalize subsystem completes frontmatter, regenerates
// `## Index`, and reflows headings. We invoke it via willSaveWaitUntil rather
// than reimplementing it in TS so the LSP stays the source of truth.
// ---------------------------------------------------------------------------

export function lineOffsets(text: string) {
  const out = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    out.push(i + 1)
  }
  return out
}

export function pointOffset(offsets: number[], text: string, line: number, character: number) {
  if (line < 0 || character < 0) return 0
  if (line >= offsets.length) return text.length
  const pos = offsets[line]! + character
  return Math.max(0, Math.min(pos, text.length))
}

export function applyLspEdits(text: string, edits: Awaited<ReturnType<typeof LSP.willSaveWaitUntil>>["edits"]) {
  const offsets = lineOffsets(text)
  const rows = edits
    .map((edit) => ({
      ...edit,
      start: pointOffset(offsets, text, edit.range.start.line, edit.range.start.character),
      end: pointOffset(offsets, text, edit.range.end.line, edit.range.end.character),
    }))
    .sort((a, b) => b.start - a.start)

  let out = text
  for (const row of rows) {
    const start = Math.min(row.start, row.end)
    const end = Math.max(row.start, row.end)
    out = out.slice(0, start) + row.newText + out.slice(end)
  }
  return out
}

export async function normalizeLsp(fp: string) {
  if (!(await hasLsp(fp))) return false
  await touch(fp)
  const tries = SAVE_RETRY + 1
  for (let step = 1; step <= tries; step++) {
    const at = Date.now()
    const row = await withTimeout(LSP.willSaveWaitUntil({ file: fp }), SAVE_TIMEOUT)
      .then((out) => ({ out }))
      .catch((err) => ({ err }))
    const ms = Date.now() - at
    if ("err" in row) {
      const err = row.err instanceof Error ? row.err.message : `${row.err}`
      log.warn("notes normalize failed", {
        file: fp,
        step,
        tries,
        timeout_ms: SAVE_TIMEOUT,
        duration_ms: ms,
        err,
      })
      if (step < tries) await new Promise((done) => setTimeout(done, 50 * step))
      continue
    }
    if (!row.out.ok) {
      log.warn("notes normalize empty response", {
        file: fp,
        step,
        tries,
        duration_ms: ms,
      })
      if (step < tries) await new Promise((done) => setTimeout(done, 50 * step))
      continue
    }
    if (row.out.edits.length === 0) {
      log.debug("notes normalize no edits", {
        file: fp,
        step,
        duration_ms: ms,
      })
      return true
    }
    const text = await fs.readFile(fp, "utf-8").catch(() => "")
    const next = applyLspEdits(text, row.out.edits)
    if (next === text) {
      log.debug("notes normalize unchanged", {
        file: fp,
        step,
        edits: row.out.edits.length,
        duration_ms: ms,
      })
      return true
    }
    await fs.writeFile(fp, next, "utf-8")
    await touch(fp)
    log.info("notes normalize applied", {
      file: fp,
      step,
      edits: row.out.edits.length,
      duration_ms: ms,
    })
    return true
  }
  return false
}
