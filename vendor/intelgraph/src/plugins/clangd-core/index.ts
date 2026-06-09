/**
 * clangd-core/index.ts — registration entry point.
 *
 * Re-exports the plugin so the static plugin registry in
 * src/plugins/index.ts can list it without reaching into extractor.ts.
 */

export { default as clangdCoreExtractor } from "./extractor.js"
