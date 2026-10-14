/**
 * Model-facing witr_trace tool for process, port, and file lock causal tracing.
 * Traces processes back through systemd, containers, supervisors, and shells.
 * @module dsh-plugin-witr
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'tool-witr'
// The working directory is read lazily through `ctx.get`, so the tool still
// registers in a composition that does not provide the service.
export const inject = ['tools']

/** Target kinds the witr CLI accepts through its explicit flags. */
const KINDS = ['port', 'pid', 'file', 'name'] as const

/** One accepted target kind. */
type Kind = (typeof KINDS)[number]

/** Output formats the witr CLI accepts. */
const FORMATS = ['standard', 'tree', 'mermaid', 'dot', 'json'] as const

/** One accepted output format. */
type Format = (typeof FORMATS)[number]

/** Maximum bytes of child output retained before the run fails. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** witr's own wording when a target resolves to nothing. */
const NOT_FOUND = /no matching process or service found/i

/** Configuration schema for witr tool plugin */
export interface Config {
  /** Path to the witr executable (defaults to "witr" in PATH) */
  binaryPath?: string
  /** Execution timeout in milliseconds (defaults to 10,000ms) */
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  binaryPath: Schema.string().default('witr').description('Path to the witr executable binary'),
  timeoutMs: Schema.number().default(10_000).description('Execution timeout budget in milliseconds'),
})

/** One finished or failed witr invocation. */
interface WitrRun {
  /** Standard output captured so far. */
  stdout: string
  /** Standard error captured so far. */
  stderr: string
  /** Set when the process could not start, was killed, or exited non-zero. */
  failure?: unknown
}

/** Per-call options shared by the argument builder and the runner. */
interface CallOptions {
  /** Disable substring matching for a process-name lookup. */
  exact?: boolean | undefined
  /** Requested output projection. */
  format?: Format | undefined
}

/** Infer the target kind when the caller named none. */
function inferKind(target: string, kind: Kind | undefined): Kind {
  if (kind !== undefined) return kind
  // A bare number is ambiguous; execution tries a process ID and then a port.
  if (/^\d+$/.test(target)) return 'pid'
  return target.includes('/') || target.startsWith('.') ? 'file' : 'name'
}

/** Map one output format to its CLI flag; the default format needs none. */
function formatFlag(format: Format | undefined): string | undefined {
  switch (format) {
    case 'tree':
      return '--tree'
    case 'mermaid':
      return '--mermaid'
    case 'dot':
      return '--dot'
    case 'json':
      return '--json'
    default:
      return undefined
  }
}

/**
 * Build the witr argument list for one resolved target.
 *
 * A flag kind consumes the target as its value, so the target can never be read
 * as an option. A bare name is positional, so `--` ends option parsing before
 * it and a name like `--env` stays a process name.
 */
function cliArguments(kind: Kind, target: string, options: CallOptions): string[] {
  const flags: string[] = []
  if (options.exact === true) flags.push('--exact')
  const format = formatFlag(options.format)
  if (format !== undefined) flags.push(format)
  flags.push('--no-color')
  return kind === 'name' ? [...flags, '--', target] : [...flags, `--${kind}`, target]
}

/** Run witr once, capturing output even when the process exits non-zero. */
async function runWitr(
  binary: string,
  cliArgs: string[],
  options: { timeoutMs: number; signal: AbortSignal; cwd?: string | undefined },
): Promise<WitrRun> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, cliArgs, {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd: options.cwd,
    })
    return { stdout, stderr }
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string } | null
    return { stdout: failure?.stdout ?? '', stderr: failure?.stderr ?? '', failure: error }
  }
}

/** True when witr reported that the target does not exist. */
function notFound(run: WitrRun): boolean {
  return NOT_FOUND.test(`${run.stdout}\n${run.stderr}`)
}

/**
 * The calling session's working directory, so a relative file target resolves
 * where the agent is working rather than where the harness process started.
 * @returns the validated directory, or undefined for a non-agent or vanished call.
 */
async function sessionCwd(ctx: Context, exec: ToolExecution): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const directories = ctx.get('workingDirectory')
  if (directories === undefined) return undefined
  try {
    return await directories.ensure(exec.agent, exec.signal)
  } catch {
    // An absolute target still works, so a missing directory is not fatal here.
    return undefined
  }
}

/** Drop every `Env` block so process secrets never reach the model or the session log. */
function stripEnvironment(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripEnvironment(item)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  delete record.Env
  for (const child of Object.values(record)) stripEnvironment(child)
}

/** Render one run that produced an answer for the model. */
function present(run: WitrRun, format: Format | undefined): string {
  const output = run.stdout || run.stderr
  if (format !== 'json') return output || 'No output received from witr.'
  try {
    const parsed: unknown = JSON.parse(output)
    stripEnvironment(parsed)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return output || 'No output received from witr.'
  }
}

/** Build the error shown when witr never produced a usable answer. */
function failureError(run: WitrRun, binary: string): Error {
  const detail = [run.stdout, run.stderr]
    .map(part => part.trim())
    .filter(part => part !== '')
    .join('\n')
  if (detail !== '') return new Error(`witr exited with an error:\n${detail}`)
  const code = (run.failure as { code?: unknown } | undefined)?.code
  if (code === 'ENOENT') {
    return new Error(`could not run "${binary}"; install witr or set the plugin's binaryPath option`)
  }
  const message = run.failure instanceof Error ? run.failure.message : String(run.failure)
  return new Error(`witr failed to run: ${message}`)
}

export function apply(ctx: Context, config: Config = {}) {
  const binary = config.binaryPath || 'witr'
  const defaultTimeout = config.timeoutMs || 10_000

  // Register main witr_trace tool
  ctx.tools.register(
    defineTool({
      name: 'witr_trace',
      description:
        'Explains why a process is running, what started it, or what holds a port or file lock open by tracing its causal ancestry back to supervisors, shells, or containers.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description:
            'Target identifier: port number (e.g. "3000"), process ID (e.g. "1234"), process name (e.g. "node"), or file path (e.g. "/var/lib/dpkg/lock"). A bare number is tried as a process ID first, then as a port.',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description:
            'Explicit target kind. Omit to infer it: a number is tried as a process ID then a port, a value containing "/" is a file path, and anything else is a process name.',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description:
            'Output presentation format: "standard" (default detailed causal tree), "tree" (compact tree), "mermaid" (Mermaid.js diagram), "dot" (Graphviz DOT), or "json" (machine-readable; process environment variables are omitted).',
        },
        exact: {
          type: 'boolean',
          description: 'Require exact match when searching by process name (disables substring search).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // Read-only system inspection: several traces may run in one tool batch.
      isConcurrencySafe: () => true,
      presentCall: (args) => {
        const target = args.target.trim()
        const kind = inferKind(target, args.kind)
        return {
          card: 'terminal',
          title: ['witr', ...cliArguments(kind, target, args)].join(' '),
          description: 'Trace why a process, port, or file lock exists',
        }
      },
      presentResult: (_args, result) => ({
        card: 'terminal',
        output: result.content
          .map(block => (block.type === 'text' && 'text' in block ? String(block.text) : ''))
          .filter(text => text !== '')
          .join('\n'),
      }),
      async execute(args, exec) {
        const target = args.target.trim()
        if (target === '') throw new Error('witr_trace requires a non-empty "target"')

        const kind = inferKind(target, args.kind)
        // Only a file target depends on the session directory.
        const cwd = kind === 'file' ? await sessionCwd(ctx, exec) : undefined

        let run = await runWitr(binary, cliArguments(kind, target, args), {
          timeoutMs: defaultTimeout,
          signal: exec.signal,
          cwd,
        })
        // A bare number is ambiguous: try the likely reading, then the other one.
        if (args.kind === undefined && kind === 'pid' && notFound(run)) {
          run = await runWitr(binary, cliArguments('port', target, args), {
            timeoutMs: defaultTimeout,
            signal: exec.signal,
          })
        }

        // Settling instead of throwing lets the registry classify the call as
        // cancelled rather than as an ordinary tool failure.
        if (exec.signal.aborted) return 'witr_trace was aborted.'

        // A resolved-but-empty answer and a real failure are different outcomes.
        if (run.failure !== undefined && !notFound(run)) throw failureError(run, binary)

        return present(run, args.format)
      },
    }),
  )
}
