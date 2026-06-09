/**
 * RequestBus<M> — typed in-process command bus (1:1 request/response).
 *
 * Contract: project/specification/intelgraph-request-bus-contract.md
 *
 * Usage:
 *   const bus = new InProcessRequestBus<AppCommandMap>()
 *   bus.register("query", async (cmd, signal) => orchestrator.execute(cmd.payload, signal))
 *   const result = await bus.send({ kind: "query", payload: req })
 */

import type { Command, Disposable } from "./types.js"

export type { Command, Disposable }

/**
 * Typed in-process command bus.
 *
 * M is the command map — a record from command kind string to a Command type:
 *
 *   type AppCommandMap = {
 *     query: Command<"query", QueryRequest, NormalizedQueryResponse>
 *     ingest: Command<"ingest", IngestRequest, RunnerReport>
 *   }
 *
 * TypeScript infers the correct response type from the command kind:
 *   const result = await bus.send({ kind: "query", payload: req })
 *   // result: NormalizedQueryResponse
 */
export interface RequestBus<
  M extends Record<string, Command> = Record<string, Command>,
> {
  /**
   * Register a handler for command kind `K`.
   *
   * Invariants:
   * - Only one handler per kind. Throws `DuplicateHandlerError` if already registered.
   * - Returns a Disposable. `dispose()` deregisters the handler.
   * - Registration before any `send()` call is required; `send()` for an
   *   unregistered kind throws `UnknownCommandError`.
   */
  register<K extends keyof M & string>(
    kind: K,
    handler: (cmd: M[K], signal?: AbortSignal) => Promise<NonNullable<M[K]["__response"]>>,
  ): Disposable

  /**
   * Send command `cmd` and await the handler's response.
   *
   * Invariants:
   * - If `signal` is already aborted, throws `AbortError` before invoking handler.
   * - If handler throws, `send()` rejects with the same error.
   * - If `cmd.kind` is in-flight on the same async chain, throws `CircularCommandError`.
   * - After `dispose()`, throws `BusDisposedError`.
   */
  send<K extends keyof M & string>(
    cmd: M[K],
    signal?: AbortSignal,
  ): Promise<NonNullable<M[K]["__response"]>>

  /**
   * Dispose the bus. Clears all handler registrations.
   * Subsequent `send()` calls throw `BusDisposedError`.
   * In-flight handlers already executing complete normally.
   */
  dispose(): void
}
