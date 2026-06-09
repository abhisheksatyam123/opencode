/**
 * packs/linux/driver.ts — Linux driver / bus registration APIs.
 *
 * Each call here passes a `struct *_driver` pointer whose probe()/remove()
 * fields hold the actual entry-point callbacks. The struct fields are
 * classified by the generic struct-field fallback; this file covers the
 * outer call-site that registers the driver into a bus.
 */

import type { CallPattern } from "../types.js"

const driverPatterns: readonly CallPattern[] = [
  {
    name: "platform_driver_register",
    registrationApi: "platform_driver_register",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "platform_driver pointer",
  },
  {
    name: "i2c_add_driver",
    registrationApi: "i2c_add_driver",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "i2c_driver pointer",
  },
  {
    name: "pci_register_driver",
    registrationApi: "pci_register_driver",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "pci_driver pointer",
  },
  {
    name: "spi_register_driver",
    registrationApi: "spi_register_driver",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "spi_driver pointer",
  },
  {
    name: "usb_register",
    registrationApi: "usb_register",
    connectionKind: "interface_registration",
    keyArgIndex: 0,
    keyDescription: "usb_driver pointer",
  },
]

export default driverPatterns
