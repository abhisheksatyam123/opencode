import { ServiceMap } from "effect"
import type { InstanceContext } from "./instance-context"

export const InstanceRef = ServiceMap.Reference<InstanceContext | undefined>("~opencode/InstanceRef", {
  defaultValue: () => undefined,
})
