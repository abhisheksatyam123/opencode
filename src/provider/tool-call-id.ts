import { Hash } from "@/foundation/util/hash"

export function compactToolCallId(id: string, maxLength: number, options?: { scrub?: (id: string) => string }): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return id
  const scrubbed = options?.scrub ? options.scrub(id) : id
  if (scrubbed.length <= maxLength) return scrubbed

  const digest = Hash.fast(id).slice(0, 16)
  if (maxLength <= digest.length + 1) return digest.slice(0, maxLength)
  return `${scrubbed.slice(0, maxLength - digest.length - 1)}_${digest}`
}
