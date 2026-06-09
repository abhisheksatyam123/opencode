import z from "zod"
import type { ZodType } from "zod"

export namespace BusEvent {
  export type Definition = ReturnType<typeof define>

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type,
      properties,
    }
    registry.set(type, result)
    return result
  }

  export function payloads() {
    return z
      .discriminatedUnion(
        "type",
        registry
          .entries()
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                properties: def.properties,
              })
              .meta({
                ref: "Event" + "@/bus" + def.type,
              })
          })
          .toArray() as any, // as any: z.union() requires a tuple type; .toArray() returns ZodTypeAny[] which TS can't narrow to the required 2+ element tuple
      )
      .meta({
        ref: "Event",
      })
  }
}
