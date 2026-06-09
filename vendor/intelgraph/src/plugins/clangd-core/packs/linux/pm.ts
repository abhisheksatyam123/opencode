/**
 * packs/linux/pm.ts — Power management and module lifecycle APIs.
 *
 * The dev_pm_ops struct-field callbacks (.suspend, .resume, etc.) are
 * detected by the generic struct-field classifier. This file covers
 * function-call registration and macro-based patterns.
 */

import type { CallPattern } from "../types.js"

const pmPatterns: readonly CallPattern[] = [
  // ── Module lifecycle ────────────────────────────────────────────────────
  // module_init(fn) and module_exit(fn) are macros that expand to
  // __initcall(fn) and __exitcall(fn). The tree-sitter parser sees them
  // as call_expressions with one argument.
  {
    name: "module_init",
    registrationApi: "module_init",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "module init function",
  },
  {
    name: "module_exit",
    registrationApi: "module_exit",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "module exit function",
  },
  {
    name: "late_initcall",
    registrationApi: "late_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "late init function",
  },
  {
    name: "subsys_initcall",
    registrationApi: "subsys_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "subsystem init function",
  },
  {
    name: "arch_initcall",
    registrationApi: "arch_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "architecture init function",
  },
  {
    name: "core_initcall",
    registrationApi: "core_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "core init function",
  },
  {
    name: "device_initcall",
    registrationApi: "device_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "device init function",
  },
  {
    name: "fs_initcall",
    registrationApi: "fs_initcall",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "filesystem init function",
  },
]

export default pmPatterns
