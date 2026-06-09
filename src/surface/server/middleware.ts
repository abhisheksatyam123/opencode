import { Provider } from "@/provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { NotFoundError } from "@/storage/db"
import { Session } from "@/process/session"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Log } from "@/foundation/util/log"

/**
 * MiddlewareErrorMessage — the shape middleware expects from NamedError.data.
 * Explicit contract replaces implicit `data?.message` access.
 */
interface MiddlewareErrorMessage {
  message?: string
}

function isMiddlewareErrorMessage(data: unknown): data is MiddlewareErrorMessage {
  return typeof data === "object" && data !== null
}

function isBadRequestMessage(message: string) {
  return (
    /^(Command|Agent) not found:/.test(message) ||
    /^No todo file is attached to session /.test(message) ||
    /^Todo file does not exist:/.test(message) ||
    /^Invalid todo path:/.test(message) ||
    /^(?:Error: )?No todo task found in taskMarkdown$/.test(message) ||
    /^(?:Error: )?Invalid todo agent task:/.test(message) ||
    /^(?:Error: )?Todo agent "[^"]+" (?:not found|already exists) for root session /.test(message)
  )
}

/**
 * Normalized Web UI error shape per webui-runtime-api contract §Error model.
 * Used for auth/origin/host/workspace/permission safety failures.
 */
export class WebUIError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ContentfulStatusCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "WebUIError"
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    }
  }
}

export function errorHandler(log: Log.Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof WebUIError) {
      log.warn("webui.error", { code: err.code, status: err.status, path: c.req.path })
      return c.json(err.toJSON(), { status: err.status })
    }
    log.error("failed", {
      error: err,
    })
    if (err instanceof NamedError) {
      const obj = err.toObject()
      const unknownMessage =
        err.name === "UnknownError" && isMiddlewareErrorMessage(obj.data) && typeof obj.data.message === "string"
          ? obj.data.message
          : ""
      let status: ContentfulStatusCode
      if (err instanceof NotFoundError) status = 404
      else if (err instanceof Provider.ModelNotFoundError) status = 400
      else if (err.name === "ProviderAuthValidationFailed") status = 400
      else if (isBadRequestMessage(unknownMessage)) status = 400
      else if (err.name.startsWith("Worktree")) status = 400
      else status = 500
      return c.json(err.toObject(), { status })
    }
    const errorMessage = err instanceof Error ? err.message : ""
    if (isBadRequestMessage(errorMessage)) {
      return c.json(new NamedError.Unknown({ message: errorMessage }).toObject(), { status: 400 })
    }
    if (err instanceof Session.BusyError) {
      return c.json(new NamedError.Unknown({ message: err.message }).toObject(), { status: 400 })
    }
    if (err instanceof HTTPException) return err.getResponse()
    const message = err instanceof Error && err.stack ? err.stack : err.toString()
    return c.json(new NamedError.Unknown({ message }).toObject(), {
      status: 500,
    })
  }
}
