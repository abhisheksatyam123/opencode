/**
 * Dummy sentinel:
 *   When a proxy strips `extra_content` and the real signature never arrives,
 *   we inject "skip_thought_signature_validator" — the officially documented
 *   escape hatch that tells VertexAI to skip signature validation.
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

/**
 * Returns true for any model ID that requires Gemini thought_signature
 * validation on Vertex AI. This covers:
 *   - Gemini models that require thought signatures on any provider
 *   - Any Gemini model routed through Vertex
 *     because Vertex enforces thought_signature for all Gemini reasoning models
 *
 * Non-Gemini providers (openai, anthropic, etc.) always return false.
 */
export function isGemini3LikeId(id: string): boolean {
  const lower = id.toLowerCase()
  // Vertex-prefixed Gemini route
  if ((lower.startsWith("vertex::") || lower.startsWith("vertexai::")) && lower.includes("gemini")) return true
  // Bare Gemini route that requires thought signatures
  return lower.includes("gemini-3") && !lower.includes("gemini-2")
}
