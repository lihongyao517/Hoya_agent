import { describe, expect, test } from "bun:test"
import { findPiToolPart, normalizeToolInput, toolResultText } from "./session-store"

describe("Pi tool event adaptation", () => {
  test("keeps Pi paths visible to OpenCode file tool renderers", () => {
    expect(normalizeToolInput("write", { path: "src/hello.py", content: "print('hi')" })).toMatchObject({
      path: "src/hello.py",
      filePath: "src/hello.py",
      content: "print('hi')",
    })
  })

  test("renders tool result text instead of Pi's raw content envelope", () => {
    expect(toolResultText({ content: [{ type: "text", text: "written src/hello.py" }], details: {} })).toBe(
      "written src/hello.py",
    )
  })

  test("merges a composing Pi tool call with its later execution event", () => {
    const composing = {
      type: "tool",
      tool: "bash",
      callID: "pi-0",
      state: { metadata: { piPhase: "ready", piContentIndex: 0 } },
    }
    expect(findPiToolPart([composing], "call_final", "bash")).toBe(composing)
  })
})
