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

/**
 * witr's documented exit codes. The code is the contract scripts are told to
 * read; the wording of the human-readable text is explicitly NOT part of it, so
 * an outcome must never be classified by matching output.
 * @see https://github.com/pranshuparmar/witr#72-exit-codes
 */
const EXIT = {
  /** Clean: the target was found with nothing to report. */
  ok: 0,
  /** The target was found and has warnings. Not a failure. */
  warnings: 1,
  /** Nothing matched: no such process, service, or (as root) port holder. */
  notFound: 2,
  /** Insufficient privileges: witr needs to run elevated. */
  permission: 3,
  /** Bad arguments, or a match too ambiguous to resolve. */
  invalidInput: 4,
  /** An unexpected failure inside witr. */
  internalError: 5,
  /** The target was found, but its cause cannot be traced. Not a failure. */
  causeUnknown: 6,
} as const

/**
 * How one invocation ended, derived from its exit status alone.
 *
 * `ok`, `warnings`, `notFound`, `permission` and `causeUnknown` are answers:
 * witr produced output the model should read. `invalidInput`, `internalError`
 * and `unavailable` are the only outcomes worth failing a tool call over.
 */
type Outcome = keyof typeof EXIT | 'unavailable'

/** Configuration schema for witr tool plugin */
export interface Config {
  /** Path to the witr executable (defaults to "witr" in PATH) */
  binaryPath?: string
  /** Execution timeout in milliseconds (defaults to 10,000ms) */
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  binaryPath: Schema.string().default('witr').description('Path to the witr executable binary'),
  timeoutMs: Schema.number().min(1).default(10_000).description('Execution timeout budget in milliseconds'),
})

/** Canonical value returned by one accepted witr invocation. */
interface ToolValue {
  /** Output to show the model, in the requested presentation format. */
  output: string
  /** Presentation format `output` was produced in. */
  format: Format
  /** witr's exit code, omitted when the call was cancelled before it settled. */
  exitCode?: number
  /** Warning lines, when the JSON document carried them. */
  warnings?: string[]
}

/** One finished witr invocation. */
interface WitrRun {
  /** Standard output captured so far. */
  stdout: string
  /** Standard error captured so far. */
  stderr: string
  /** Process exit status, or -1 when the process never started. */
  exitCode: number
  /** Set when the process could not be started or was killed by a signal. */
  spawnError?: unknown
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

/** Run witr once, capturing output and the exit status it ended with. */
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
    return { stdout, stderr, exitCode: EXIT.ok }
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown } | null
    const code = failure?.code
    // A numeric `code` is the child's exit status; anything else (for example
    // 'ENOENT', or an abort) means the child never reported one.
    return typeof code === 'number'
      ? { stdout: failure?.stdout ?? '', stderr: failure?.stderr ?? '', exitCode: code }
      : { stdout: failure?.stdout ?? '', stderr: failure?.stderr ?? '', exitCode: -1, spawnError: error }
  }
}

/**
 * Classify one invocation from its exit status.
 *
 * An unrecognized non-zero status fails the call rather than answering: exit
 * codes from timeouts, signals, or a future witr must never masquerade as a
 * successful trace.
 */
function outcomeOf(run: WitrRun): Outcome {
  if (run.spawnError !== undefined) return 'unavailable'
  switch (run.exitCode) {
    case EXIT.ok:
      return 'ok'
    case EXIT.warnings:
      return 'warnings'
    case EXIT.notFound:
      return 'notFound'
    case EXIT.permission:
      return 'permission'
    case EXIT.invalidInput:
      return 'invalidInput'
    case EXIT.internalError:
      return 'internalError'
    case EXIT.causeUnknown:
      return 'causeUnknown'
    default:
      return 'internalError'
  }
}

/** Resolve the execution timeout, falling back when the configured value is unusable. */
function resolveTimeout(configured: number | undefined): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? configured
    : 10_000
}

/** Whether a file target is absolute (POSIX or Windows drive rooted). */
function isAbsolutePath(target: string): boolean {
  return target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
}

/** Join both child streams so a warning on stderr is never dropped. */
function combinedOutput(run: WitrRun): string {
  const out = run.stdout ?? ''
  const err = run.stderr ?? ''
  if (out !== '' && err !== '') return `${out}${out.endsWith('\n') ? '' : '\n'}${err}`
  return out || err
}

/** Cap error text so a huge child dump cannot flood the model context. */
const MAX_ERROR_CHARS = 4_000

function truncate(text: string, max: number = MAX_ERROR_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)` : text
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

/**
 * Build the canonical value for one answered call.
 *
 * JSON output is re-serialized so environment blocks are gone, and its
 * documented `Warnings` array is lifted into the value; the requested format's
 * text stays the model-facing projection.
 */
function buildValue(run: WitrRun, format: Format): ToolValue {
  if (format === 'json') {
    // Parse the machine-readable stream alone so a trailing stderr note can
    // never break JSON.parse; a non-JSON answer falls back to both streams.
    const candidate = run.stdout !== '' ? run.stdout : run.stderr
    try {
      const parsed: unknown = JSON.parse(candidate)
      stripEnvironment(parsed)
      const value: ToolValue = {
        output: JSON.stringify(parsed, null, 2),
        format,
        exitCode: run.exitCode,
      }
      const warnings = (parsed as { Warnings?: unknown } | null)?.Warnings
      if (Array.isArray(warnings)) value.warnings = warnings.map(String)
      return value
    } catch {
      // Not the documented JSON document; the raw text is the best answer we have.
      const raw = combinedOutput(run)
      return { output: raw === '' ? 'No output received from witr.' : raw, format, exitCode: run.exitCode }
    }
  }
  const raw = combinedOutput(run)
  return { output: raw === '' ? 'No output received from witr.' : raw, format, exitCode: run.exitCode }
}

/** Build the error for a witr that produced no answer worth returning. */
function failureError(run: WitrRun, outcome: Outcome, binary: string): Error {
  if (outcome === 'unavailable') {
    const code = (run.spawnError as { code?: unknown } | undefined)?.code
    if (code === 'ENOENT') {
      return new Error(`could not run "${binary}"; install witr or set the plugin's binaryPath option`)
    }
    const message = run.spawnError instanceof Error ? run.spawnError.message : String(run.spawnError)
    return new Error(`witr failed to run: ${message}`)
  }
  const detail = truncate(
    [run.stdout, run.stderr]
      .map(part => part.trim())
      .filter(part => part !== '')
      .join('\n'),
  )
  const summary = outcome === 'invalidInput'
    ? `witr rejected the target (exit ${run.exitCode})`
    : `witr hit an internal error (exit ${run.exitCode})`
  return new Error(detail === '' ? summary : `${summary}:\n${detail}`)
}

export function apply(ctx: Context, config: Config = {}) {
  const configuredBinary = config.binaryPath?.trim()
  const binary = configuredBinary !== undefined && configuredBinary !== '' ? configuredBinary : 'witr'
  const defaultTimeout = resolveTimeout(config.timeoutMs)

  // Register main witr_trace tool
  ctx.tools.register(
    defineTool({
      name: 'witr_trace',
      description:
        'Explains why a process is running, what started it, or what holds a port or file lock open by tracing its causal ancestry back to supervisors, shells, or containers. A successful answer may still carry warnings, and "not found" is a valid answer rather than an error.',
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
          description:
            'Require exact match when searching by process name (disables substring search); use it when a name reports an ambiguous match.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            format: { type: 'string', required: true, enum: FORMATS },
            exitCode: { type: 'integer' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.output }],
        presentationMeta: (_args, value) => ({
          format: value.format,
          ...value.exitCode === undefined ? {} : { exitCode: value.exitCode },
          warningCount: value.warnings?.length ?? 0,
        }),
      },
      // Read-only system inspection: several traces may run in one tool batch.
      isConcurrencySafe: () => true,
      presentCall: (args) => {
        const target = String(args.target ?? '').trim()
        const kind = inferKind(target, args.kind)
        return {
          card: 'terminal',
          title: ['witr', ...cliArguments(kind, target, args)].join(' '),
          description: 'Trace why a process, port, or file lock exists',
        }
      },
      presentResult: (_args, result) => {
        const meta: unknown = result.meta
        const exitCode =
          typeof meta === 'object' && meta !== null && !Array.isArray(meta)
            && typeof (meta as { exitCode?: unknown }).exitCode === 'number'
            ? (meta as { exitCode: number }).exitCode
            : undefined
        return {
          card: 'terminal',
          output: result.content
            .map(block => (block.type === 'text' && 'text' in block ? String(block.text) : ''))
            .filter(text => text !== '')
            .join('\n'),
          ...exitCode === undefined ? {} : { exitCode },
        }
      },
      async execute(args, exec) {
        const target = String(args.target ?? '').trim()
        if (target === '') throw new Error('witr_trace requires a non-empty "target"')

        const kind = inferKind(target, args.kind)
        const format = args.format ?? 'standard'
        // Only a file target depends on the session directory.
        const cwd = kind === 'file' ? await sessionCwd(ctx, exec) : undefined
        // A relative file without its session directory would silently resolve
        // against the harness process directory, so refuse instead of tracing
        // the wrong file. Agent-less system calls keep the old behavior.
        if (kind === 'file' && !isAbsolutePath(target) && cwd === undefined && exec.agent !== undefined) {
          throw new Error(
            'witr_trace cannot resolve this relative file target without the session working directory; retry with an absolute path',
          )
        }

        const attempt = (attemptKind: Kind, attemptCwd?: string): Promise<WitrRun> =>
          runWitr(binary, cliArguments(attemptKind, target, args), {
            timeoutMs: defaultTimeout,
            signal: exec.signal,
            cwd: attemptCwd,
          })

        let run = await attempt(kind, cwd)
        // A bare number is ambiguous: try the likely reading, then the other
        // one. The decision rides on the exit code, never on witr's wording.
        if (args.kind === undefined && kind === 'pid' && outcomeOf(run) === 'notFound') {
          run = await attempt('port')
        }

        // Settling instead of throwing lets the registry replace this success
        // with its canonical ABORTED result rather than a generic tool failure.
        if (exec.signal.aborted) return { output: 'witr_trace was aborted.', format }

        const outcome = outcomeOf(run)
        if (outcome === 'unavailable' || outcome === 'invalidInput' || outcome === 'internalError') {
          throw failureError(run, outcome, binary)
        }
        // `warnings`, `notFound`, `permission` and `causeUnknown` are answers:
        // witr found the target, or found nothing, and its output says which.
        return buildValue(run, format)
      },
    }),
  )
}
