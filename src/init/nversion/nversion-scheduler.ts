import path from "path"
import { vaultPath } from "@/notes/root"

export type NVersionVariantTask = {
  variant: number
  branch: string
  worktreePath: string
  specialist: string
  todoPath: string
  mrpPath: string
}

export type NVersionSchedule = {
  variants: number
  todoPath: string
  comparisonArtifactPath: string
  tasks: NVersionVariantTask[]
}

export type BuildNVersionScheduleInput = {
  leafText: string
  todoPath: string
  taskSlug: string
  projectSlug: string
  specialist?: string
  worktreeRoot?: string
}

const VARIANTS_RE = /\[impl[^\]]*\bvariants\s*=\s*(\d+)\b[^\]]*\]/i

function sanitizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function parseImplVariants(leafText: string): number | null {
  const m = leafText.match(VARIANTS_RE)
  if (!m?.[1]) return null
  const parsed = Number.parseInt(m[1], 10)
  if (!Number.isFinite(parsed) || parsed < 2) return null
  return parsed
}

export function buildNVersionSchedule(input: BuildNVersionScheduleInput): NVersionSchedule | null {
  const variants = parseImplVariants(input.leafText)
  if (!variants) return null

  const specialist = input.specialist ?? "worker"
  const slugToken = sanitizeToken(input.taskSlug)
  const pathToken = sanitizeToken(input.todoPath.replace(/\./g, "-"))
  const worktreeRoot = input.worktreeRoot ?? vaultPath.state("worktrees")
  const comparisonArtifactPath = `scratchpad/task/${input.projectSlug}/active/${input.taskSlug}/nversion/${pathToken}/comparison.json`

  const tasks: NVersionVariantTask[] = []
  for (let i = 1; i <= variants; i++) {
    const variantTag = `v${i}`
    const name = `${slugToken}-${pathToken}-${variantTag}`
    tasks.push({
      variant: i,
      branch: `worktree/${name}`,
      worktreePath: path.join(worktreeRoot, name).replace(/\\/g, "/"),
      specialist,
      todoPath: input.todoPath,
      mrpPath: `scratchpad/task/${input.projectSlug}/done/${input.taskSlug}/variants/${variantTag}/mrp.json`,
    })
  }

  return {
    variants,
    todoPath: input.todoPath,
    comparisonArtifactPath,
    tasks,
  }
}
