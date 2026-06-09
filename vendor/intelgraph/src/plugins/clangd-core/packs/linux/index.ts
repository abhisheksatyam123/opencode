/**
 * packs/linux/index.ts — Linux kernel pattern pack composition.
 *
 * The Linux pack is split across one file per registration category so it
 * stays browsable and easy to extend without rewriting one giant array:
 *
 *   chrdev.ts  — char/block/network/misc device registration
 *   irq.ts     — hardware interrupt request_irq family
 *   proc.ts    — proc / debugfs file creation
 *   driver.ts  — bus driver registration (platform, i2c, pci, spi, usb)
 *   thread.ts  — kthread spawn family
 *
 * Add a new category by:
 *   1. Creating <category>.ts that default-exports a `readonly CallPattern[]`
 *      (or `readonly InitPattern[]`).
 *   2. Importing it below and concatenating into `callPatterns` /
 *      `initPatterns`.
 *
 * The Linux pack intentionally has zero `initPatterns` — Linux's dominant
 * struct-of-fn-ptrs registration (file_operations, net_device_ops, irq_chip,
 * …) is handled by the GENERIC struct-field-callback classifier in
 * src/tools/pattern-detector/detector.ts, which uses tree-sitter to walk
 * the AST upward and recover the container variable + struct type with no
 * per-struct hardcoding. That generic path is the load-bearing piece of the
 * refactor; this pack's call-name patterns are only the fast-path overrides
 * for function-call registrations where the auto-classifier would otherwise
 * have to do an extra LSP round trip.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { PatternPack, CallPattern, InitPattern } from "../types.js"

import chrdevPatterns from "./chrdev.js"
import irqPatterns from "./irq.js"
import procPatterns from "./proc.js"
import driverPatterns from "./driver.js"
import threadPatterns from "./thread.js"
import ipcPatterns from "./ipc.js"
import networkPatterns from "./network.js"
import fsPatterns from "./fs.js"
import pmPatterns from "./pm.js"
import linuxLogMacros from "./log-macros.js"
import linuxDispatchChains from "./dispatch-chains.js"
import linuxHWEntities from "./hw-entities.js"

const callPatterns: readonly CallPattern[] = [
  ...chrdevPatterns,
  ...irqPatterns,
  ...procPatterns,
  ...driverPatterns,
  ...threadPatterns,
  ...ipcPatterns,
  ...networkPatterns,
  ...fsPatterns,
  ...pmPatterns,
]

const initPatterns: readonly InitPattern[] = []

const linuxPack: PatternPack = {
  name: "linux",
  description:
    "Linux kernel core registration patterns (chrdev/blkdev/netdev, IRQ, proc/debugfs, bus drivers, kthreads). " +
    "Struct-of-fn-ptrs registration (file_operations, net_device_ops, irq_chip, …) is handled by the generic " +
    "struct-field-callback classifier in pattern-detector/detector.ts.",

  callPatterns,
  initPatterns,
  logMacros: linuxLogMacros,
  dispatchChains: linuxDispatchChains,
  hwEntities: linuxHWEntities,

  appliesTo: (workspaceRoot: string) => {
    // Linux kernel checkout signals: top-level Kbuild + Documentation/.
    return (
      existsSync(join(workspaceRoot, "Kbuild")) &&
      existsSync(join(workspaceRoot, "Documentation"))
    )
  },
}

export default linuxPack
