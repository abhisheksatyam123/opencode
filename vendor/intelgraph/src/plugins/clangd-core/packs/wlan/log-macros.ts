/**
 * packs/wlan/log-macros.ts — Qualcomm/Atheros WLAN firmware log macros.
 *
 * Derived from the existing WLAN fixture ground truth — e.g.
 * test/fixtures/c/wlan/api/wlan_bpf_notify_handler.json shows:
 *   { level: "DEBUG", template: "BPF: notify handler invoked event=%d",
 *     subsystem: "BPF", derivation: "c_parser" }
 *
 * The WLAN firmware uses these primary log macros:
 *   - AR_DEBUG_PRINTF(mask, (fmt, args...)) — Atheros debug print
 *   - WLAN_LOGD(fmt, ...) / WLAN_LOGI / WLAN_LOGW / WLAN_LOGE — level-based
 *   - QDF_TRACE(module, level, fmt, ...) — Qualcomm debug framework
 */

import type { LogMacroDef } from "../types.js"

const wlanLogMacros: readonly LogMacroDef[] = [
  // ── AR_DEBUG_PRINTF — mask-based, format at arg 1 (arg 0 = mask) ────────
  { name: "AR_DEBUG_PRINTF", level: "DEBUG", formatArgIndex: 1, subsystem: "ATH" },

  // ── WLAN_LOG* family — level-based, format at arg 0 ─────────────────────
  { name: "WLAN_LOGD", level: "DEBUG", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "WLAN_LOGI", level: "INFO", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "WLAN_LOGW", level: "WARN", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "WLAN_LOGE", level: "ERROR", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "WLAN_LOGV", level: "VERBOSE", formatArgIndex: 0, subsystem: "WLAN" },

  // ── QDF_TRACE — Qualcomm debug framework, format at arg 2 ──────────────
  // QDF_TRACE(QDF_MODULE_ID, QDF_TRACE_LEVEL, fmt, ...)
  { name: "QDF_TRACE", level: "DEBUG", formatArgIndex: 2, subsystem: "QDF" },
  { name: "qdf_print", level: "INFO", formatArgIndex: 0, subsystem: "QDF" },
  { name: "qdf_err", level: "ERROR", formatArgIndex: 0, subsystem: "QDF" },

  // ── WMI debug ───────────────────────────────────────────────────────────
  { name: "WMI_LOGD", level: "DEBUG", formatArgIndex: 0, subsystem: "WMI" },
  { name: "WMI_LOGE", level: "ERROR", formatArgIndex: 0, subsystem: "WMI" },

  // ── HIF (host interface) ────────────────────────────────────────────────
  { name: "HIF_TRACE", level: "TRACE", formatArgIndex: 0, subsystem: "HIF" },
  { name: "HIF_ERROR", level: "ERROR", formatArgIndex: 0, subsystem: "HIF" },

  // ── A_PRINTF / A_TRACE — CMNOS low-level print (most common in WLAN FW) ──
  { name: "A_PRINTF", level: "DEBUG", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "A_TRACE", level: "TRACE", formatArgIndex: 0, subsystem: "WLAN" },
  { name: "A_PRINTF_DBG", level: "DEBUG", formatArgIndex: 0, subsystem: "WLAN" },
]

export default wlanLogMacros
