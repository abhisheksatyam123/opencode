import type { MRPArtifact } from "@/foundation/mrp/mrp"
import type { NVersionSchedule, NVersionVariantTask } from "@/init/nversion/nversion-scheduler"

export type NVersionVariantResult = {
  task: NVersionVariantTask
  mrp?: MRPArtifact
}

export type NVersionComparisonVariant = {
  variant: number
  branch: string
  mrpPath: string
  score: number
  criteriaPassed: number
}

export type NVersionComparisonArtifact = {
  todoPath: string
  variants: NVersionComparisonVariant[]
  selectedVariant: number | null
  policy: "max-pass-then-evidence"
  artifactPath: string
}

export type SynthesizeNVersionInput = {
  schedule: NVersionSchedule
  results: NVersionVariantResult[]
}

function scoreMRP(mrp?: MRPArtifact): { criteriaPassed: number; score: number } {
  if (!mrp) return { criteriaPassed: 0, score: 0 }
  const criteria = Object.values(mrp.criteria)
  const criteriaPassed = criteria.filter((c) => c.status === "pass").length
  const evidenceCount = criteria.reduce((sum, c) => sum + c.evidence_paths.length, 0)
  return {
    criteriaPassed,
    score: criteriaPassed * 100 + evidenceCount,
  }
}

export function synthesizeNVersion(input: SynthesizeNVersionInput): NVersionComparisonArtifact {
  const variants: NVersionComparisonVariant[] = input.schedule.tasks.map((task) => {
    const result = input.results.find((r) => r.task.variant === task.variant)
    const scored = scoreMRP(result?.mrp)
    return {
      variant: task.variant,
      branch: task.branch,
      mrpPath: task.mrpPath,
      score: scored.score,
      criteriaPassed: scored.criteriaPassed,
    }
  })

  variants.sort((a, b) => b.score - a.score || a.variant - b.variant)
  const selectedVariant = variants.length > 0 ? variants[0]!.variant : null

  return {
    todoPath: input.schedule.todoPath,
    variants,
    selectedVariant,
    policy: "max-pass-then-evidence",
    artifactPath: input.schedule.comparisonArtifactPath,
  }
}
