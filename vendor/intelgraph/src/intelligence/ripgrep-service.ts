import { RipgrepServiceImpl } from "./extraction/services/ripgrep-service.js"
import type { RipgrepService } from "./extraction/services/ripgrep-service.js"

export type { RipgrepService } from "./extraction/services/ripgrep-service.js"

export function createRipgrepService(workspaceRoot: string): RipgrepService {
  return new RipgrepServiceImpl(workspaceRoot)
}
