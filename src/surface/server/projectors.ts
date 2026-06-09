import z from "zod"
import sessionProjectors from "@/process/session/projectors"
import { SyncEvent } from "@/surface/sync/wiring/layer"
import { Session } from "@/process/session"
import { SessionTable } from "@/process/session/session.sql"
import { Database, eq } from "@/storage/db"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}

initProjectors()
