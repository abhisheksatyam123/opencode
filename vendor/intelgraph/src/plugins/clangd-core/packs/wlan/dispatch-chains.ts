/**
 * packs/wlan/dispatch-chains.ts — WLAN firmware dispatch chain templates.
 *
 * Encodes the Qualcomm/Atheros WLAN firmware's runtime dispatch paths
 * for callback invocation via CMNOS IRQ, WMI event handlers, offload
 * manager data/notification flows, and thread signal routing.
 */

import type { DispatchChainTemplate } from "../types.js"

const wlanDispatchChains: readonly DispatchChainTemplate[] = [
  // ── CMNOS IRQ dispatch ──────────────────────────────────────────────────
  {
    registrationApi: "cmnos_irq_register_dynamic",
    chain: ["hardware_irq", "cmnos_irq_dispatch", "irq_route_handler", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "CMNOS hardware interrupt IRQ %KEY%",
  },
  {
    registrationApi: "cmnos_irq_register",
    chain: ["hardware_irq", "cmnos_irq_dispatch", "irq_route_handler", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "CMNOS hardware interrupt IRQ %KEY%",
  },

  // ── WMI event handler dispatch ──────────────────────────────────────────
  {
    registrationApi: "wmi_unified_register_event_handler",
    chain: ["wmi_rx_event", "wmi_event_dispatch", "event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WMI event %KEY% received from firmware",
  },

  // ── WMI command dispatch table ──────────────────────────────────────────
  {
    registrationApi: "WMI_RegisterDispatchTable",
    chain: ["wmi_rx_cmd", "wmi_dispatch_cmd", "cmd_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WMI command %KEY% dispatched from host",
  },

  // ── Offload manager data path ───────────────────────────────────────────
  {
    registrationApi: "offldmgr_register_data_offload",
    chain: ["data_rx_path", "_offldmgr_enhanced_data_handler", "data_offload_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Offload manager data path dispatch",
  },

  // ── Offload manager notification ────────────────────────────────────────
  {
    registrationApi: "offldmgr_register_wow_notify",
    chain: ["wow_notif_dispatch", "_offldmgr_wow_notify_event", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WoW notification event for offload",
  },

  // ── Thread signal routing ───────────────────────────────────────────────
  {
    registrationApi: "wlan_thread_register_signal_handler",
    chain: ["wlan_thread_signal_route", "signal_handler_table", "%CALLBACK%"],
    triggerKind: "signal",
    triggerDescription: "WLAN thread signal routed to handler",
  },
  {
    registrationApi: "wlan_thread_register_signal",
    chain: ["wlan_thread_signal_route", "signal_handler_table", "%CALLBACK%"],
    triggerKind: "signal",
    triggerDescription: "WLAN thread signal %KEY% routed to handler",
  },
  {
    registrationApi: "wlan_thread_register_signal_wrapper",
    chain: ["wlan_thread_signal_route_wmac_tx", "signal_dispatch_table", "%CALLBACK%"],
    triggerKind: "signal",
    triggerDescription: "WLAN thread signal wrapper %KEY% routed to handler",
  },

  // ── HIF callback dispatch ───────────────────────────────────────────────
  {
    registrationApi: "HIF_register_callback",
    chain: ["HIF_layer", "HIF_deliver_recv", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "HIF layer delivers packet to %CALLBACK%",
  },

  // ── HTC service dispatch ────────────────────────────────────────────────
  {
    registrationApi: "HTC_RegisterService",
    chain: ["HTC_layer", "HTC_ServiceDispatch", "service_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "HTC service endpoint dispatches to %CALLBACK%",
  },

  // ── Offload manager non-data (mgmt frame) ──────────────────────────────
  {
    registrationApi: "offldmgr_register_nondata_offload",
    chain: ["data_rx_path", "_offldmgr_non_data_msg_hdlr", "nondata_offload_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Offload manager non-data path dispatch for %KEY%",
  },

  // ── ISR/DSR hardware attach ─────────────────────────────────────────────
  {
    registrationApi: "A_ISR_ATTACH",
    chain: ["hardware_irq", "A_ISR_DISPATCH", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Hardware ISR interrupt %KEY% dispatched",
  },
  {
    registrationApi: "A_DSR_ATTACH",
    chain: ["hardware_irq", "A_DSR_DISPATCH", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Hardware DSR interrupt %KEY% dispatched",
  },

  // ── Roam handoff notify ─────────────────────────────────────────────────
  {
    registrationApi: "wlan_roam_register_handoff_notify",
    chain: ["roam_event_dispatch", "roam_handoff_notify_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Roam handoff notification for module %KEY%",
  },

  // ── WoW notification ────────────────────────────────────────────────────
  {
    registrationApi: "wlan_wow_register_notif_handler",
    chain: ["wow_event_dispatch", "wow_notify_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WoW notification event dispatched",
  },

  // ── Scan scheduler event ────────────────────────────────────────────────
  {
    registrationApi: "wlan_scan_sch_register_event_handler",
    chain: ["scan_event_dispatch", "scan_event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Scan scheduler event for module %KEY% dispatched",
  },

  // ── WAL event handlers ──────────────────────────────────────────────────
  {
    registrationApi: "wal_vdev_register_event_handler",
    chain: ["wal_vdev_event_dispatch", "vdev_event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WAL vdev event dispatched to %CALLBACK%",
  },
  {
    registrationApi: "wal_phy_dev_register_event_handler",
    chain: ["wal_pdev_event_dispatch", "pdev_event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WAL pdev event dispatched to %CALLBACK%",
  },
  {
    registrationApi: "wal_peer_register_event_handler",
    chain: ["wal_peer_event_dispatch", "peer_event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WAL peer event dispatched to %CALLBACK%",
  },

  // ── Platform thread signal dispatch ────────────────────────────────────
  {
    registrationApi: "platform_thread_register_signals",
    chain: ["platform_thread_dispatch", "signal_handler_table", "%CALLBACK%"],
    triggerKind: "signal",
    triggerDescription: "Platform thread signal dispatched to %CALLBACK%",
  },

  // ── Offload interface data indication ──────────────────────────────────
  {
    registrationApi: "offloadif_install_data_ind_handler",
    chain: ["data_rx_path", "offloadif_data_ind_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Offload interface data indication dispatched to %CALLBACK%",
  },
]

export default wlanDispatchChains
