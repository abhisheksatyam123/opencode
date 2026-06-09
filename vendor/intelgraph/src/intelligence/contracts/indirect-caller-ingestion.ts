import type { IngestReport, RuntimeCallerRow } from "./common.js"

export interface RuntimeCallerInput {
  workspaceRoot: string
  parserArtifactsPath?: string
  records?: RuntimeCallerRow[]
}

export interface RuntimeCallerBatch {
  rows: RuntimeCallerRow[]
}

export interface LinkReport {
  linked: RuntimeCallerRow[]
  unresolved: RuntimeCallerRow[]
  warnings: string[]
}

export interface IIndirectCallerIngestion {
  parseRuntimeCallers(input: RuntimeCallerInput): Promise<RuntimeCallerBatch>
  linkToSymbols(snapshotId: number, batch: RuntimeCallerBatch): Promise<LinkReport>
  persistRuntimeChains(snapshotId: number, linked: LinkReport): Promise<IngestReport>
}
