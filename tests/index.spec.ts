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

/** Stub binaries, so argument construction is tested without the real witr. */
const STUBS: Record<string, string> = {
  // Echo every argument, one per line.
  echo: `#!/bin/sh
printf '%s\\n' "$@"
`,
  // Answer --pid with witr's "nothing found" text and anything else with a port answer.
  pidMiss: `#!/bin/sh
case " $* " in
  *" --pid "*) printf 'No matching process or service found. Please check your query.\\n' ;;
  *) printf 'PORT-RESULT\\n' ;;
esac
`,
  // Emit JSON carrying environment blocks at two nesting levels.
  json: `#!/bin/sh
cat <<'JSON'
{"Target":{"Type":"pid","Value":"1"},"Process":{"PID":42,"Env":["SECRET=abc","TOKEN=xyz"]},"Ancestry":[{"PID":1,"Env":["SECRET=abc"]}]}
JSON
`,
  // Fail loudly after producing output on both streams.
  fail: `#!/bin/sh
printf 'partial diagnostic\\n'
printf 'stderr warning\\n' >&2
exit 3
`,
  // Wait long enough for a cancellation to arrive first.
  slow: `#!/bin/sh
sleep 30
printf 'too late\\n'
`,
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

/** Invoke one tool call with a fresh cancellation signal. */
async function run(tool: Awaited<ReturnType<typeof mount>>, args: Record<string, unknown>): Promise<string> {
  return (await tool.execute(args as never, { signal: new AbortController().signal } as never)) as string
}

/** Invoke one tool call that the caller cancels after `afterMs`. */
async function runAbortable(
  tool: Awaited<ReturnType<typeof mount>>,
  args: Record<string, unknown>,
  afterMs: number,
): Promise<string> {
  const controller = new AbortController()
  const pending = tool.execute(args as never, { signal: controller.signal } as never)
  setTimeout(() => controller.abort(), afterMs)
  return (await pending) as string
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

    expect(await run(tool, { target: 'node', kind: 'name' })).toBe('--no-color\n--\nnode\n')
  })

  it('keeps an option-shaped process name a name', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect(await run(tool, { target: '--env', kind: 'name' })).toBe('--no-color\n--\n--env\n')
  })

  it('passes explicit kinds through their own flags', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect(await run(tool, { target: '1234', kind: 'pid' })).toBe('--no-color\n--pid\n1234\n')
    expect(await run(tool, { target: '3080', kind: 'port' })).toBe('--no-color\n--port\n3080\n')
    expect(await run(tool, { target: '/var/lib/dpkg/lock', kind: 'file' })).toBe(
      '--no-color\n--file\n/var/lib/dpkg/lock\n',
    )
  })

  it('emits every flag before the -- terminator', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect(await run(tool, { target: 'redis', exact: true, format: 'mermaid' })).toBe(
      '--exact\n--mermaid\n--no-color\n--\nredis\n',
    )
  })

  it('treats a bare number as a PID first and falls back to a port', async () => {
    const tool = await mount({ binaryPath: stub('pidMiss') })

    expect(await run(tool, { target: '9999' })).toBe('PORT-RESULT\n')
    expect(await run(tool, { target: '9999', kind: 'pid' })).not.toBe('PORT-RESULT\n')
  })

  it('treats a slash-bearing target as a file', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    expect(await run(tool, { target: './Cargo.lock' })).toBe('--no-color\n--file\n./Cargo.lock\n')
  })
})

describe.skipIf(noShellStubs)('output handling', () => {
  it('strips environment blocks from JSON output at every level', async () => {
    const tool = await mount({ binaryPath: stub('json') })

    const parsed = JSON.parse(await run(tool, { target: '42', kind: 'pid', format: 'json' }))
    expect(parsed.Process.PID).toBe(42)
    expect(parsed.Process.Env).toBeUndefined()
    expect(parsed.Ancestry[0].Env).toBeUndefined()
  })

  it('surfaces a non-zero exit as a failure carrying the diagnostic', async () => {
    const tool = await mount({ binaryPath: stub('fail') })

    await expect(run(tool, { target: 'node' })).rejects.toThrow(/partial diagnostic/)
  })

  it('settles instead of throwing when the caller cancels', async () => {
    const tool = await mount({ binaryPath: stub('slow') })

    expect(await runAbortable(tool, { target: 'node' }, 100)).toMatch(/aborted/i)
  })

  it('reports a missing binary with an actionable message', async () => {
    const tool = await mount({ binaryPath: join(tmpdir(), 'dsh-plugin-witr-missing-binary') })

    await expect(run(tool, { target: 'node' })).rejects.toThrow(/binaryPath/)
  })

  it('presents the completed trace as terminal output', async () => {
    const tool = await mount({ binaryPath: stub('echo') })

    const result = await run(tool, { target: 'node', kind: 'name' })
    const view = tool.presentResult?.(
      { target: 'node', kind: 'name' },
      { content: [{ type: 'text', text: result }], isError: false },
    )
    expect(view).toMatchObject({ card: 'terminal', output: result })
  })
})

describe.skipIf(!hasWitr)('witr integration', () => {
  it('returns standard process tracing for this process', async () => {
    const tool = await mount()

    const result = await run(tool, { target: String(process.pid), kind: 'pid', format: 'standard' })
    expect(typeof result).toBe('string')
    expect(result).toContain('Process')
    expect(result).toContain(String(process.pid))
  })

  it('exports a mermaid diagram', async () => {
    const tool = await mount()

    const result = await run(tool, { target: String(process.pid), kind: 'pid', format: 'mermaid' })
    expect(result).toContain('mermaid')
    expect(result).toContain('graph TD')
  })

  it('returns JSON without environment variables', async () => {
    const tool = await mount()

    const parsed = JSON.parse(await run(tool, { target: String(process.pid), kind: 'pid', format: 'json' }))
    expect(parsed.Process.PID).toBe(process.pid)
    expect(parsed.Process.Env).toBeUndefined()
  })
})
