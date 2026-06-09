import type { Provider } from "@/provider/provider"
import { SKIP_THOUGHT_SIGNATURE, isGemini3LikeId } from "@/provider/support/gemini-thought-signature"

/**
 * Thought Signature Support for Gemini 3 Models
 *
 * Thought signatures are encrypted representations of the model's internal
 * thought process. Gemini 3 enforces strict validation: every reasoning and
 * tool-call block sent back to the model must carry a thought_signature,
 * otherwise the API returns 400.
 *
 * Wire format:
 *   - The native @ai-sdk/openai-compatible SDK send path reads the signature
 *     from `providerOptions.google.thoughtSignature` (hardcoded key).
 *   - On receive it stores the signature under `providerOptionsName`
 *     (e.g. "qgenie" for the qgenie proxy).
 *   - So we READ by iterating all keys (provider-agnostic) and WRITE under
 *     "google" so the native SDK forwards it as
 *     `extra_content.google.thought_signature`.
 *
 * Dummy sentinel:
 *   When a proxy strips `extra_content` and the real signature never arrives,
 *   we inject "skip_thought_signature_validator" — the officially documented
 *   escape hatch that tells VertexAI to skip signature validation.
 */

const THOUGHT_SIGNATURE_KEY = "google"

export { SKIP_THOUGHT_SIGNATURE, isGemini3LikeId }

export function isGemini3Model(model: Provider.Model): boolean {
  const id = model.api.id.toLowerCase()
  return isGemini3LikeId(id)
}

export function extractThoughtSignature(metadata: any): string | undefined {
  if (!metadata) return undefined
  for (const key of Object.keys(metadata)) {
    const sig = metadata[key]?.thoughtSignature
    if (sig && typeof sig === "string" && sig.length > 0) return sig
  }
  return undefined
}

export function createProviderOptions(
  thoughtSignature: string | undefined,
): { providerOptions: Record<string, Record<string, string>> } | Record<string, never> {
  if (!thoughtSignature) return {}
  return {
    providerOptions: {
      [THOUGHT_SIGNATURE_KEY]: { thoughtSignature },
    },
  }
}

/** Build the minimal providerMetadata that carries only the skip sentinel. */
export function skipThoughtSignatureMetadata(): Record<string, { thoughtSignature: string }> {
  return { [THOUGHT_SIGNATURE_KEY]: { thoughtSignature: SKIP_THOUGHT_SIGNATURE } }
}
