import z from "zod"
import { SyncContractVersionSchema } from "@/surface/sync/contract/version"

export const SyncConformanceSchema = z.object({
  module: z.literal("sync"),
  contractVersion: SyncContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type SyncConformance = z.infer<typeof SyncConformanceSchema>

export const SyncConformance: SyncConformance = {
  module: "sync",
  contractVersion: "1.0.0",
  guarantees: ["event-id-brand", "event-envelope-shape", "projector-compatibility"],
}
