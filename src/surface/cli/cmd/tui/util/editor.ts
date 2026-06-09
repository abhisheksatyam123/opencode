// gap-58-followup-1: switched from inline join(tmpdir(), Date.now() + ".md") to
// TempFile.random("opencode-editor") — avoids collision when two opens happen in
// the same millisecond; crypto.randomUUID under the hood guarantees uniqueness.
import { defer } from "@/foundation/util/defer"
import { rm } from "node:fs/promises"
import { CliRenderer } from "@opentui/core"
import { Filesystem } from "@/foundation/util/filesystem"
import { Process } from "@/foundation/util/process"
import { TempFile } from "@/foundation/util/tempfile"

export namespace Editor {
  export async function open(opts: { value: string; renderer: CliRenderer }): Promise<string | undefined> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"]
    if (!editor) return

    const filepath = TempFile.random("opencode-editor")
    await using _ = defer(async () => rm(filepath, { force: true }))

    await Filesystem.write(filepath, opts.value)
    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    try {
      const parts = editor.split(" ")
      const proc = Process.spawn([...parts, filepath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: process.platform === "win32",
      })
      await proc.exited
      const content = await Filesystem.readText(filepath)
      return content || undefined
    } finally {
      opts.renderer.currentRenderBuffer.clear()
      opts.renderer.resume()
      opts.renderer.requestRender()
    }
  }

  // Open an existing file directly in the editor (no temp copy).
  // The file watcher picks up changes after the editor exits.
  export async function openFile(opts: { filepath: string; renderer: CliRenderer; line?: number }): Promise<void> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"] || "nvim"
    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    try {
      const parts = editor.split(" ")
      const lineArg = opts.line && opts.line > 0 ? [`+${opts.line}`] : []
      const proc = Process.spawn([...parts, ...lineArg, opts.filepath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: process.platform === "win32",
      })
      await proc.exited
    } finally {
      opts.renderer.currentRenderBuffer.clear()
      opts.renderer.resume()
      opts.renderer.requestRender()
    }
  }
}
