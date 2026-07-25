import { type ComponentProps } from "solid-js"

function HoyaGlyph() {
  return (
    <>
      <rect x="24" y="24" width="464" height="464" rx="112" fill="#15201d" />
      <rect x="139" y="126" width="66" height="260" rx="33" fill="#f4f8f6" />
      <rect x="307" y="126" width="66" height="260" rx="33" fill="#f4f8f6" />
      <rect x="172" y="223" width="168" height="66" rx="33" fill="#2dd4bf" />
      <circle cx="256" cy="256" r="18" fill="#15201d" />
    </>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="HoyaAgent"
    >
      <HoyaGlyph />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="HoyaAgent"
    >
      <HoyaGlyph />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
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
        <HoyaGlyph />
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
