import HomeFooter from "@/surface/cli/cmd/tui/feature-plugins/home/footer"
import HomeTips from "@/surface/cli/cmd/tui/feature-plugins/home/tips"
import PluginManager from "@/surface/cli/cmd/tui/feature-plugins/system/plugins"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

export type InternalTuiPlugin = TuiPluginModule & {
  id: string
  tui: TuiPlugin
}

export const INTERNAL_TUI_PLUGINS: InternalTuiPlugin[] = [HomeFooter, HomeTips, PluginManager]
