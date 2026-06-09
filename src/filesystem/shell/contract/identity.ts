import z from "zod"
import { ShellContractVersionSchema } from "./version"

export const ShellModuleIdentitySchema = z.object({
  module: z.literal("shell"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: ShellContractVersionSchema,
})

export type ShellModuleIdentity = z.infer<typeof ShellModuleIdentitySchema>

export const ShellModuleIdentity: ShellModuleIdentity = {
  module: "shell",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
