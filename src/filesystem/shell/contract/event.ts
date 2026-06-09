import z from "zod"

export const ShellContractEventTypeSchema = z.enum([
  "shell.selected",
  "shell.fallback.used",
  "shell.process.killed",
])

export type ShellContractEventType = z.infer<typeof ShellContractEventTypeSchema>

export const ShellContractEventSchema = z.object({
  type: ShellContractEventTypeSchema,
  shell: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type ShellContractEvent = z.infer<typeof ShellContractEventSchema>
