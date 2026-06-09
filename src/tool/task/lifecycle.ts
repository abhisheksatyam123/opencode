import { Config } from "@/config/config"
import { iife } from "@/foundation/util/iife"
import { Log } from "@/foundation/util/log"
import { Bus } from "@/bus"
import { ProcessEvent } from "@/process/events"
import { ProcessRegistry } from "@/process/registry"
import { BackgroundTaskSlots } from "@/process/background-slots"
import { parseTaskModelOverride, type TaskConfigSnapshot } from "@/tool/task/model-selection"

const log = Log.create({ service: "tool.task.lifecycle" })

type LifecycleOp = "kill" | "pause" | "resume" | "resurrect" | "model"

// Task lifecycle ops are handled here; the old signal-tool surface delegates to this module.
// task_id (`ses_*` foreground or `bg_ses_*` background) is canonical;
// legacy `pid` UUID accepted with WARN. See specification/contract/task-tool.
export async function executeLifecycleOp(params: any, ctx: any) {
  const op = params.op as LifecycleOp
  const isSignalOp = op !== "model"
  let pid: string | undefined = params.pid
  if (params.task_id) {
    pid = ProcessRegistry.getPidByTaskId(params.task_id)
    if (!pid) {
      return {
        title: `task ${op}`,
        output: JSON.stringify({ ok: false, op, error: "task_id not found", task_id: params.task_id }),
        metadata: { status: "not_found" } as Record<string, unknown>,
      }
    }
  } else if (pid) {
    log.warn("task.lifecycle.legacy-pid-deprecated", { op, pid })
  } else {
    return {
      title: `task ${op}`,
      output: JSON.stringify({ ok: false, op, error: "missing task_id or pid" }),
      metadata: { status: "invalid_input" } as Record<string, unknown>,
    }
  }
  const current = ProcessRegistry.get(pid)
  if (!current) {
    return {
      title: `task ${op}`,
      output: JSON.stringify({ ok: false, op, error: "not_found", pid }),
      metadata: { status: "not_found" } as Record<string, unknown>,
    }
  }

  // AC7 — ownership check + permission gate.
  // current.session_id is the owner session (PCB field set at spawn).
  // ctx?.sessionID is the caller's session — undefined when invoked outside
  // an agent context (CLI/operator console); treat as non-owner in that case.
  const callerSessionId: string | undefined = ctx?.sessionID
  const isOwner = !!callerSessionId && callerSessionId === current.session_id
  if (!isOwner) {
    try {
      await ctx?.ask?.({
        permission: "task:lifecycle",
        patterns: [op],
        always: ["*"],
        metadata: {
          op,
          task_id: params.task_id ?? null,
          target_pid: pid,
          caller_session: callerSessionId ?? null,
        },
      })
    } catch {
      // Permission denied — emit Signalled(denied) audit event then return error.
      if (isSignalOp) await emitSignalled(pid, current, op, false, "permission_denied")
      return {
        title: `task ${op}`,
        output: JSON.stringify({
          ok: false,
          op,
          killed: false,
          error: `${op}: permission denied — caller is not owner of ${params.task_id ?? pid}`,
        }),
        metadata: { status: "permission_denied" } as Record<string, unknown>,
      }
    }
  }

  try {
    if (op === "model") {
      return await executeModelSwitch(params, pid, current)
    }

    const prior = current.state
    const next = await ProcessRegistry.signal(pid, op)
    // Emit Signalled(granted) audit event on every successful signal.
    await emitSignalled(pid, current, op, true, params.reason ?? "")
    if (op === "kill") {
      BackgroundTaskSlots.killSlotForSession(current.session_id)
    }
    if (op === "resurrect") {
      return {
        title: `task ${op}`,
        output: JSON.stringify({ ok: true, op, old_pid: pid, new_pid: next.pid, new_state: "running" }),
        metadata: { status: "ok" } as Record<string, unknown>,
      }
    }
    return {
      title: `task ${op}`,
      output: JSON.stringify({ ok: true, op, pid, prior_state: prior, new_state: next.state ?? "killed" }),
      metadata: { status: "ok" } as Record<string, unknown>,
    }
  } catch (err) {
    // Emit Signalled(denied/error) audit event on throw path.
    if (isSignalOp) await emitSignalled(pid, current, op, false, "internal_error")
    return {
      title: `task ${op}`,
      output: JSON.stringify({
        ok: false,
        op,
        pid,
        error: "internal_error",
        detail: err instanceof Error ? err.message : String(err),
      }),
      metadata: { status: "internal_error" } as Record<string, unknown>,
    }
  }
}

async function executeModelSwitch(params: any, pid: string, current: ProcessRegistry.PCB) {
  const op = "model"
  if (!params.model || typeof params.model !== "string") {
    return {
      title: "task model",
      output: JSON.stringify({ ok: false, op, error: "missing model" }),
      metadata: { status: "invalid_input" } as Record<string, unknown>,
    }
  }
  const cfg = Config.getSync?.() as TaskConfigSnapshot | undefined
  const parsed: ReturnType<typeof parseTaskModelOverride> | Error = iife(() => {
    try {
      return parseTaskModelOverride(params.model, cfg)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  })
  if (parsed instanceof Error) {
    return {
      title: "task model",
      output: JSON.stringify({ ok: false, op, error: parsed.message }),
      metadata: { status: "invalid_input" } as Record<string, unknown>,
    }
  }
  const model = `${parsed.providerID}/${parsed.modelID}`
  await Bus.publish(Bus.SubagentModelChange, { sessionID: current.session_id, model })
  return {
    title: "task model",
    output: JSON.stringify({
      ok: true,
      op,
      pid,
      task_id: params.task_id ?? null,
      model,
      state: current.state,
    }),
    metadata: { status: "ok" } as Record<string, unknown>,
  }
}

/** Emit process.signalled audit event. Never throws — fire-and-forget. */
async function emitSignalled(
  pid: string,
  current: { session_id: string; agent: string; task_path: string },
  op: string,
  granted: boolean,
  reason: string,
): Promise<void> {
  try {
    await Bus.publish(ProcessEvent.Signalled, {
      pid,
      key: { session_id: current.session_id, agent: current.agent, task_path: current.task_path },
      signal: op as "kill" | "pause" | "resume" | "resurrect",
      granted,
      reason: reason.slice(0, 280),
      caller_pid: null,
    })
  } catch {
    // audit emit failure must never propagate to caller
  }
}
