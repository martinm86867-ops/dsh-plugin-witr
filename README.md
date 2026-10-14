<div align="center">

# `dsh-plugin-witr`

**The causal process & port tracing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/Harness-Cordis%20v3-indigo.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![witr Engine](https://img.shields.io/badge/Engine-witr%20v0.3.4-emerald.svg?style=flat-square)](https://github.com/martinm86867-ops/witr)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<p align="center">
  <b>Gives autonomous DeepSeek agents instant root-cause visibility into running processes, port collisions (<tt>EADDRINUSE</tt>), and stuck file locks.</b>
</p>

</div>

---

## The Problem

Autonomous agents frequently stall during development or operational loops when encountering state conflicts:
- A local dev server fails to start with `EADDRINUSE: 3080`.
- An environment command hangs because `/var/lib/dpkg/lock-frontend` is locked.
- A long-lived background worker holds memory, but `ps aux` only shows an uninformative child process without context.

Standard agent workarounds—chaining `ps aux`, `lsof`, `fuser`, `netstat`, and `kill -9`—are fragile, hallucination-prone, and risk accidentally terminating the parent terminal or shell.

## The Solution

`dsh-plugin-witr` wires [`witr`](https://github.com/martinm86867-ops/witr) directly into the DeepSeek Harness tool registry via the **Cordis** plugin lifecycle. 

Instead of guessing, the agent calls `witr_trace` to receive the complete supervisor hierarchy from `systemd` down through terminal emulators, shells, and parent containers in a single deterministic turn.

```mermaid
graph TD
  A[DeepSeek Agent Loop] -->|witr_trace tool call| B[dsh-plugin-witr]
  B -->|Cordis Effect / AbortSignal| C[witr Causal Engine]
  C -->|Procfs & Netstat Inspection| D[Linux Kernel / Sockets]
  D -->|Root Cause Tree + Metadata| C
  C -->|Formatted Tree / Mermaid / JSON| B
  B -->|Structured Result Block| A
```

---

## Features

- **Full Causal Ancestry:** Traces processes backwards through `systemd -> ptyxis -> bash -> node -> esbuild` to pinpoint what launched and maintains the target.
- **Port Collision Resolution:** Translates port numbers (e.g. `3080`, `8080`) directly into the owning PID, parent shell, working directory, and active Git branch.
- **File Lock Diagnostics:** Pinpoints which background process or daemon holds open a file descriptor.
- **Multi-Format Projection:** Supports human-readable diagnostic text, compact hierarchical trees, JSON, and **Mermaid.js flowchart diagrams** for visual documentation. JSON output omits process environment variables, so tracing a process never copies its secrets into the model context.
- **DeepSeek Plugin Manager UI:** Fully declared Cordis bundle with localized metadata, an icon, and configurable runtime parameters in the Web UI.
- **Exit-Code Fidelity:** Classifies every trace from `witr`'s documented exit codes instead of scraping its output, so warnings, "not found", and "insufficient privileges" arrive as answers and only genuinely broken runs fail the call.
- **Cancellation & Safety:** Strictly read-only; forwards `exec.signal` to the `witr` subprocess and reports a cancelled call as cancelled rather than as a failure.

---

## Installation

### Prerequisites

Ensure the `witr` binary is installed in your system PATH (e.g. `/usr/local/bin/witr`):

```bash
# Verify witr binary
witr --version
```

### Method 1: Add via DeepSeek CLI
```bash
dsh plugin --profile web add @deepseek-ai/dsh-experimental-tool-witr
```

### Method 2: Profile Mount (`cordis.patch.yml`)
Add an `- insert:` entry to your active profile patch file (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: tool-witr
      name: "@deepseek-ai/dsh-experimental-tool-witr"
      config:
        binaryPath: witr
        timeoutMs: 10000
```

---

## Model Tool Specification: `witr_trace`

When mounted, DeepSeek models gain access to the following tool schema:

```typescript
witr_trace({
  target: string,                            // Port ("3080"), PID ("1234"), name ("node"), or file path
  kind?: "port" | "pid" | "file" | "name",   // Explicit discriminator; inferred when omitted
  format?: "standard" | "tree" | "mermaid" | "dot" | "json",
  exact?: boolean                            // Disable substring matching when searching by name
})
```

`kind`, `format`, and `target` are validated before `witr` runs, so an out-of-vocabulary
`kind` or `format` is rejected instead of silently ignored.

**Target inference.** With no `kind`, a bare number is tried as a process ID first and then as a
port, a value containing `/` is treated as a file path, and anything else is a process name. Non-empty
targets are passed to `witr` after a `--` terminator, so a process name that begins with `-` is never
misread as a command-line flag.

**Working directory.** A relative `file` target is resolved against the calling session's working
directory rather than the directory the harness process was launched from.

**Concurrency.** The tool is read-only, so it is marked concurrency-safe and several traces may share
one tool batch.

### Outcomes

The plugin reads [`witr`'s exit codes](https://github.com/pranshuparmar/witr#72-exit-codes) rather
than matching output text — witr documents the codes as the contract and the wording of its
human-readable output as explicitly outside it. Only the outcomes that carry no answer fail the tool
call:

| `witr` exit | Meaning | Tool result |
| :--- | :--- | :--- |
| `0` | Found, clean | Answer |
| `1` | Found, with warnings | **Answer** — warnings are the diagnostic payload |
| `2` | Not found | Answer; also drives the PID → port fallback |
| `3` | Insufficient privileges | Answer — witr's own output says how to escalate |
| `4` | Invalid input, or an ambiguous name | Error; retry with `exact: true` or a fuller name |
| `5` | Internal error | Error |
| `6` | Found, but the cause can't be traced | **Answer** |
| — | `witr` could not be started at all | Error naming `binaryPath` |

The canonical result is structured — `{ output, format, exitCode, warnings? }` — with `output` as
the model-facing projection. `warnings` is populated when `format: "json"` supplies witr's documented
`Warnings` array, and the exit code and warning count travel to the UI as presentation metadata.

### Example Agent Interactions

#### 1. Diagnosing an In-Use Port
**Agent call:**
```json
{
  "name": "witr_trace",
  "arguments": {
    "target": "3080",
    "kind": "port"
  }
}
```

**Tool output:**
```text
Target      : node
Process     : node (pid 9056) {forked}
User        : martin
Command     : node --import tsx/esm apps/cli/src/bin.ts web
Started     : 1 hour ago (Wed 2026-10-14 10:05:05 +01:00)

Why It Exists :
  systemd (pid 1) → systemd (pid 4297) → ptyxis (pid 6407) → ptyxis-agent (pid 6421) → bash (pid 9030) → node (pid 9040) → sh (pid 9055) → node (pid 9056)

Source      : sh (shell)
Working Dir : /home/martin/deepseek
Git Repo    : deepseek (master)
Sockets     : 127.0.0.1:3080 (TCP | LISTENING, 2 connections)
```

#### 2. Generating a Visual Markdown Architecture Diagram
**Agent call:**
```json
{
  "name": "witr_trace",
  "arguments": {
    "target": "3080",
    "format": "mermaid"
  }
}
```

**Tool output:**
```mermaid
graph TD
  p1["systemd (pid 1)"]
  p4297["systemd (pid 4297)"]
  p1 --> p4297
  p6407["ptyxis (pid 6407)"]
  p4297 --> p6407
  p6421["ptyxis-agent (pid 6421)"]
  p6407 --> p6421
  p9030["bash (pid 9030)"]
  p6421 --> p9030
  p9056["node (pid 9056) :3080"]
  p9030 --> p9056
  style p9056 fill:#2ecc71,stroke:#27ae60,stroke-width:2px,color:#ffffff
```

---

## Configuration Schema

Configured via Cordis YAML or the DeepSeek Web Settings UI:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `binaryPath` | `string` | `"witr"` | Path to the `witr` binary. |
| `timeoutMs` | `number` | `10000` | Subprocess execution timeout in milliseconds. |

---

## Development & Building

```bash
# Install dependencies
pnpm install

# Typecheck the source and test suite
pnpm run typecheck

# Compile TypeScript
pnpm run build

# Run unit tests (Vitest)
pnpm run test
```

---

## License

[MIT](LICENSE) © 2026 Martin M
