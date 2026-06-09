import z from "zod"
import { CommandContractVersionSchema } from "./version"

export const CommandModuleIdentitySchema = z.object({
  module: z.literal("command"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: CommandContractVersionSchema,
})

export type CommandModuleIdentity = z.infer<typeof CommandModuleIdentitySchema>

export const CommandModuleIdentity: CommandModuleIdentity = {
  module: "command",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
