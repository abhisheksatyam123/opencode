import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/foundation/id"
import { withStatics } from "@/foundation/util/schema"

const ptyIdSchema = Schema.String.pipe(Schema.brand("PtyID"))

export type PtyID = typeof ptyIdSchema.Type

export const PtyID = ptyIdSchema.pipe(
  withStatics((schema: typeof ptyIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    ascending: (id?: string) => schema.makeUnsafe(Identifier.ascending("pty", id)),
    zod: Identifier.schema("pty").pipe(z.custom<PtyID>()),
  })),
)
