import z from "zod"
import { SessionContractVersionSchema } from "@/process/session/contract/version"

export const SessionConformanceSchema = z.object({
  module: z.literal("session"),
  contractVersion: SessionContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type SessionConformance = z.infer<typeof SessionConformanceSchema>

export const SessionConformance: SessionConformance = {
  module: "session",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
