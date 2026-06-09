import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/foundation/id"
import { withStatics } from "@/foundation/util/schema"
export * from "@/surface/sync/contract/version"
export * from "@/surface/sync/contract/identity"
export * from "@/surface/sync/contract/error"
export * from "@/surface/sync/contract/event"
export * from "@/surface/sync/contract/conformance"

export const EventID = Schema.String.pipe(
  Schema.brand("EventID"),
  withStatics((s) => ({
    make: (id: string) => s.makeUnsafe(id),
    ascending: (id?: string) => s.makeUnsafe(Identifier.ascending("event", id)),
    zod: Identifier.schema("event").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)
