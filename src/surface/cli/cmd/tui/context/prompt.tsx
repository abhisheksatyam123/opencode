import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"
import type { PromptRef } from "@/surface/cli/cmd/tui/component/prompt"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
