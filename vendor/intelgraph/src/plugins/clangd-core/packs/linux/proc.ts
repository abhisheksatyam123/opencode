/**
 * packs/linux/proc.ts — Linux /proc, /sys, and debugfs file registration.
 *
 * The proc/debugfs APIs accept a `struct file_operations *` (or seq_operations)
 * pointer that defines the read/write callbacks. The struct-of-callbacks
 * itself is classified by the generic struct-field fallback; this file
 * just covers the call-site patterns that pass them in.
 */

import type { CallPattern } from "../types.js"

const procPatterns: readonly CallPattern[] = [
  {
    name: "proc_create",
    registrationApi: "proc_create",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "/proc filename",
  },
  {
    name: "proc_create_data",
    registrationApi: "proc_create_data",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "/proc filename",
  },
  {
    name: "proc_create_single",
    registrationApi: "proc_create_single",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "/proc filename",
  },
  {
    name: "proc_create_seq",
    registrationApi: "proc_create_seq",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "/proc filename",
  },
  {
    name: "proc_create_single_data",
    registrationApi: "proc_create_single_data",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "/proc filename (single-open with data)",
  },
  {
    name: "debugfs_create_file",
    registrationApi: "debugfs_create_file",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "debugfs filename",
  },
  {
    name: "debugfs_create_file_unsafe",
    registrationApi: "debugfs_create_file_unsafe",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "debugfs filename",
  },
]

export default procPatterns
