/**
 * packs/linux/network.ts — Network subsystem registration APIs.
 *
 * Covers NAPI poll handlers, protocol handlers, and netfilter hooks.
 * The net_device_ops struct-field callbacks (.ndo_open, .ndo_start_xmit)
 * are handled by the generic struct-field classifier + dispatch chain
 * templates in dispatch-chains.ts.
 */

import type { CallPattern } from "../types.js"

const networkPatterns: readonly CallPattern[] = [
  // ── NAPI poll ───────────────────────────────────────────────────────────
  // netif_napi_add(dev, napi, poll) — poll function called in softirq
  {
    name: "netif_napi_add",
    registrationApi: "netif_napi_add",
    connectionKind: "event",
    keyArgIndex: 2,
    keyDescription: "NAPI poll function",
  },
  {
    name: "netif_napi_add_weight",
    registrationApi: "netif_napi_add_weight",
    connectionKind: "event",
    keyArgIndex: 2,
    keyDescription: "NAPI poll function (weighted)",
  },

  // ── Protocol handlers ───────────────────────────────────────────────────
  {
    name: "dev_add_pack",
    registrationApi: "dev_add_pack",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "packet_type struct with .func handler",
  },
  {
    name: "inet_add_protocol",
    registrationApi: "inet_add_protocol",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "net_protocol struct",
  },

  // ── Netfilter ───────────────────────────────────────────────────────────
  {
    name: "nf_register_net_hook",
    registrationApi: "nf_register_net_hook",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "nf_hook_ops struct",
  },
  {
    name: "nf_register_net_hooks",
    registrationApi: "nf_register_net_hooks",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "nf_hook_ops array",
  },
]

export default networkPatterns
