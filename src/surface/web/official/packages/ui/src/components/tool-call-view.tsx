export type UIToolCallStatus =
  | "idle"
  | "queued"
  | "pending"
  | "running"
  | "streaming"
  | "success"
  | "completed"
  | "error"
  | "denied"
  | "retrying"
  | "cancelled"

export type UIToolCallError = {
  message: string
  code?: string
  retryable?: boolean
  denied?: boolean
}

export type UIToolCallViewModel = {
  id?: string
  title: string
  kind: string
  status: UIToolCallStatus
  startedAt?: number
  endedAt?: number
  durationMs?: number
  retryCount?: number
  progress?: {
    current?: number
    total?: number
    label?: string
  }
  error?: UIToolCallError
  summary?: string
}

export function isActiveToolStatus(status: UIToolCallStatus | string | undefined) {
  return (
    status === "queued" ||
    status === "pending" ||
    status === "running" ||
    status === "streaming" ||
    status === "retrying"
  )
}
