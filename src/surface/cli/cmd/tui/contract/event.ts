import z from "zod"

export const TuiContractEventTypeSchema = z.enum([
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "tui.session.select",
])

export type TuiContractEventType = z.infer<typeof TuiContractEventTypeSchema>

export const TuiContractEventSchema = z.object({
  type: TuiContractEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type TuiContractEvent = z.infer<typeof TuiContractEventSchema>
