import z from "zod"
import { SessionContractVersionSchema } from "@/process/session/contract/version"

export const SessionModuleIdentitySchema = z.object({
  module: z.literal("session"),
  layer: z.literal("domain"),
  tier: z.literal("L4"),
  contractVersion: SessionContractVersionSchema,
})

export type SessionModuleIdentity = z.infer<typeof SessionModuleIdentitySchema>

export const SessionModuleIdentity: SessionModuleIdentity = {
  module: "session",
  layer: "domain",
  tier: "L4",
  contractVersion: "1.0.0",
}
