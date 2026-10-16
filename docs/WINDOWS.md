# Native Windows

Use PowerShell with native Node and Python, plus Git for Windows Bash for the
checked-in shell runners and code generation. The development baseline is
Node 22, pnpm 9.0.0 and Python 3.11. Keep research projects outside the checkout.

## Source installation

Install Node, Python and Git for Windows, and select the intended Node version
in PowerShell. Create a dedicated Python environment:

```powershell
py -3.11 -m venv "$env:LOCALAPPDATA\Nullius\python"
$env:NULLIUS_PYTHON = "$env:LOCALAPPDATA\Nullius\python\Scripts\python.exe"
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
& $env:NULLIUS_PYTHON -m pip install -r meta/scripts/codegen-requirements.txt pytest pyyaml pydantic uv
pnpm -r build
.\scripts\install-windows-runtime.ps1 -PythonPath $env:NULLIUS_PYTHON -Persist
nullius --help
nullius runtime path
```

The installer creates managed `nullius.ps1` and `nullius.cmd` entries under
`~/.local/bin`, backing up an existing entry. It adds a Bash `python3` bridge to
the selected native interpreter. `-Persist` saves that interpreter and appends
the user bin, Git Bash and Python scripts directories to the user environment.
Restart GUI agent clients after installation. `-NodePath`, `-PythonPath` and
`-BinDir` select absolute local paths. Existing tool installations are retained.

PowerShell should use `nullius` or the `.ps1` entry. `.cmd` is for cmd.exe;
PowerShell 5.1 can reinterpret metacharacters before a batch file receives them.
The PowerShell launcher preserves empty arguments, JSON quotes, Unicode and
literal metacharacters. It streams text/JSON through the PowerShell pipeline,
including assignment and `ConvertFrom-Json`, and preserves the exit status.
Use the native Node CLI or project-local `nullius.cjs` entry for byte-stream
consumers; PowerShell 5.1's text pipeline is not a binary transport.

Install the SQLite command-line tools from [SQLite](https://www.sqlite.org/download.html)
and add their directory to PATH for memory-graph-backed execution. Graphviz
`dot.exe` is needed for SVG/PNG graph rendering; DOT output remains available
without it. Native export uses the selected Python's standard ZIP library to
preserve Unicode entry names; POSIX export keeps `zip`. Model CLIs, scientific runtimes, provider
data and credentials retain their upstream prerequisites.

## External project and reconnect

```powershell
$project = Join-Path $env:LOCALAPPDATA 'Nullius\example-project'
nullius init --project-root $project --mode engine
& "$project\.nullius\bin\nullius.ps1" status --json
nullius init --project-root $project --runtime-only
& "$project\.nullius\bin\nullius.ps1" status --json
```

Choose `--mode file` for the existing file-mode workflow. Runtime-only refresh
repairs launchers and the handshake; it does not update user-owned project
instructions or rewrite historical runs. The launcher prefers its baked
compatible CLI, then the first compatible managed PATH entry. An unmanaged,
stale or self-referencing first entry is refused.

Configure MCP hosts with an absolute Node executable and built CLI arguments
`runtime mcp <server>` when they cannot launch PowerShell commands. Keep runtime
configuration and credentials outside the distribution. Copy-installed skills
include the same Windows support modules and must be refreshed after changes;
compare customized installations before replacing them.

## Platform guarantees and checks

Local Windows files use flushed file data and atomic replacement. Windows does
not provide the POSIX parent-directory fsync guarantee used on Linux/macOS, so
successful replacement does not assert equivalent power-loss durability.
Protected contract writes retain checked file identity, ACLs and parent-directory
protection; unsupported protection fails closed. Use a local NTFS workspace for
the native acceptance suite.

Transient MCP and reviewer subprocesses use Windows Job Objects with enrollment
at creation and owned-tree cleanup. Durable project deliveries have separate
ownership: they survive transport disconnect and retain independent deadlines.
Jobs control lifecycle; they do not sandbox trusted local programs. Computation
keeps its upstream direct-child limits and executable-byte approval binding.

Retain Ubuntu CI and run the Windows CI job. Native checks cover launcher
arguments and reconnect, protected writes, path/junction boundaries, process
cleanup, durable-delivery handoff, copied assets and executable identity.
File-symlink tests require the corresponding Windows privilege; native junction
and hardlink cases exercise available alias boundaries independently.

Independent reproduction materializes committed Git symlinks with
`core.symlinks=true`. Those projects require Windows symlink privilege or
Developer Mode; unavailable link support produces `environment_failed` rather
than substituting plaintext files for the committed links. Copy isolation
refuses symlink and junction inputs.

Run `pnpm codegen:check` with Git Bash and the selected Python scripts directory
on PATH; generated Python uses canonical LF on every platform. Rebuild after
changes and verify `nullius --help` before reconnecting external projects.
