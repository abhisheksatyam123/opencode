/**
 * Canonical PermissionMode type for the config layer.
 * Single source of truth — all consumers import from here.
 */
export type PermissionMode = "default" | "plan" | "bypass"
export const PERMISSION_MODES = ["default", "plan", "bypass"] as const
