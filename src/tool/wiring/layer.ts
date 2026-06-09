/**
 * Tool L3 — Effect Layer wiring
 *
 * ToolLayer is the single entry point for composition roots. It binds the
 * Tool contract to the default registry-backed adapter.
 */

export { ToolAdapterLayer as ToolLayer } from "@/tool/impl"
export { Tool } from "@/tool/contract/port"
