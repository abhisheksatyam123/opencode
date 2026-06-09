#!/usr/bin/env bun

import os from "os"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../src/config/project/instance"
import { opBootstrap } from "../src/tool/notes/ops-write"
import { opAudit, opList } from "../src/tool/notes/ops-read"

const root = path.join(os.tmpdir(), `opencode-notes-ci-${Date.now()}`)
process.env.OPENCODE_NOTES_ROOT = root

await fs.mkdir(root, { recursive: true })

await Instance.provide({
  directory: process.cwd(),
  fn: async () => {
    const boot = await opBootstrap(false)
    const audit = await opAudit("all", undefined)
    const list = await opList("all", [])

    console.log(boot)
    console.log(audit)
    console.log(list)

    if (!audit.startsWith("Audit passed")) {
      throw new Error("notes audit drift detected")
    }
    if (!list.includes("moc/project-home")) {
      throw new Error("notes bootstrap drift detected: missing moc/project-home")
    }
  },
})

process.exit(0)
