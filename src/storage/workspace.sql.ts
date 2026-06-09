import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/storage/project.sql"
import type { Brand } from "effect/Brand"

type ProjectID = string & Brand<"ProjectID">
type WorkspaceID = string & Brand<"WorkspaceID">

export const WorkspaceTable = sqliteTable("workspace", {
  id: text().$type<WorkspaceID>().primaryKey(),
  type: text().notNull(),
  branch: text(),
  name: text(),
  directory: text(),
  extra: text({ mode: "json" }),
  project_id: text()
    .$type<ProjectID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
})
