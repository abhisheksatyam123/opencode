import z from "zod"
import { CardContractVersionSchema } from "@/tool/card/contract/version"

export const CardConformanceSchema = z.object({
  module: z.literal("tool/card"),
  contractVersion: CardContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type CardConformance = z.infer<typeof CardConformanceSchema>

export const CardConformance: CardConformance = {
  module: "tool/card",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
