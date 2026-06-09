/**
 * packs/linux/chrdev.ts — Linux character/block/network device registration.
 *
 * Each entry here registers a callback (or struct of callbacks) into a Linux
 * device subsystem so it becomes reachable from userspace via /dev/* or via
 * the corresponding kernel API.
 */

import type { CallPattern } from "../types.js"

const chrdevPatterns: readonly CallPattern[] = [
  {
    name: "chrdev_register",
    registrationApi: "register_chrdev",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "char-device major number",
  },
  {
    name: "chrdev_register_region",
    registrationApi: "register_chrdev_region",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "dev_t base",
  },
  {
    name: "blkdev_register",
    registrationApi: "register_blkdev",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "block-device major number",
  },
  {
    name: "netdev_register",
    registrationApi: "register_netdev",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "net_device pointer",
  },
  {
    name: "misc_register",
    registrationApi: "misc_register",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "miscdevice struct",
  },
]

export default chrdevPatterns
