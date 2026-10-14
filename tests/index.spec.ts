import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolWitr from '../src/index.ts'

/** True when the real witr binary is installed, so integration cases can run. */
function witrAvailable(): boolean {
  try {
    execFileSync('witr', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasWitr = witrAvailable()
const noShellStubs = process.platform === 'win32'

/** Stub binaries, so exit handling and argument construction need no real witr. */
const STUBS: Record<string, string> = {
  // Echo every argument, one per line.
  echo: `#!/bin/sh
printf '%s\\n' "$@"
`,
  // Report "not found" with witr's documented exit code for it.
  pidMiss: `#!/bin/sh
case " $* " in
  *" --pid "*) printf 'No matching process or service found.\\n'; exit 2 ;;
  *) printf 'PORT-RESULT\\n' ;;
esac
`,
  // Found, but with warnings: exit 1 is an answer, not a failure.
  warn: `#!/bin/sh
printf 'Target: sleep\\nWarnings:\\n  - suspicious working directory: /tmp\\n'
exit 1
`,
  // Found and clean.
  ok: `#!/bin/sh
printf 'Target: node\\n'
`,
  // Not found.
  notFound: `#!/bin/sh
printf 'No matching process or service found.\\n'
exit 2
`,
  // Insufficient privileges.
  denied: `#!/bin/sh
printf 'socket found but owning process not detected\\n'
exit 3
`,
  // Ambiguous match: the only input error worth failing on.
  ambiguous: `#!/bin/sh
printf 'ambiguous match: two processes named node\\n'
exit 4
`,
  // Internal failure.
  internal: `#!/bin/sh
printf 'unexpected failure\\n'
exit 5
`,
  // Found, but the cause cannot be traced: also an answer.
  causeUnknown: `#!/bin/sh
printf 'Target: node\\nCause unknown: the parent exited\\n'
exit 6
`,
  // Emit JSON carrying environment blocks plus a warnings array.
  json: `#!/bin/sh
cat <<'JSON'
{"Target":{"Type":"pid","Value":"42"},"Process":{"PID":42,"Env":["SECRET=abc","TOKEN=xyz"]},"Warnings":["Process is running from a suspicious working directory: /tmp"],"Ancestry":[{"PID":1,"Env":["SECRET=abc"]}]}
JSON
`,
  // Wait long enough for a cancellation to arrive first.
  slow: `#!/bin/sh
sleep 30
printf 'too late\\n'
`,
  // Unrecognized exit code: must fail, never masquerade as an answer.
  unknown: `#!/bin/sh
printf 'some future output\\n'
exit 7
`,
  // Both streams present: both must reach the model.
  both: `#!/bin/sh
printf 'OUT-LINE\\n'
printf 'ERR-LINE\\n' >&2
`,
  // Huge error detail: the thrown message must be truncated.
  big: `#!/bin/sh
awk 'BEGIN { for (i = 0; i < 2000; i++) printf "PAD-LINE-%04d-0123456789\\n", i }'
exit 5
`,
}

/** The canonical value shape the tool returns. */
interface Value {
  output: string
  format: string
  exitCode?: number
  warnings?: string[]
}

let dir: string
const stub = (name: keyof typeof STUBS): string => join(dir, name)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-witr-'))
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(dir, name), body, { mode: 0o755 })
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Mount the plugin and return its registered tool definition. */
async function mount(config: ToolWitr.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolWitr, { binaryPath: 'witr', ...config })
  const tool = ctx.tools.get('witr_trace')
  if (tool === undefined) throw new Error('witr_trace was not registered')
  return tool
}

type Tool = Awaited<ReturnType<typeof mount>>

/** Invoke one tool call with a fresh cancellation signal. */
async function run(tool: Tool, args: Record<string, unknown>): Promise<Value> {
  return (await tool.execute(args as never, { signal: new AbortController().signal } as never)) as Value
}

/** Invoke one tool call that the caller cancels after `afterMs`. */
async function runAbortable(tool: Tool, args: Record<string, unknown>, afterMs: number): Promise<Value> {
  const controller = new AbortController()
  const pending = tool.execute(args as never, { signal: controller.signal } as never)
  setTimeout(() => controller.abort(), afterMs)
  return (await pending) as Value
}

/** Invoke one tool call with an agent identity attached. */
async function runWithAgent(tool: Tool, args: Record<string, unknown>): Promise<Value> {
  return (await tool.execute(args as never, { signal: new AbortController().signal, agent: {} } as never)) as Value
}

describe('@deepseek-ai/dsh-experimental-tool-witr', () => {
  it('registers witr_trace on ctx.tools with constrained parameters', async () => {
    const tool = await mount()

    expect(tool.name).toBe('witr_trace')
    const parameters = tool.parameters as { properties: Record<string, { enum?: string[] }> }
    expect(parameters.properties.target).toBeDefined()
    expect(parameters.properties.kind?.enum).toEqual(['port', 'pid', 'file', 'name'])
    expect(parameters.properties.format?.enum).toEqual(['standard', 'tree', 'mermaid', 'dot', 'json'])
    expect(tool.parameters).toMatchObject({ required: ['target'] })
  })

  it('declares a structured output schema', async () => {
    const tool = await mount()

    const schema = tool.output.schema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['exitCode', 'format', 'output', 'warnings'])
    expect(schema.required).toEqual(['output', 'format'])
  })

  it('rejects an unknown kind and an unknown format before running witr', async () => {
    const tool = await mount()

    await expect(run(tool, { target: 'node', kind: 'container' })).rejects.toThrow(/invalid arguments/)
    await expect(run(tool, { target: 'node', format: 'xml' })).rejects.toThrow(/invalid arguments/)
  })

  it('rejects a blank target', async () => {
    const tool = await mount()

    await expect(run(tool, { target: '   ' })).rejects.toThrow(/non-empty/)
  })

  it('advertises itself as concurrency safe', async () => {
    const tool = await mount()

    expect(tool.isConcurrencySafe?.({ target: 'node' })).toBe(true)
  })

  it('presents the command as a terminal call without letting a name become a flag', async () => {
    const tool = await mount()

    const view = tool.presentCall?.({ target: '--env', kind: 'name' }) as { card?: string; title?: string } | undefined
    expect(view?.card).toBe('terminal')
    expect(view?.title).toContain('witr ')
    expect(view?.title).toContain('-- --env')
  })
})

describe.skipIf(noShellStubs)('argument construction', () => {
  it('places -- before a process name so it stays positional', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: 'node', kind: 'name' })).output).toBe('--no-color\n--\nnode\n')
  })

  it('keeps an option-shaped process name a name', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: '--env', kind: 'name' })).output).toBe('--no-color\n--\n--env\n')
  })

  it('passes explicit kinds through their own flags', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: '1234', kind: 'pid' })).output).toBe('--no-color\n--pid\n1234\n')
    expect((await run(tool, { target: '3080', kind: 'port' })).output).toBe('--no-color\n--port\n3080\n')
    expect((await run(tool, { target: '/var/lib/dpkg/lock', kind: 'file' })).output).toBe(
      '--no-color\n--file\n/var/lib/dpkg/lock\n',
    )
  })

  it('emits every flag before the -- terminator', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: 'redis', exact: true, format: 'mermaid' })).output).toBe(
      '--exact\n--mermaid\n--no-color\n--\nredis\n',
    )
  })

  it('reports the format it produced', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: 'node', format: 'tree' })).format).toBe('tree')
    expect((await run(tool, { target: 'node' })).format).toBe('standard')
  })

  it('treats a slash-bearing target as a file', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect((await run(tool, { target: './Cargo.lock' })).output).toBe('--no-color\n--file\n./Cargo.lock\n')
  })
})

describe.skipIf(noShellStubs)('exit-code contract', () => {
  it('falls back from a PID to a port using the not-found code, not the text', async () => {
    const tool = await mount({ binaryPath: stub('pidMiss') })

    const fellBack = await run(tool, { target: '9999' })
    expect(fellBack.output).toBe('PORT-RESULT\n')
    expect(fellBack.exitCode).toBe(0)

    // An explicit kind is never second-guessed.
    const explicit = await run(tool, { target: '9999', kind: 'pid' })
    expect(explicit.output).toContain('No matching process or service found')
  })

  it('returns exit 1 as a successful answer carrying warnings', async () => {
    const tool = await mount({ binaryPath: stub('warn') })

    const value = await run(tool, { target: 'sleep', kind: 'pid' })
    expect(value.exitCode).toBe(1)
    expect(value.output).toContain('suspicious working directory')
  })

  it('returns exit 6 (cause unknown) as a successful answer', async () => {
    const tool = await mount({ binaryPath: stub('causeUnknown') })

    const value = await run(tool, { target: 'node' })
    expect(value.exitCode).toBe(6)
    expect(value.output).toContain('Cause unknown')
  })

  it('returns exit 2 (not found) and exit 3 (permission) as answers', async () => {
    const notFound = await run(await mount({ binaryPath: stub('notFound') }), { target: 'node' })
    expect(notFound.exitCode).toBe(2)

    const denied = await run(await mount({ binaryPath: stub('denied') }), { target: 'node' })
    expect(denied.exitCode).toBe(3)
    expect(denied.output).toContain('owning process not detected')
  })

  it('fails on exit 4 and exit 5', async () => {
    const ambiguous = await mount({ binaryPath: stub('ambiguous') })
    await expect(run(ambiguous, { target: 'node' })).rejects.toThrow(/exit 4[\s\S]*ambiguous match/)

    const internal = await mount({ binaryPath: stub('internal') })
    await expect(run(internal, { target: 'node' })).rejects.toThrow(/exit 5/)
  })

  it('fails an unrecognized exit code instead of answering', async () => {
    const tool = await mount({ binaryPath: stub('unknown') })

    await expect(run(tool, { target: 'node' })).rejects.toThrow(/exit 7/)
  })

  it('reports a missing binary with an actionable message', async () => {
    const tool = await mount({ binaryPath: join(tmpdir(), 'dsh-plugin-witr-missing-binary') })

    await expect(run(tool, { target: 'node' })).rejects.toThrow(/binaryPath/)
  })

  it('settles instead of throwing when the caller cancels', async () => {
    const tool = await mount({ binaryPath: stub('slow') })

    expect((await runAbortable(tool, { target: 'node' }, 100)).output).toMatch(/aborted/i)
  })
})

describe.skipIf(noShellStubs)('output handling', () => {
  it('strips environment blocks from JSON output and lifts its warnings', async () => {
    const tool = await mount({ binaryPath: stub('json') })

    const value = await run(tool, { target: '42', kind: 'pid', format: 'json' })
    const parsed = JSON.parse(value.output)
    expect(parsed.Process.PID).toBe(42)
    expect(parsed.Process.Env).toBeUndefined()
    expect(parsed.Ancestry[0].Env).toBeUndefined()
    expect(value.warnings).toEqual(['Process is running from a suspicious working directory: /tmp'])
  })

  it('presents the completed trace as terminal output with the exit code', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    const view = tool.presentResult?.(
      { target: 'node', kind: 'name' },
      { content: [{ type: 'text', text: 'trace body' }], isError: false, meta: { exitCode: 1, warningCount: 1 } },
    ) as { card?: string; output?: string; exitCode?: number } | undefined
    expect(view).toMatchObject({ card: 'terminal', output: 'trace body', exitCode: 1 })
  })

  it('combines stdout and stderr so neither stream is lost', async () => {
    const tool = await mount({ binaryPath: stub('both') })

    const value = await run(tool, { target: 'node' })
    expect(value.output).toContain('OUT-LINE')
    expect(value.output).toContain('ERR-LINE')
  })

  it('truncates huge error detail instead of flooding context', async () => {
    const tool = await mount({ binaryPath: stub('big') })

    const error = await run(tool, { target: 'node' }).then(
      () => {
        throw new Error('expected the call to fail')
      },
      (cause: unknown) => cause as Error,
    )
    expect(error.message).toMatch(/truncated/)
    expect(error.message.length).toBeLessThan(8000)
  })

  it('refuses a relative file target when the session directory is unavailable', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    await expect(runWithAgent(tool, { target: './Cargo.lock' })).rejects.toThrow(/absolute path/)
    // Absolute paths still work without the directory.
    expect((await runWithAgent(tool, { target: '/var/lib/dpkg/lock', kind: 'file' })).output).toContain('--file')
  })

  it('presents a call without throwing on a missing target', async () => {
    const tool = await mount()

    expect(() => tool.presentCall?.({} as never)).not.toThrow()
  })
})

describe.skipIf(!hasWitr)('witr integration', () => {
  it('returns standard process tracing for this process', async () => {
    const tool = await mount()

    const value = await run(tool, { target: String(process.pid), kind: 'pid', format: 'standard' })
    expect(value.exitCode).toBeLessThan(2)
    expect(value.output).toContain('Process')
    expect(value.output).toContain(String(process.pid))
  })

  it('exports a mermaid diagram', async () => {
    const tool = await mount()

    expect((await run(tool, { target: String(process.pid), kind: 'pid', format: 'mermaid' })).output).toContain('graph TD')
  })

  it('returns JSON without environment variables', async () => {
    const tool = await mount()

    const value = await run(tool, { target: String(process.pid), kind: 'pid', format: 'json' })
    const parsed = JSON.parse(value.output)
    expect(parsed.Process.PID).toBe(process.pid)
    expect(parsed.Process.Env).toBeUndefined()
  })

  it('treats a missing process as an answer, not a failure', async () => {
    const tool = await mount()

    const value = await run(tool, { target: 'definitely-not-a-real-process-xyz', kind: 'name' })
    expect(value.exitCode).toBe(2)
    expect(value.output).toMatch(/no matching process/i)
  })
})
