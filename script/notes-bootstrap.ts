#!/usr/bin/env bun

import { Instance } from "../src/config/project/instance"
import { opBootstrap } from "../src/tool/notes/ops-write"
import { opAudit } from "../src/tool/notes/ops-read"

await Instance.provide({
  directory: process.cwd(),
  fn: async () => {
    const force = process.argv.includes("--force")
    const boot = await opBootstrap(force)
    const audit = await opAudit("all", undefined)

    console.log(boot)
    console.log(audit)

    if (!audit.startsWith("Audit passed")) {
      throw new Error("bootstrap completed but audit did not pass")
    }
  },
})

process.exit(0)
