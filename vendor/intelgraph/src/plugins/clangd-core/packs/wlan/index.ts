/**
 * packs/wlan/index.ts — Qualcomm/Atheros WLAN firmware pattern pack.
 *
 * Holds the registration patterns originally hardcoded in
 * src/tools/pattern-detector/registry.ts before the pack refactor.
 * Every entry here is specific to the WLAN/CMNOS firmware codebase
 * (the WLAN.CNG.* tree) and is unlikely to be useful for any other
 * C project.
 *
 * Auto-detection: the pack is gated on finding `cmnos`, `wmi`, or
 * `wlan` directory entries near the workspace root. This keeps WLAN
 * patterns from leaking into Linux / FreeBSD / general C projects.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { PatternPack } from "../types.js"
import wlanLogMacros from "./log-macros.js"
import wlanDispatchChains from "./dispatch-chains.js"
import wlanHWEntities from "./hw-entities.js"

const wlanPack: PatternPack = {
  name: "wlan",
  description:
    "Qualcomm/Atheros WLAN firmware patterns (CMNOS IRQ registration, WMI event handlers, WMI dispatch tables).",

  callPatterns: [
    // ── IRQ ────────────────────────────────────────────────────────────────
    // hover() on the callback arg returns CMNOS_THREAD_IRQ_ROUTE_CB_T (an
    // opaque typedef). The auto-classifier would need an extra definition()
    // call to confirm fn-ptr; the fast path avoids that round trip.
    {
      name: "irq_dynamic",
      registrationApi: "cmnos_irq_register_dynamic",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number constant",
    },
    {
      name: "irq_signal_register",
      registrationApi: "cmnos_irq_register",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number constant",
    },

    // ── WMI event handler ──────────────────────────────────────────────────
    {
      name: "wmi_event_handler",
      registrationApi: "wmi_unified_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 1,
      keyDescription: "WMI_EVT_ID constant",
    },

    // ── Offload manager data path ───────────────────────────────────────────
    // offldmgr_register_data_offload(type, offload_name, callback, ctx, notify, pkt_type)
    {
      name: "offldmgr_data_offload",
      registrationApi: "offldmgr_register_data_offload",
      connectionKind: "event",
      keyArgIndex: 1,
      keyDescription: "offload name (e.g. OFFLOAD_BPF, OFFLOAD_ARP)",
    },

    // ── Offload manager non-data (mgmt frame) ─────────────────────────────
    // offldmgr_register_nondata_offload(type, name, handler, ctx, frm_flags)
    {
      name: "offldmgr_nondata_offload",
      registrationApi: "offldmgr_register_nondata_offload",
      connectionKind: "event",
      keyArgIndex: 1,
      keyDescription: "offload name",
    },

    // ── Offload manager HTT path ───────────────────────────────────────────
    // offldmgr_register_htt_offload(type, name, evt_handler, ctx)
    {
      name: "offldmgr_htt_offload",
      registrationApi: "offldmgr_register_htt_offload",
      connectionKind: "event",
      keyArgIndex: 1,
      keyDescription: "offload name",
    },

    // ── Scan scheduler event handler ───────────────────────────────────────
    // wlan_scan_sch_register_event_handler(hndl, evhndlr, arg, module_id)
    {
      name: "scan_sch_event_handler",
      registrationApi: "wlan_scan_sch_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 3,
      keyDescription: "module_id",
    },

    // ── WoW notify handler ────────────────────────────────────────────────
    // wlan_wow_register_notif_handler(pdev, callback, ctx)
    {
      name: "wow_notif_handler",
      registrationApi: "wlan_wow_register_notif_handler",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "pdev handle",
    },

    // ── Vdev notification handler ─────────────────────────────────────────
    // wlan_vdev_register_notif_handler(vdev, callback, arg)
    {
      name: "vdev_notif_handler",
      registrationApi: "wlan_vdev_register_notif_handler",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "vdev handle",
    },

    // ── WAL vdev event handler ────────────────────────────────────────────
    // wal_vdev_register_event_handler(vdev, callback, ctx, flags)
    {
      name: "wal_vdev_event_handler",
      registrationApi: "wal_vdev_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 3,
      keyDescription: "event flags",
    },

    // ── WAL pdev event handler ────────────────────────────────────────────
    // wal_phy_dev_register_event_handler(pdev, callback, ctx, ...)
    {
      name: "wal_pdev_event_handler",
      registrationApi: "wal_phy_dev_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "pdev handle",
    },

    // ── WAL peer event handler ────────────────────────────────────────────
    // wal_peer_register_event_handler(peer, vdev, callback, ...)
    {
      name: "wal_peer_event_handler",
      registrationApi: "wal_peer_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "peer handle",
    },

    // ── Roam handoff notify ───────────────────────────────────────────────
    // wlan_roam_register_handoff_notify(module_id, notify_bitmap, thread_id, cb, cb_ctxt)
    {
      name: "roam_handoff_notify",
      registrationApi: "wlan_roam_register_handoff_notify",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "module_id",
    },

    // ── WLAN thread signal handler ────────────────────────────────────────
    // wlan_thread_register_signal(ctx, signal_id, handler, ctxt)
    {
      name: "thread_signal_handler",
      registrationApi: "wlan_thread_register_signal",
      connectionKind: "ring_signal",
      keyArgIndex: 1,
      keyDescription: "signal_id",
    },
    // wlan_thread_register_signal_wrapper(ctx, signal_id, handler, ctxt)
    // Inline wrapper around wlan_thread_register_signal; used in syssw_platform.
    {
      name: "thread_signal_handler_wrapper",
      registrationApi: "wlan_thread_register_signal_wrapper",
      connectionKind: "ring_signal",
      keyArgIndex: 1,
      keyDescription: "signal_id",
    },

    // ── ISR / DSR attach macros ───────────────────────────────────────────
    // A_ISR_ATTACH(inum, isr, arg)
    {
      name: "isr_attach",
      registrationApi: "A_ISR_ATTACH",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number",
    },
    // A_DSR_ATTACH(inum, handler, arg)
    {
      name: "dsr_attach",
      registrationApi: "A_DSR_ATTACH",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number",
    },

    // ── HIF callback registration ─────────────────────────────────────────
    // HIF_register_callback(hif_handle, &callbacks) — struct-field callbacks
    {
      name: "hif_callback",
      registrationApi: "HIF_register_callback",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "HIF handle",
    },

    // ── HTC service registration ──────────────────────────────────────────
    // HTC_RegisterService(ctx, &record) — WMI/HTT service endpoint callbacks
    {
      name: "htc_register_service",
      registrationApi: "HTC_RegisterService",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "HTC context",
    },

    // ── Offload interface data indication handler ──────────────────────────
    // offloadif_install_data_ind_handler(OFFLOADIF_DATA_IND_HANDLER *data_ind_handler)
    {
      name: "offloadif_data_ind_handler",
      registrationApi: "offloadif_install_data_ind_handler",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "data indication handler function pointer",
    },

    // ── HTT TX offload handle cfg ─────────────────────────────────────────
    // htt_tgt_tx_offload_handle_cfg(OFFLDMGR_FN(_offldmgr_send_htt_event_to_host))
    {
      name: "htt_tgt_tx_offload_handle_cfg",
      registrationApi: "htt_tgt_tx_offload_handle_cfg",
      connectionKind: "event",
      keyArgIndex: 0,
      keyDescription: "HTT TX offload handler",
    },
  ],

  initPatterns: [
    // ── WMI dispatch table ────────────────────────────────────────────────
    // Brace-delimited initializer list rather than a function call. The
    // auto-classifier does not handle struct initializers, so this entry
    // is the only path for classifying WMI command handlers.
    {
      name: "wmi_dispatch_entry",
      registrationApi: "WMI_RegisterDispatchTable",
      connectionKind: "api_call",
      markerArgIndex: 2,
      markerRegex: /\d+/,
      keyArgIndex: 1,
      keyDescription: "WMI CMDID constant",
    },
  ],

  logMacros: wlanLogMacros,
  dispatchChains: wlanDispatchChains,
  hwEntities: wlanHWEntities,

  appliesTo: (workspaceRoot: string) => {
    // Heuristic: a WLAN firmware checkout always has a `wlan/` or `wmi/`
    // top-level directory, or a `cmnos` subdirectory somewhere visible.
    const candidates = [
      join(workspaceRoot, "wlan"),
      join(workspaceRoot, "wmi"),
      join(workspaceRoot, "cmnos"),
      join(workspaceRoot, "wlan_proc"),
    ]
    return candidates.some((p) => existsSync(p))
  },
}

export default wlanPack
