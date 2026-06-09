/**
 * daemon/state.ts — Typed accessor functions for daemon state.
 *
 * All external reads of daemon state fields should go through these accessors
 * so the state schema is owned by the daemon module and no other module
 * reads raw state fields directly.
 */

import { readState, type DaemonState } from "./index.js"

export type { DaemonState } from "./index.js"

/** Returns the bridge TCP port, or undefined if daemon not running */
export function getDaemonPort(root: string): number | undefined {
  return readState(root)?.port
}

/** Returns the bridge PID, or undefined if daemon not running */
export function getDaemonBridgePid(root: string): number | undefined {
  return readState(root)?.bridgePid
}

/** Returns the HTTP daemon port, or undefined if not running */
export function getHttpDaemonPort(root: string): number | undefined {
  return readState(root)?.httpPort
}

/** Returns the HTTP daemon PID, or undefined if not running */
export function getHttpDaemonPid(root: string): number | undefined {
  return readState(root)?.httpPid
}

/** Returns the compile_commands preflight result, or undefined */
export function getPreflightResult(root: string): DaemonState["compileCommandsPreflight"] {
  return readState(root)?.compileCommandsPreflight
}

/** Returns true if the daemon state file exists and is valid */
export function hasDaemonState(root: string): boolean {
  return readState(root) !== null
}
