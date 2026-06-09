import { TuiConfig } from "@/config/tui"
import { createSimpleContext } from "@/surface/cli/cmd/tui/context/helper"

export const { use: useTuiConfig, provider: TuiConfigProvider } = createSimpleContext({
  name: "TuiConfig",
  init: (props: { config: TuiConfig.Info }) => {
    return props.config
  },
})
