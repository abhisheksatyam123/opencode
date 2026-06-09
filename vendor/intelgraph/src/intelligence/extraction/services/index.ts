/**
 * services/index.ts — barrel re-exports for the four parsing services
 * exposed to plugin extractors via ctx.{lsp, treesitter, ripgrep, workspace}.
 */

export type {
  LspService,
  LspServiceLogger,
  LspCallResult,
  LspErrorClass,
} from "./lsp-service.js"
export { LspServiceImpl, classifyLspError } from "./lsp-service.js"

export type {
  TreeSitterService,
  FunctionCall,
  SupportedLanguage,
  TsNode,
  TsTree,
} from "./treesitter-service.js"
export { TreeSitterServiceImpl, getParser } from "./treesitter-service.js"
export {
  inferLanguageFromExtension,
  walkTree,
  findDescendant,
} from "./treesitter-registry.js"

export type {
  RipgrepService,
  RipgrepMatch,
  RipgrepSearchOptions,
  RipgrepServiceLogger,
} from "./ripgrep-service.js"
export { RipgrepServiceImpl, RipgrepUnavailable } from "./ripgrep-service.js"

export type {
  WorkspaceService,
  WalkFilesOptions,
  CompileCommandEntry,
} from "./workspace-service.js"
export { WorkspaceServiceImpl } from "./workspace-service.js"
