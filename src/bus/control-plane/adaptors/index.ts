import type { Adaptor } from "@/bus/control-plane/types"

const ADAPTORS: Record<string, () => Promise<Adaptor>> = {}

export function getAdaptor(type: string): Promise<Adaptor> {
  const factory = ADAPTORS[type]
  if (!factory) {
    throw new Error(`Unsupported workspace type: ${type}`)
  }
  return factory()
}

export function installAdaptor(type: string, adaptor: Adaptor) {
  // This is experimental: mostly used for testing right now, but we
  // will likely allow this in the future. Need to figure out the
  // TypeScript story

  // @ts-expect-error we force the builtin types right now, but we
  // will implement a way to extend the types for custom adaptors
  ADAPTORS[type] = () => adaptor
}
