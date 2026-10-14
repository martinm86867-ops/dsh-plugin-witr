import { describe, expect, it } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import * as ToolWitr from "../src/index.ts"

describe("@deepseek-ai/dsh-experimental-tool-witr", () => {
  it("registers witr_trace tool on ctx.tools", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolWitr, { binaryPath: "witr" })

    const tool = ctx.tools.get("witr_trace")
    expect(tool).toBeDefined()
    expect(tool?.name).toBe("witr_trace")
    expect(tool?.parameters.properties.target).toBeDefined()
  })

  it("executes witr_trace and returns standard process tracing output", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolWitr, { binaryPath: "witr" })

    const tool = ctx.tools.get("witr_trace")
    expect(tool).toBeDefined()

    const result = await tool!.execute(
      { target: String(process.pid), kind: "pid", format: "standard" },
      { signal: new AbortController().signal } as any,
    )

    expect(typeof result).toBe("string")
    expect(result).toContain("Process")
    expect(result).toContain(String(process.pid))
  })

  it("supports mermaid diagram export", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolWitr, { binaryPath: "witr" })

    const tool = ctx.tools.get("witr_trace")
    expect(tool).toBeDefined()

    const result = await tool!.execute(
      { target: String(process.pid), kind: "pid", format: "mermaid" },
      { signal: new AbortController().signal } as any,
    )

    expect(typeof result).toBe("string")
    expect(result).toContain("mermaid")
    expect(result).toContain("graph TD")
  })

  it("supports json format output", async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolWitr, { binaryPath: "witr" })

    const tool = ctx.tools.get("witr_trace")
    expect(tool).toBeDefined()

    const result = await tool!.execute(
      { target: String(process.pid), kind: "pid", format: "json" },
      { signal: new AbortController().signal } as any,
    )

    expect(typeof result).toBe("string")
    const parsed = JSON.parse(result)
    expect(parsed.Process).toBeDefined()
    expect(parsed.Process.PID).toBe(process.pid)
  })
})
