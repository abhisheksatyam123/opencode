/**
 * packs/linux/ipc.ts — Inter-thread communication, synchronization,
 * RCU callbacks, wait queues, completions, IPI, signals.
 *
 * These are all function-call style registrations where a callback
 * function is passed as an argument to a kernel API that will invoke
 * it asynchronously (from another context, after a delay, or from
 * another CPU).
 */

import type { CallPattern } from "../types.js"

const ipcPatterns: readonly CallPattern[] = [
  // ── RCU callbacks ───────────────────────────────────────────────────────
  // call_rcu(head, func) — func is called after grace period
  {
    name: "call_rcu",
    registrationApi: "call_rcu",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "rcu_head pointer",
  },
  {
    name: "call_rcu_hurry",
    registrationApi: "call_rcu_hurry",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "rcu_head pointer",
  },
  {
    name: "call_srcu",
    registrationApi: "call_srcu",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "srcu_struct pointer",
  },

  // ── IPI cross-CPU calls ─────────────────────────────────────────────────
  // smp_call_function(func, info, wait) — func called on all other CPUs
  {
    name: "smp_call_function",
    registrationApi: "smp_call_function",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "IPI function to run on other CPUs",
  },
  {
    name: "smp_call_function_single",
    registrationApi: "smp_call_function_single",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "IPI function to run on specific CPU",
  },
  {
    name: "smp_call_function_many",
    registrationApi: "smp_call_function_many",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "IPI function to run on CPU mask",
  },

  // ── Notifier chain registration ─────────────────────────────────────────
  {
    name: "blocking_notifier_chain_register",
    registrationApi: "blocking_notifier_chain_register",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "blocking notifier chain head",
  },
  {
    name: "atomic_notifier_chain_register",
    registrationApi: "atomic_notifier_chain_register",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "atomic notifier chain head",
  },
  {
    name: "raw_notifier_chain_register",
    registrationApi: "raw_notifier_chain_register",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "raw notifier chain head",
  },

  // ── Softirq ─────────────────────────────────────────────────────────────
  {
    name: "open_softirq",
    registrationApi: "open_softirq",
    connectionKind: "hw_interrupt",
    keyArgIndex: 0,
    keyDescription: "softirq number",
  },

  // ── CPU hotplug ─────────────────────────────────────────────────────────
  {
    name: "cpuhp_setup_state",
    registrationApi: "cpuhp_setup_state",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "cpuhp state",
  },
  {
    name: "cpuhp_setup_state_nocalls",
    registrationApi: "cpuhp_setup_state_nocalls",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "cpuhp state",
  },

  // ── Stop machine ────────────────────────────────────────────────────────
  {
    name: "stop_machine",
    registrationApi: "stop_machine",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "stop_machine function",
  },
]

export default ipcPatterns
