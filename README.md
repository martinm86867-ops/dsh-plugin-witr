# dsh-plugin-witr

Official DeepSeek Harness (`dsh`) plugin providing model-facing `witr_trace` tools for process, port, container, and file lock causal tracing.

Traces processes back through systemd units, containers, process groups, supervisors, and shells to explain **why** a target is running.

## Features

- **Process Lineage:** Traces any PID back to its root supervisor (`systemd -> ptyxis -> bash -> node`).
- **Port Collision Resolution:** Traces listening ports (e.g. `:3000`, `:8080`) to the owning process and parent shell.
- **File Lock Diagnostics:** Identifies which background service or process holds a lock on a file.
- **Multiple Output Formats:** Emits standard text, compact tree, Mermaid.js diagrams, Graphviz DOT, or raw JSON.
- **DeepSeek Plugin Manager Integration:** Fully recognized by the DeepSeek Harness Web Plugin Manager with configuration options.

## Installation into DeepSeek Harness

### Method A: Via DeepSeek CLI
```bash
dsh plugin --profile web add /home/martin/system/dsh-plugin-witr
```

### Method B: Profile Configuration (`cordis.patch.yml`)
Add to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: tool-witr
      name: "dsh-plugin-witr"
      config:
        binaryPath: witr
        timeoutMs: 10000
```

## Model Tool: `witr_trace`

Agents in DeepSeek Harness can call `witr_trace` natively:

- **Investigate Port:** `witr_trace(target: "3080", kind: "port")`
- **Investigate PID:** `witr_trace(target: "9056", kind: "pid")`
- **Investigate Lock:** `witr_trace(target: "/var/lib/dpkg/lock-frontend", kind: "file")`
- **Generate Mermaid Diagram:** `witr_trace(target: "3080", format: "mermaid")`

## License

MIT
