import { ComponentProps } from "solid-js"

const mark = ["█▀▀█    ", "█  █ ▀▀ ", "▀▀▀█▀   "]
const wordmark = ["█▀▀█   -   █▀▀▀ █▀▀█ █▀▀▄ █▀▀ ", "█  █   -   █    █  █ █  █ █▀▀ ", "▀▀▀█▀      ▀▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀ "]
const logoBlue = "var(--icon-agent-build-base)"
const defaultFill = "var(--icon-strong-base)"

function TextLogo(props: { lines: string[]; class?: string; viewBox: string; size: number; bluePrefix?: number }) {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={props.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Q-code"
    >
      <text
        x="0"
        y={props.size}
        fill={defaultFill}
        font-family="JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size={`${props.size}`}
        font-weight="700"
      >
        {props.lines.map((line, index) => {
          const prefixSize = Math.max(0, props.bluePrefix ?? 0)
          const prefix = prefixSize > 0 ? line.slice(0, prefixSize) : ""
          const suffix = prefixSize > 0 ? line.slice(prefixSize) : line
          return (
            <tspan x="0" dy={index === 0 ? 0 : props.size * 1.08}>
              {prefix ? <tspan fill={logoBlue}>{prefix}</tspan> : null}
              <tspan fill={defaultFill}>{suffix}</tspan>
            </tspan>
          )
        })}
      </text>
    </svg>
  )
}

export const Mark = (props: { class?: string }) => {
  return <TextLogo lines={mark} class={props.class} viewBox="0 0 82 42" size={12} bluePrefix={8} />
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 250 76"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Q-code"
    >
      <text
        x="0"
        y="18"
        fill={defaultFill}
        font-family="JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="18"
        font-weight="700"
      >
        {wordmark.map((line, index) => {
          const prefix = line.slice(0, 8)
          const suffix = line.slice(8)
          return (
            <tspan x="0" dy={index === 0 ? 0 : 20}>
              <tspan fill={logoBlue}>{prefix}</tspan>
              <tspan fill={defaultFill}>{suffix}</tspan>
            </tspan>
          )
        })}
      </text>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return <TextLogo lines={wordmark} class={props.class} viewBox="0 0 320 54" size={14} bluePrefix={8} />
}
