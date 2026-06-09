/**
 * packs/linux/fs.ts — Filesystem and block layer registration APIs.
 *
 * The actual struct-field callbacks (address_space_operations, inode_operations,
 * super_operations, block_device_operations) are detected by the generic
 * struct-field classifier in Phase 5b. This file only lists function-call
 * style registration APIs that pass callbacks as arguments.
 */

import type { CallPattern } from "../types.js"

const fsPatterns: readonly CallPattern[] = [
  // ── Filesystem type registration ────────────────────────────────────────
  {
    name: "register_filesystem",
    registrationApi: "register_filesystem",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "file_system_type struct",
  },

  // ── Block device ────────────────────────────────────────────────────────
  {
    name: "blk_mq_init_queue",
    registrationApi: "blk_mq_init_queue",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "blk_mq_tag_set with queue_fn",
  },

  // ── Bio completion callbacks ────────────────────────────────────────────
  {
    name: "bio_init",
    registrationApi: "bio_init",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "bio struct",
  },

  // ── Sysfs / kobject ─────────────────────────────────────────────────────
  {
    name: "sysfs_create_group",
    registrationApi: "sysfs_create_group",
    connectionKind: "interface_registration",
    keyArgIndex: 1,
    keyDescription: "attribute_group with show/store callbacks",
  },
  {
    name: "sysfs_create_file",
    registrationApi: "sysfs_create_file",
    connectionKind: "interface_registration",
    keyArgIndex: 1,
    keyDescription: "attribute with show/store callbacks",
  },
  {
    name: "device_create_file",
    registrationApi: "device_create_file",
    connectionKind: "interface_registration",
    keyArgIndex: 1,
    keyDescription: "device_attribute with show/store",
  },
]

export default fsPatterns
