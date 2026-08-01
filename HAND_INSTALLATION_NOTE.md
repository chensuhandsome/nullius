# Nullius Manual Installation Note

This is a Windows-first guide for installing Nullius from source and preparing
it for HEP-th research. It is written for a new user who does not already have
the old `autoresearch-lab` setup.

> **Naming:** `autoresearch-lab` was the former project name. Current commands,
> directories, environment variables, and generated launchers use `nullius`.
> Do not copy the legacy names or Windows workarounds from older notes.

The canonical source of truth is the current [README](./README.md). This note
turns that information and the historical `hep-th-autoresearch-usage-plan.md`
workflow into a copyable installation sequence.

## 1. Understand the three parts

Nullius has three installation layers:

1. **Nullius CLI** — required. It initializes and manages external research
   projects.
2. **Agent skills** — recommended for Codex, Claude Code, Kimi Code, or
   OpenCode. They teach an agent the research workflow.
3. **HEP MCP server** — recommended for HEP work. It provides literature,
   evidence, PDG, Zotero, HEPData, arXiv, and related tools.

Install and verify the CLI first. Skills, PDG, and Zotero can be added later.

## 2. Prerequisites

Install these before cloning Nullius:

| Requirement | Required version or purpose |
| --- | --- |
| Git | Clone and update the source repository |
| Node.js | Version 20 or newer |
| Corepack | Activates the repository's pinned pnpm version |
| Python | Version 3.9 or newer; `python` must work in PowerShell |
| PowerShell | Used by the Windows commands below |

Check the commands in a new PowerShell terminal:

```powershell
git --version
node --version
corepack --version
python --version
```

The Node version must be at least 20. Python must be at least 3.9. On Windows,
Nullius project initialization uses `python` by default, while the skill
installer can be launched with the Windows `py` launcher.

SQLite's command-line program, Zotero Desktop, and an MCP-compatible agent
client are optional. They are only needed for the corresponding sections
below.

## 3. Clone and build Nullius

Nullius is currently a source workspace, not a published global npm CLI. Keep
the source checkout as tooling only; do not use it as a real research project.

The following example puts the checkout under `Documents`:

```powershell
$nulliusSource = Join-Path $env:USERPROFILE "Documents\nullius"
git clone https://github.com/fkguo/nullius.git $nulliusSource
Set-Location $nulliusSource
```

If the repository is already cloned, only run `Set-Location` with its actual
path.

Install dependencies and build every workspace package:

```powershell
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
pnpm -r build
```

Install the managed user-local CLI wrapper and verify both main entrypoints:

```powershell
pnpm install:cli
Get-Command nullius
nullius --help
node --check .\packages\hep-mcp\dist\index.js
```

On Windows, `pnpm install:cli` normally writes:

```text
%APPDATA%\npm\nullius.cmd
```

If the installer reports that this directory is not on `PATH`, add
`%APPDATA%\npm` to the user `PATH`, open a new terminal, and rerun
`nullius --help`. The installer refuses to overwrite an unmanaged command;
inspect any existing `nullius.cmd` before considering
`pnpm install:cli -- --force`.

## 4. Verify initialization on Windows

Use a disposable project outside the source checkout:

```powershell
$smoke = Join-Path $env:TEMP ("nullius-smoke-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Force -Path $smoke | Out-Null
nullius --project-root $smoke init
& "$smoke\.nullius\bin\nullius.cmd" status --json
```

A successful initialization creates at least:

```text
.nullius\HARNESS
.nullius\state.json
.nullius\bin\nullius
.nullius\bin\nullius.cmd
AGENTS.md
research_contract.md
research_plan.md
```

The status command should return JSON and report a healthy project-local
launcher. The `.nullius\bin\nullius.cmd` launcher is the normal Windows
recovery entrypoint for an initialized project.

## 5. Install the research skills (recommended)

Run this from the Nullius source checkout. Change `$platform` if necessary;
supported values are `codex`, `claude_code`, `kimi_code`, and `opencode`.

```powershell
$platform = "codex"
$skillInstaller = ".\packages\skills-market\scripts\install_skill.py"
$skillArgs = @(
  "--platform", $platform,
  "--source-root", ".",
  "--package", "research-harness",
  "--package", "research-team",
  "--package", "markdown-hygiene",
  "--package", "research-integrity",
  "--package", "hep-calc",
  "--package", "pdg-lookup",
  "--package", "zotero-import",
  "--package", "research-writer",
  "--package", "paper-reviser",
  "--package", "referee-review"
)

py $skillInstaller @skillArgs --dry-run
py $skillInstaller @skillArgs
```

The dry run shows the planned destinations before anything is copied. Do not
add `--force` unless you have reviewed existing installed skills and intend to
replace them. If the `py` launcher is unavailable, replace `py` with `python`.
Restart the agent client after installation.

The most important entry skill is `research-harness`. It recovers project
state, routes milestone work to `research-team`, routes HEP work to `hep-mcp`,
and folds durable conclusions back into the project.

## 6. Configure the HEP MCP server (recommended for HEP)

First create a per-user scratch area:

```powershell
$hepData = Join-Path $env:USERPROFILE ".nullius\hep-mcp"
New-Item -ItemType Directory -Force -Path $hepData,(Join-Path $hepData "downloads") | Out-Null
```

Add a local stdio MCP server to the configuration used by your agent client.
Replace every example path with an absolute path on your machine. JSON requires
escaped backslashes, so forward slashes are easier on Windows:

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "C:/Users/YOU/Documents/nullius/packages/hep-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "C:/Users/YOU/.nullius/hep-mcp",
        "HEP_TOOL_MODE": "standard",
        "HEP_DOWNLOAD_DIR": "C:/Users/YOU/.nullius/hep-mcp/downloads"
      }
    }
  }
}
```

For Codex, put the equivalent TOML in
`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.hep-mcp]
command = "node"
args = ['C:\Users\YOU\Documents\nullius\packages\hep-mcp\dist\index.js']
env = { HEP_DATA_DIR = 'C:\Users\YOU\.nullius\hep-mcp', HEP_TOOL_MODE = 'standard', HEP_DOWNLOAD_DIR = 'C:\Users\YOU\.nullius\hep-mcp\downloads' }
```

Use the JSON form for clients whose MCP settings use
`mcpServers`, including Kiro's user-level
`%USERPROFILE%\.kiro\settings\mcp.json`. Other clients may use a different
configuration filename but the same stdio command, arguments, and environment.

Restart the client after saving its MCP configuration. If the client cannot
launch bare `node`, replace `"node"` with the absolute path reported by:

```powershell
(Get-Command node).Source
```

When the client connects, call `hep_health`. A basic installation does not
need PDG or Zotero. Add those integrations only if you use them.

For durable HEP work, pass the initialized external `project_root` to HEP tool
calls so artifacts are written under that project. `HEP_DATA_DIR` is the
per-user scratch fallback, not the authority for a real research project.

## 7. Add the PDG database (optional)

Download the PDG all-data SQLite release into the HEP data root:

```powershell
$hepData = Join-Path $env:USERPROFILE ".nullius\hep-mcp"
$pdgDir = Join-Path $hepData "pdg"
$pdgDb = Join-Path $pdgDir "pdgall-2026.0.sqlite"
New-Item -ItemType Directory -Force -Path $pdgDir | Out-Null
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://pdg.lbl.gov/2026/api/pdgall-2026.0.sqlite" `
  -OutFile $pdgDb
Test-Path $pdgDb
```

If the `sqlite3` command is installed, verify the file:

```powershell
sqlite3 $pdgDb "select * from pdginfo limit 5;"
```

Add these variables to the `hep-mcp` environment in the MCP configuration,
using absolute paths:

```json
"PDG_DATA_DIR": "C:/Users/YOU/.nullius/hep-mcp/pdg",
"PDG_DB_PATH": "C:/Users/YOU/.nullius/hep-mcp/pdg/pdgall-2026.0.sqlite"
```

Restart the client and call `pdg_info`.

## 8. Add Zotero (optional)

Start Zotero Desktop and check its local connector:

```powershell
curl.exe http://127.0.0.1:23119/connector/ping
```

The expected response is `Zotero is running`. Then add these variables to the
`hep-mcp` environment, changing the Zotero data path if necessary:

```json
"HEP_ENABLE_ZOTERO": "1",
"ZOTERO_BASE_URL": "http://127.0.0.1:23119",
"ZOTERO_DATA_DIR": "C:/Users/YOU/Zotero"
```

Restart the client after editing the configuration.

## 9. Create the first real research project

Never initialize the Nullius source checkout as a real project. Create an
external directory instead:

```powershell
$project = "D:\Research\my-hep-topic"
New-Item -ItemType Directory -Force -Path $project | Out-Null
nullius --project-root $project init
& "$project\.nullius\bin\nullius.cmd" status --json
```

For an unclear or exploratory topic, enter the project and create a durable
brainstorm plan:

```powershell
Set-Location $project
nullius workflow-plan `
  --recipe research_brainstorm `
  --run-id 20260801T120000Z-m0-topic-r1 `
  --topic "Describe the research topic here"
```

Use a new readable run ID for real work. Durable conclusions and provenance
belong in:

```text
research_contract.md
research_plan.md (especially Current Status)
artifacts\runs\<run_id>\
```

At the start of a later session, recover state before doing new work:

```powershell
.\.nullius\bin\nullius.cmd status --json
```

## 10. Updating an installation

From the source checkout:

```powershell
git pull --ff-only
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
pnpm -r build
nullius --help
```

The user-local wrapper points at this checkout's built CLI, so rebuilding is
normally enough. Rerun `pnpm install:cli` if the checkout was moved or the
wrapper target changed. Existing project scaffold documents are not updated
automatically; preview and apply an intentional refresh from the project root:

```powershell
nullius init --refresh --dry-run
nullius init --refresh
```

## 11. macOS and Linux differences

The build sequence is the same:

```bash
corepack prepare pnpm@9.0.0 --activate
pnpm install --frozen-lockfile
pnpm -r build
pnpm install:cli
nullius --help
node --check ./packages/hep-mcp/dist/index.js
```

The managed CLI is normally installed at `~/.local/bin/nullius`; add
`~/.local/bin` to `PATH` if the installer reports it is missing. Use `python3`
instead of Windows `py` for the skill installer. Initialized projects use
`.nullius/bin/nullius` rather than the Windows `.cmd` companion.

## 12. Troubleshooting

| Symptom | What to check |
| --- | --- |
| `nullius` is not recognized | Run `pnpm install:cli`, check `%APPDATA%\npm` on `PATH`, then open a new terminal. |
| `packages\...\dist` is missing | Run `pnpm install --frozen-lockfile` and `pnpm -r build` in the source checkout. |
| `python` cannot be launched during `init` | Install Python 3.9+ with `python.exe` on `PATH`, or set `NULLIUS_PYTHON` to the absolute interpreter path for the current session. |
| MCP server is disconnected | Rebuild, check the absolute `dist\index.js` path, and use the absolute Node executable path if needed. |
| `pdg_info` says the database is not configured | Check `PDG_DB_PATH`, `PDG_DATA_DIR`, and that the SQLite file exists. |
| Zotero tools fail | Keep Zotero running and verify `http://127.0.0.1:23119/connector/ping`. |
| An old note suggests `python3.cmd`, a `NODE_OPTIONS` fsync shim, or a hand-written project launcher | Do not install those legacy workarounds. Rebuild the current Nullius checkout and retry. |

## Legacy-name translation

Use this table when reading historical `autoresearch-lab` notes:

| Historical name | Current Nullius name |
| --- | --- |
| `autoresearch-lab` source clone | `nullius` source checkout |
| `autoresearch` CLI | `nullius` CLI |
| `.autoresearch` project state | `.nullius` project state |
| `.autoresearch\bin\autoresearch.cmd` | `.nullius\bin\nullius.cmd` |
| `~/.autoresearch/hep-mcp` | `~/.nullius/hep-mcp` |
| `AUTORESEARCH_PYTHON` | `NULLIUS_PYTHON` |
| direct copying from an old `skills` directory | `packages/skills-market/scripts/install_skill.py` |

Do not mechanically rename an old generated project in place. For a new user,
initialize a fresh external project with the current `nullius init` command.
