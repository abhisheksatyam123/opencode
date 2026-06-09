import z from "zod"
import { InitContractVersionSchema } from "@/init/contract/version"

export const InitConformanceSchema = z.object({
  module: z.literal("init"),
  contractVersion: InitContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type InitConformance = z.infer<typeof InitConformanceSchema>

export const InitConformance: InitConformance = {
  module: "init",
  contractVersion: "1.0.0",
  guarantees: ["boot-surface", "install-surface", "auth-surface"],
}
