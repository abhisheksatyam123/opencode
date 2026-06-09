/**
 * packs/linux/thread.ts — Linux kernel thread / deferred-work registration.
 *
 * Workqueue work_struct callbacks (registered via INIT_WORK) and timer
 * callbacks (timer_setup) currently look like struct-field assignments
 * to the generic classifier — they don't need a CallPattern entry.
 * Only the kthread family is listed here because those use a function-arg
 * registration call.
 */

import type { CallPattern } from "../types.js"

const threadPatterns: readonly CallPattern[] = [
  {
    name: "kthread_run",
    registrationApi: "kthread_run",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "kthread function",
  },
  {
    name: "kthread_create",
    registrationApi: "kthread_create",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "kthread function",
  },
  {
    name: "kthread_create_on_node",
    registrationApi: "kthread_create_on_node",
    connectionKind: "event",
    keyArgIndex: 0,
    keyDescription: "kthread function",
  },
]

export default threadPatterns
