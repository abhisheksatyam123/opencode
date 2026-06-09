import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { PermissionID } from "@/permission/schema"
import { Permission } from "@/permission"
import z from "zod"
import { errors } from "@/surface/server/error"
import { lazy } from "@/foundation/util/lazy"
import { Log } from "@/foundation/util/log"

const log = Log.create({ service: "permission-route" })

/**
 * Tracks requests that have already been resolved (first-reply-wins).
 * Maps requestID → ISO timestamp of resolution.
 * Prevents TOCTOU race: atomic claim via synchronous Map.has/set before async reply.
 */
const resolvedRequests = new Map<string, string>()

export const PermissionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending permission requests",
        description: "Get all pending permission requests waiting for user approval.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permission requests",
            content: {
              "application/json": {
                schema: resolver(Permission.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const requests = await Permission.list()
        return c.json(requests)
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to permission request",
        description: "Approve or reject a pending permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission request resolved successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
          409: {
            description: "Permission request already resolved (first-reply-wins)",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    error: z.object({
                      code: z.literal("permission_already_resolved"),
                      message: z.string(),
                      details: z.object({
                        requestID: z.string(),
                        resolvedAt: z.string(),
                      }),
                    }),
                  }),
                ),
              },
            },
          },
          410: {
            description: "Permission request expired or not found",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    error: z.object({
                      code: z.literal("not_found"),
                      message: z.string(),
                      details: z.object({ requestID: z.string() }),
                    }),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          requestID: PermissionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          reply: Permission.Reply,
          message: z.string().optional(),
        }),
      ),
      async (c) => {
        const { requestID } = c.req.valid("param")
        const { reply, message } = c.req.valid("json")
        const requestIDStr = String(requestID)

        // Atomic first-reply-wins: claim synchronously before any await.
        // JS event loop is single-threaded: no await between has() and set()
        // means concurrent requests cannot both pass this gate.
        if (resolvedRequests.has(requestIDStr)) {
          const resolvedAt = resolvedRequests.get(requestIDStr)!
          return c.json(
            {
              error: {
                code: "permission_already_resolved" as const,
                message: "This permission request has already been resolved.",
                details: { requestID: requestIDStr, resolvedAt },
              },
            },
            409,
          )
        }

        // Claim atomically BEFORE any async work (fixes TOCTOU race).
        // Both concurrent requests arrive synchronously; the first sets the
        // map entry here; the second hits has()=true above on next microtask.
        const resolvedAt = new Date().toISOString()
        resolvedRequests.set(requestIDStr, resolvedAt)

        // Check the request is still pending (async — after claim)
        const pending = await Permission.list()
        const found = pending.find((r) => String(r.id) === requestIDStr)
        if (!found) {
          // Not pending — undo claim and return not_found
          resolvedRequests.delete(requestIDStr)
          return c.json(
            {
              error: {
                code: "not_found" as const,
                message: "Permission request not found or already expired.",
                details: { requestID: requestIDStr },
              },
            },
            404,
          )
        }

        const sessionID = String(found.sessionID)
        const permission = found.permission
        const source = "web"
        const timestamp = resolvedAt

        await Permission.reply({ requestID, reply, message })

        log.info("permission.replied", {
          requestID: requestIDStr,
          sessionID,
          permission,
          reply,
          timestamp,
          source,
        })

        return c.json(true)
      },
    ),
)
