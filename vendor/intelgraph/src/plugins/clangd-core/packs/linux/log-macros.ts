/**
 * packs/linux/log-macros.ts — Linux kernel log macro definitions.
 *
 * The kernel has ~20 distinct log macros across three families:
 *   1. printk family — `printk`, `pr_err`, `pr_warn`, `pr_info`, `pr_debug`, etc.
 *   2. dev_* family  — `dev_err`, `dev_warn`, `dev_info`, `dev_dbg`, etc.
 *      Format string is arg 1 (arg 0 is the `struct device *`).
 *   3. Assert macros — `WARN_ON`, `BUG_ON`, `WARN_ON_ONCE`, `BUG`.
 *      These don't have format strings; we store the condition text instead.
 *
 * Each entry tells the extractor:
 *   - Which function name to match in call_expressions
 *   - What log level it implies
 *   - Which argument position holds the format string (0-based)
 */

import type { LogMacroDef } from "../types.js"

const linuxLogMacros: readonly LogMacroDef[] = [
  // ── printk family (format string at arg 0) ──────────────────────────────
  { name: "printk",      level: "INFO",    formatArgIndex: 0 },
  { name: "pr_emerg",    level: "ERROR",   formatArgIndex: 0 },
  { name: "pr_alert",    level: "ERROR",   formatArgIndex: 0 },
  { name: "pr_crit",     level: "ERROR",   formatArgIndex: 0 },
  { name: "pr_err",      level: "ERROR",   formatArgIndex: 0 },
  { name: "pr_warn",     level: "WARN",    formatArgIndex: 0 },
  { name: "pr_notice",   level: "INFO",    formatArgIndex: 0 },
  { name: "pr_info",     level: "INFO",    formatArgIndex: 0 },
  { name: "pr_debug",    level: "DEBUG",   formatArgIndex: 0 },
  { name: "pr_cont",     level: "DEBUG",   formatArgIndex: 0 },
  { name: "pr_devel",    level: "DEBUG",   formatArgIndex: 0 },

  // ── dev_* family (format string at arg 1; arg 0 = struct device *) ──────
  { name: "dev_emerg",   level: "ERROR",   formatArgIndex: 1 },
  { name: "dev_alert",   level: "ERROR",   formatArgIndex: 1 },
  { name: "dev_crit",    level: "ERROR",   formatArgIndex: 1 },
  { name: "dev_err",     level: "ERROR",   formatArgIndex: 1 },
  { name: "dev_warn",    level: "WARN",    formatArgIndex: 1 },
  { name: "dev_notice",  level: "INFO",    formatArgIndex: 1 },
  { name: "dev_info",    level: "INFO",    formatArgIndex: 1 },
  { name: "dev_dbg",     level: "DEBUG",   formatArgIndex: 1 },

  // ── netdev_* family (format string at arg 1; arg 0 = struct net_device *)
  { name: "netdev_err",  level: "ERROR",   formatArgIndex: 1 },
  { name: "netdev_warn", level: "WARN",    formatArgIndex: 1 },
  { name: "netdev_info", level: "INFO",    formatArgIndex: 1 },
  { name: "netdev_dbg",  level: "DEBUG",   formatArgIndex: 1 },

  // ── Assert/warn macros (condition text as "format", no real format string)
  { name: "WARN",        level: "WARN",    formatArgIndex: 0 },
  { name: "WARN_ON",     level: "WARN",    formatArgIndex: 0 },
  { name: "WARN_ON_ONCE",level: "WARN",    formatArgIndex: 0 },
  { name: "WARN_ONCE",   level: "WARN",    formatArgIndex: 0 },
  { name: "BUG",         level: "ERROR",   formatArgIndex: 0 },
  { name: "BUG_ON",      level: "ERROR",   formatArgIndex: 0 },
]

export default linuxLogMacros
