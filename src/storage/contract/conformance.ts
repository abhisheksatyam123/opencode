import z from "zod"
import { StorageContractVersionSchema } from "@/storage/contract/version"

export const StorageConformanceSchema = z.object({
  module: z.literal("storage"),
  contractVersion: StorageContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type StorageConformance = z.infer<typeof StorageConformanceSchema>

export const StorageConformance: StorageConformance = {
  module: "storage",
  contractVersion: "1.0.0",
  guarantees: ["typed-key-schema", "json-persistence", "not-found-error-shape", "effect-tag-stability"],
}
