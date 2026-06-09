import z from "zod"
export * from "@/tool/card/contract/version"
export * from "@/tool/card/contract/identity"
export * from "@/tool/card/contract/error"
export * from "@/tool/card/contract/event"
export * from "@/tool/card/contract/conformance"
import { CardContractVersion } from "@/tool/card/contract/version"

export const CardToolPortSchema = z.object({
  version: z.literal(CardContractVersion),
})

export type CardToolPortSchema = z.infer<typeof CardToolPortSchema>
