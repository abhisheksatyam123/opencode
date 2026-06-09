import z from "zod"

export const MRPCriterion = z.object({
  status: z.enum(["pass", "partial", "fail", "not-applicable"]),
  summary: z.string(),
  evidence_paths: z.array(z.string()), // file paths to test logs, static analysis output, etc.
  notes: z.string().optional(),
})

export const MRPArtifact = z.object({
  id: z.string(), // mrp-<slug>-<timestamp>
  version: z.literal("1.0"),
  task_path: z.string(), // vault-relative source task path
  task_slug: z.string(), // task slug
  produced_at: z.string(), // ISO 8601
  briefing_script_hash: z.string(),
  criteria: z.object({
    functional_completeness: MRPCriterion,
    sound_verification: MRPCriterion,
    se_hygiene: MRPCriterion,
    rationale: MRPCriterion,
    auditability: MRPCriterion,
  }),
  // Progressive disclosure — top-level summary for quick scan
  summary: z.string(),
})

export type MRPCriterion = z.infer<typeof MRPCriterion>
export type MRPArtifact = z.infer<typeof MRPArtifact>
