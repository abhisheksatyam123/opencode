/**
 * packs/wlan/hw-entities.ts — WLAN firmware HW/runtime entity definitions.
 *
 * Named hardware blocks and subsystems in the Qualcomm/Atheros WLAN
 * firmware stack. Each becomes a first-class node in the intelligence
 * graph with dispatches_to edges connecting to the callback functions.
 */

import type { HWEntityDef } from "../types.js"

const wlanHWEntities: readonly HWEntityDef[] = [
  {
    name: "CMNOS Firmware",
    kind: "hw_block",
    description: "CMNOS real-time firmware — handles IRQ dispatch, thread scheduling, and HW abstraction",
    matchesChainSteps: ["cmnos_irq_dispatch", "irq_route_handler"],
  },
  {
    name: "WMI Subsystem",
    kind: "message",
    description: "Wireless Module Interface — command/event messaging between host and firmware",
    matchesChainSteps: [
      "wmi_rx_event",
      "wmi_event_dispatch",
      "event_handler_table",
      "wmi_rx_cmd",
      "wmi_dispatch_cmd",
      "cmd_handler_table",
    ],
  },
  {
    name: "HIF Transport",
    kind: "hw_block",
    description: "Host Interface — PCIe/SDIO/USB transport layer between host and firmware",
    matchesChainSteps: ["hif_rx_completion", "hif_tx_completion"],
  },
  {
    name: "Offload Manager",
    kind: "dispatch_table",
    description: "Data offload manager — routes protocol-specific data to registered handlers",
    matchesChainSteps: [
      "data_rx_path",
      "_offldmgr_enhanced_data_handler",
      "data_offload_table",
      "wow_notif_dispatch",
      "_offldmgr_wow_notify_event",
    ],
  },
  {
    name: "WLAN Thread",
    kind: "thread",
    description: "Main WLAN processing thread — routes signals to registered handlers",
    matchesChainSteps: ["wlan_thread_signal_route", "signal_handler_table"],
  },
  {
    name: "WiFi Radio (WMAC)",
    kind: "hw_block",
    description: "Wireless MAC hardware — generates interrupts for TX/RX completion, beacon, scan events",
    matchesChainSteps: ["hardware_irq"],
  },
  {
    name: "Platform Thread",
    kind: "thread",
    description: "WLAN platform thread — dispatches registered signal handlers",
    matchesChainSteps: ["platform_thread_dispatch", "signal_handler_table"],
  },
]

export default wlanHWEntities
