/**
 * Model-facing witr_trace tool for process, port, and file lock causal tracing.
 * Traces processes back through systemd, containers, supervisors, and shells.
 * @module dsh-plugin-witr
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'tool-witr'
export const inject = ['tools']

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
            'Target identifier: port number (e.g. "3000"), process ID (e.g. "1234"), process name (e.g. "node"), or file path (e.g. "/var/lib/dpkg/lock").',
        },
        kind: {
          type: 'string',
          description:
            'Optional explicit target kind: "port", "pid", "file", or "name". If omitted, inferred automatically.',
        },
        format: {
          type: 'string',
          description:
            'Output presentation format: "standard" (default detailed causal tree), "tree" (compact tree), "mermaid" (Mermaid.js diagram), "dot" (Graphviz DOT), or "json".',
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
      async execute(args, exec) {
        const cliArgs: string[] = []

        const rawTarget = args.target.trim()
        const kind = args.kind

        if (kind === 'port') {
          cliArgs.push('--port', rawTarget)
        } else if (kind === 'pid') {
          cliArgs.push('--pid', rawTarget)
        } else if (kind === 'file') {
          cliArgs.push('--file', rawTarget)
        } else if (kind === 'name') {
          cliArgs.push(rawTarget)
        } else {
          // Automatic inference
          if (/^\d+$/.test(rawTarget)) {
            const num = parseInt(rawTarget, 10)
            if (num > 0 && num <= 65535) {
              cliArgs.push('--port', rawTarget)
            } else {
              cliArgs.push('--pid', rawTarget)
            }
          } else if (rawTarget.includes('/') || rawTarget.startsWith('.')) {
            cliArgs.push('--file', rawTarget)
          } else {
            cliArgs.push(rawTarget)
          }
        }

        if (args.exact) {
          cliArgs.push('--exact')
        }

        if (args.format === 'mermaid') {
          cliArgs.push('--mermaid')
        } else if (args.format === 'dot') {
          cliArgs.push('--dot')
        } else if (args.format === 'json') {
          cliArgs.push('--json')
        } else if (args.format === 'tree') {
          cliArgs.push('--tree')
        }

        cliArgs.push('--no-color')

        try {
          const { stdout, stderr } = await execFileAsync(binary, cliArgs, {
            signal: exec.signal,
            timeout: defaultTimeout,
            maxBuffer: 4 * 1024 * 1024,
          })
          return stdout || stderr || 'No output received from witr.'
        } catch (error: any) {
          if (error && (error.stdout || error.stderr)) {
            const out = [error.stdout, error.stderr].filter(Boolean).join('\n')
            return out || 'Command failed with no output'
          }
          throw new Error('witr execution failed: ' + (error?.message || String(error)))
        }
      },
    }),
  )
}
