import { type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 760 160"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="HoyaAgent"
    >
      <g transform="translate(0 0) scale(0.3125)">
        <rect x="24" y="24" width="464" height="464" rx="112" fill="#15201d" />
        <rect x="139" y="126" width="66" height="260" rx="33" fill="#f4f8f6" />
        <rect x="307" y="126" width="66" height="260" rx="33" fill="#f4f8f6" />
        <rect x="172" y="223" width="168" height="66" rx="33" fill="#2dd4bf" />
        <circle cx="256" cy="256" r="18" fill="#15201d" />
      </g>
      <text
        x="188"
        y="104"
        fill="currentColor"
        style={{ "font-size": "72px", "font-weight": 700, "font-family": "Inter, ui-sans-serif, system-ui, sans-serif", "letter-spacing": "-0.045em" }}
      >
        HoyaAgent
      </text>
    </svg>
  )
}
