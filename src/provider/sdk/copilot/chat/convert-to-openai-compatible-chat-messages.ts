import {
  type LanguageModelV3Prompt,
  type SharedV3ProviderOptions,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
import type { OpenAICompatibleChatPrompt } from "@/provider/sdk/copilot/chat/openai-compatible-api-types"
import { convertToBase64 } from "@ai-sdk/provider-utils"

function getOpenAIMetadata(message: { providerOptions?: SharedV3ProviderOptions }) {
  return message?.providerOptions?.copilot ?? {}
}

/**
 * Extract thoughtSignature from providerOptions.
 * Supports both root providerOptions and tool-result output.providerOptions.
 */
function extractThoughtSignatureFromProviderOptions(part: {
  providerOptions?: Record<string, any>
  output?: unknown
}): string | undefined {
  const candidates = [part.providerOptions, (part.output as any)?.providerOptions]
  const allowedKeys = new Set(["qpilot", "qgenie", "google"])

  for (const opts of candidates) {
    if (!opts) continue
    for (const k of Object.keys(opts)) {
      if (!allowedKeys.has(k)) continue
      const sig = opts[k]?.thoughtSignature ?? opts[k]?.thought_signature
      if (sig && typeof sig === "string" && sig.length > 0) return sig
    }
  }

  return undefined
}

export interface ConvertOptions {
  /**
   * When set, every assistant `tool-call` and `tool` (tool-result) message
   * that lacks a real `thought_signature` will be serialized with this value
   * under `extra_content.google.thought_signature`. Used to inject the
   * VertexAI/Gemini 3 skip sentinel ("skip_thought_signature_validator")
   * on the wire whenever the upstream session-layer fallback did not run
   * (e.g. tool-calls rewritten by `experimental_repairToolCall`, or replays
   * coming from sessions where the part metadata was sanitized away).
   *
   * NOTE: Caller MUST gate this to Gemini 3 / Vertex routes only — passing
   * a value here on non-Gemini routes injects unwanted `extra_content` and
   * violates the documented blast-radius contract.
   */
  defaultThoughtSignature?: string
}

export function convertToOpenAICompatibleChatMessages(
  prompt: LanguageModelV3Prompt,
  options: ConvertOptions = {},
): OpenAICompatibleChatPrompt {
  const messages: OpenAICompatibleChatPrompt = []
  const fallbackSignature = options.defaultThoughtSignature
  for (const { role, content, ...message } of prompt) {
    const metadata = getOpenAIMetadata({ ...message })
    switch (role) {
      case "system": {
        messages.push({
          role: "system",
          content: content,
          ...metadata,
        })
        break
      }

      case "user": {
        if (content.length === 1 && content[0].type === "text") {
          messages.push({
            role: "user",
            content: content[0].text,
            ...getOpenAIMetadata(content[0]),
          })
          break
        }

        messages.push({
          role: "user",
          content: content.map((part) => {
            const partMetadata = getOpenAIMetadata(part)
            switch (part.type) {
              case "text": {
                return { type: "text", text: part.text, ...partMetadata }
              }
              case "file": {
                if (part.mediaType.startsWith("image/")) {
                  const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType

                  return {
                    type: "image_url",
                    image_url: {
                      url:
                        part.data instanceof URL
                          ? part.data.toString()
                          : `data:${mediaType};base64,${convertToBase64(part.data)}`,
                    },
                    ...partMetadata,
                  }
                } else {
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
          ...metadata,
        })

        break
      }

      case "assistant": {
        let text = ""
        let reasoningText: string | undefined
        let reasoningOpaque: string | undefined
        const toolCalls: Array<{
          id: string
          type: "function"
          function: { name: string; arguments: string }
        }> = []

        for (const part of content) {
          const partMetadata = getOpenAIMetadata(part)
          // Check for reasoningOpaque on any part (may be attached to text/tool-call)
          const partOpaque = (part.providerOptions as { copilot?: { reasoningOpaque?: string } })?.copilot
            ?.reasoningOpaque
          if (partOpaque && !reasoningOpaque) {
            reasoningOpaque = partOpaque
          }

          switch (part.type) {
            case "text": {
              text += part.text
              break
            }
            case "reasoning": {
              if (part.text) reasoningText = part.text
              break
            }
            case "tool-call": {
              const thoughtSignature = extractThoughtSignatureFromProviderOptions(part) ?? fallbackSignature
              toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
                ...partMetadata,
                ...(thoughtSignature ? { extra_content: { google: { thought_signature: thoughtSignature } } } : {}),
              })
              break
            }
          }
        }

        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_text: reasoningOpaque ? reasoningText : undefined,
          reasoning_opaque: reasoningOpaque,
          ...metadata,
        })

        break
      }

      case "tool": {
        for (const toolResponse of content) {
          if (toolResponse.type === "tool-approval-response") {
            continue
          }
          const output = toolResponse.output

          let contentValue: string
          switch (output.type) {
            case "text":
            case "error-text":
              contentValue = output.value
              break
            case "execution-denied":
              contentValue = output.reason ?? "Tool execution denied."
              break
            case "content":
            case "json":
            case "error-json":
              contentValue = JSON.stringify(output.value)
              break
          }

          const toolResponseMetadata = getOpenAIMetadata(toolResponse)
          const toolThoughtSignature = extractThoughtSignatureFromProviderOptions(toolResponse) ?? fallbackSignature
          messages.push({
            role: "tool",
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
            ...toolResponseMetadata,
            ...(toolThoughtSignature ? { extra_content: { google: { thought_signature: toolThoughtSignature } } } : {}),
          })
        }
        break
      }

      default: {
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  return messages
}
