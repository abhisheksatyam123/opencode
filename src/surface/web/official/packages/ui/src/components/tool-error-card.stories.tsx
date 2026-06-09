import { ToolErrorCard } from "./tool-error-card"

const docs = `### Overview
Tool call failure summary styled like a tool trigger.

### API
- Required: \`tool\` (tool id, e.g. apply_patch, bash)
- Required: \`error\` (error string)

### Behavior
- Collapsible; click header to expand/collapse.
`

const samples = [
  {
    tool: "bash",
    error: "bash Command failed: exit code 1: bun test --watch",
  },
  {
    tool: "task",
    error: "task Failed: subagent returned no result",
  },
]

export default {
  title: "UI/ToolErrorCard",
  id: "components-tool-error-card",
  component: ToolErrorCard,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    tool: "bash",
    error: samples[0].error,
  },
  argTypes: {
    tool: {
      control: "select",
      options: ["bash", "task"],
    },
    error: {
      control: "text",
    },
  },
  render: (props: { tool: string; error: string }) => {
    return <ToolErrorCard tool={props.tool} error={props.error} />
  },
}

export const All = {
  render: () => {
    return (
      <div style="display: flex; flex-direction: column; gap: 12px; max-width: 720px;">
        {samples.map((item) => (
          <ToolErrorCard tool={item.tool} error={item.error} />
        ))}
      </div>
    )
  },
}
