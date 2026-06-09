import { Policy } from "@/permission/policy"

export type BudgetEntry = {
  taskNote?: string
  tokens_used: number
  tokens_soft: number | null
  tokens_hard: number | null
  updated_at?: string
}

export type BudgetState = {
  budgets: Record<string, BudgetEntry>
}

export const DEFAULT_TASK_BUDGET = { tokens_soft: 120_000, tokens_hard: 180_000 } as const

export function defaultTaskBudget(): { tokens_soft: number; tokens_hard: number } {
  const values = Policy.get("budget")?.values
  return {
    tokens_soft: typeof values?.token_soft_cap === "number" ? values.token_soft_cap : DEFAULT_TASK_BUDGET.tokens_soft,
    tokens_hard: typeof values?.token_cap === "number" ? values.token_cap : DEFAULT_TASK_BUDGET.tokens_hard,
  }
}

export function readBudget(state: BudgetState, taskNote: string): BudgetEntry {
  return ensureBudget(state, taskNote)
}

export function incrementBudget(state: BudgetState, taskNote: string, delta: number): BudgetEntry {
  const entry = ensureBudget(state, taskNote)
  entry.tokens_used += Math.max(0, delta)
  entry.updated_at = new Date().toISOString()
  return entry
}

export function ensureBudget(state: BudgetState, taskNote: string): BudgetEntry {
  const key = taskNote || "default"
  const defaults = defaultTaskBudget()
  state.budgets[key] ??= { taskNote: key, tokens_used: 0, ...defaults }
  return state.budgets[key]
}

export function setBudget(state: BudgetState, taskNote: string, budget: Partial<BudgetEntry>): BudgetEntry {
  const entry = ensureBudget(state, taskNote)
  Object.assign(entry, budget)
  return entry
}

export const DELEGATION_TTL_SECONDS = 1800

export function delegationTtlSeconds(): number {
  const value = Policy.get("scheduler")?.values?.dedup_window_ms
  return typeof value === "number" && value > 0 ? Math.floor(value / 1000) : DELEGATION_TTL_SECONDS
}
