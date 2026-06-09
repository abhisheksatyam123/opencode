import { Database, and, eq } from "@/storage/db"
import { TodoAgentTable } from "@/process/session/session.sql"
import { SessionID } from "@/process/session/schema"
import z from "zod"

export namespace TodoAgentRegistry {
  export const AgentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  export type Source = { type: "new" | "reuse" | "fork"; fromAgent?: string; fromSessionID?: SessionID }
  export type Info = {
    rootSessionID: SessionID
    name: string
    sessionID: SessionID
    providerID: string
    modelID: string
    source?: Source
    timeCreated: number
    timeUpdated: number
  }

  export class DuplicateAgentError extends Error {
    constructor(
      public readonly rootSessionID: SessionID,
      public readonly agentName: string,
    ) {
      super(`Todo agent "${agentName}" already exists for root session ${rootSessionID}`)
    }
  }

  export class AgentNotFoundError extends Error {
    constructor(
      public readonly rootSessionID: SessionID,
      public readonly agentName: string,
    ) {
      super(`Todo agent "${agentName}" not found for root session ${rootSessionID}`)
    }
  }

  const MODEL_PROVIDERS = new Set(["qgenie", "qpilot"])

  export function normalizeProviderModel(input: { providerID: string; modelID: string }) {
    let providerID = input.providerID.trim()
    let modelID = input.modelID.trim()
    for (let i = 0; i < 4; i++) {
      const slash = modelID.indexOf("/")
      if (slash <= 0) break
      const embeddedProvider = modelID.slice(0, slash)
      if (!MODEL_PROVIDERS.has(embeddedProvider)) break
      providerID = embeddedProvider
      modelID = modelID.slice(slash + 1)
    }
    while (modelID.startsWith(`${providerID}/`)) {
      modelID = modelID.slice(providerID.length + 1)
    }
    return { providerID, modelID }
  }

  function rowToInfo(row: typeof TodoAgentTable.$inferSelect): Info {
    const model = normalizeProviderModel({ providerID: row.provider_id, modelID: row.model_id })
    return {
      rootSessionID: row.root_session_id,
      name: row.name,
      sessionID: row.session_id,
      providerID: model.providerID,
      modelID: model.modelID,
      source: row.source ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }
  }

  export function get(input: { rootSessionID: SessionID; name: string }): Info | undefined {
    const name = AgentName.parse(input.name)
    const row = Database.use((db) =>
      db
        .select()
        .from(TodoAgentTable)
        .where(and(eq(TodoAgentTable.root_session_id, input.rootSessionID), eq(TodoAgentTable.name, name)))
        .get(),
    )
    return row ? rowToInfo(row) : undefined
  }

  export function list(rootSessionID: SessionID): Info[] {
    return Database.use((db) =>
      db.select().from(TodoAgentTable).where(eq(TodoAgentTable.root_session_id, rootSessionID)).all(),
    ).map(rowToInfo)
  }

  export function create(input: {
    rootSessionID: SessionID
    name: string
    sessionID: SessionID
    providerID: string
    modelID: string
    source?: Source
  }): Info {
    const name = AgentName.parse(input.name)
    const now = Date.now()
    const model = normalizeProviderModel(input)
    try {
      Database.use((db) =>
        db
          .insert(TodoAgentTable)
          .values({
            root_session_id: input.rootSessionID,
            name,
            session_id: input.sessionID,
            provider_id: model.providerID,
            model_id: model.modelID,
            source: input.source,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    } catch (err) {
      if (String(err).includes("UNIQUE") || String(err).includes("constraint"))
        throw new DuplicateAgentError(input.rootSessionID, name)
      throw err
    }
    return get({ rootSessionID: input.rootSessionID, name })!
  }

  export function upsert(input: {
    rootSessionID: SessionID
    name: string
    sessionID: SessionID
    providerID: string
    modelID: string
    source?: Source
  }): Info {
    const name = AgentName.parse(input.name)
    const now = Date.now()
    const model = normalizeProviderModel(input)
    Database.use((db) =>
      db
        .insert(TodoAgentTable)
        .values({
          root_session_id: input.rootSessionID,
          name,
          session_id: input.sessionID,
          provider_id: model.providerID,
          model_id: model.modelID,
          source: input.source,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [TodoAgentTable.root_session_id, TodoAgentTable.name],
          set: {
            session_id: input.sessionID,
            provider_id: model.providerID,
            model_id: model.modelID,
            source: input.source,
            time_updated: now,
          },
        })
        .run(),
    )
    return get({ rootSessionID: input.rootSessionID, name })!
  }

  export function remove(input: { rootSessionID: SessionID; name: string }): void {
    const name = AgentName.parse(input.name)
    Database.use((db) =>
      db
        .delete(TodoAgentTable)
        .where(and(eq(TodoAgentTable.root_session_id, input.rootSessionID), eq(TodoAgentTable.name, name)))
        .run(),
    )
  }
}
