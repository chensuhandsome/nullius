# Native Windows installation diagnostic

Date: 2026-08-01

Status: initial diagnosis plus adaptation follow-up. `WIN-001` and `WIN-002` are now resolved and verified; `WIN-003` and `WIN-004` remain open and are outside the installation/recovery adaptation.

## Adaptation follow-up

Both `C:\Users\chensu\Documents\nullius` and `C:\Users\chensu\Documents\nullius - 副本` were confirmed to be at the same Chen Su commit (`5b1522fe`, with the Windows support commit `d76b2bd` immediately below it) and to contain the same pre-existing `verification.ts` worktree change. There was no missing commit to cherry-pick. The submitted Windows support was therefore completed in the active checkout and mirrored to the copy.

The follow-up added:

- a tested `pnpm install:cli` command that writes a managed source-checkout wrapper to `%APPDATA%\npm\nullius.cmd` on Windows or `~/.local/bin/nullius` on POSIX;
- refusal to overwrite an unrelated existing command unless `--force` is explicit;
- a Windows project-local `.cmd` launcher that skips itself and its extensionless sibling, prefers another `nullius` on `PATH`, and only then uses baked checkout paths;
- public documentation and anti-drift locks for the installation and recovery behavior.

The installed command now resolves as:

```text
C:\Users\chensu\AppData\Roaming\npm\nullius.cmd
```

`nullius --help`, initialization through the installed command, global `status --json`, and project-local `.nullius\bin\nullius.cmd status --json` all pass. The external smoke project used a path containing spaces and Chinese characters, and the project-local bin directory was placed first on `PATH` to exercise the self-skip branch.

The copy initially contained stale/copied `node_modules` links. Its first pnpm reinstall prompt did not complete in the non-interactive session, and the following build failed to find package-local `typescript/bin/tsc`. Refreshing only that checkout's dependency directories with `CI=true pnpm install --frozen-lockfile --force` restored a clean dependency graph; the copy then completed the full build, installer dry-run, 20 focused tests, and both anti-drift checks. This was checkout filesystem state rather than a Nullius source defect.

## Scope and references

This report follows the source-checkout installation path in the root `README.md` on native Windows (PowerShell 5.1 / `cmd.exe`), using:

- Windows 10.0.26200 x64
- Node.js 24.14.1
- npm 11.11.0
- Corepack 0.34.6
- pnpm 9.0.0
- Python 3.14.6
- Git for Windows 2.53.0

The current `README.md` and `C:\Users\chensu\Documents\nullius - 副本\README.md` were both read and compared. They are byte-for-byte identical (SHA-256 `FBD38305C44A0D172B6D94F28D41169DEF360E20BDC123F177A48A40EAB74981`).

Both commits authored by `chensu` were inspected:

- `d76b2bd07e1f4dab5129a3875f2d735fa0d528f7` — `fix: support native Windows nullius workflows`
- `5b1522fe96cb102a3448dce1d260f4d384d95b7f` — `update README: construction notes`

Commit `d76b2bd` already addressed several earlier Windows defects: it added the project-local `.cmd` launcher, selected `python` instead of `python3` on Windows in the generic computation/scaffold paths, made pnpm child-process launching Windows-safe, skipped unsupported parent-directory `fsync` on Windows, and normalized persisted path separators. Those changes were retained and passed the checks listed below. They are historical context, not unresolved issues in this report.

The pre-existing modification in `packages/orchestrator/src/orch-tools/verification.ts` was not changed and was excluded from the Windows diagnosis.

## Result summary

The dependency install, build, direct source CLI, HEP entry-point syntax check, Windows `.cmd` launcher, and targeted regression tests all succeed. The source checkout itself is therefore buildable on this machine.

At initial diagnosis the user-facing native-Windows installation was incomplete because the documented setup left no `nullius` command on `PATH`. The adaptation follow-up resolves that installation blocker and the related project-local portability gap. The secondary maintenance and Graphviz issues remain open.

## Issue disposition

### WIN-001 — Resolved: native-Windows installation now creates a `nullius` command

Initial severity: installation blocker for the documented global/front-door command.

Follow-up result: resolved by `pnpm install:cli`; the default `%APPDATA%\npm` target is on this machine's `PATH`, and `Get-Command nullius` plus `nullius --help` succeed.

Initial evidence:

1. The documented Windows sequence succeeds:

   ```text
   pnpm install --frozen-lockfile     -> exit 0
   pnpm -r build                      -> exit 0
   node .\packages\orchestrator\dist\cli.js --help -> exit 0
   node --check .\packages\hep-mcp\dist\index.js   -> exit 0
   ```

2. Immediately afterwards, `nullius --help` fails in PowerShell:

   ```text
   The term 'nullius' is not recognized as the name of a cmdlet,
   function, script file, or operable program.
   ```

3. No `nullius`, `nullius.cmd`, or `nullius.ps1` shim is created under the root or orchestrator `node_modules/.bin` directories.

4. `packages/orchestrator/package.json` declares a `nullius` bin, but the package is private and the root workspace does not expose/link that bin as an installed command.

5. The root README's only instruction for putting `nullius` on `PATH` is POSIX-specific (`mkdir`, `ln -sf`, and `chmod`). It appears after the native-Windows section and is not executable in a normal PowerShell/`cmd.exe` environment. No native `.cmd`/PowerShell wrapper installation procedure is given.

Impact:

- Commands later documented as `nullius init`, `nullius status`, and `nullius init --runtime-only` are unavailable outside an explicit `node <checkout>\packages\orchestrator\dist\cli.js ...` invocation or an already-initialized project's local launcher.
- The fallback command written into `.nullius/HARNESS` is `nullius status --json`, but that fallback is unavailable after the documented Windows setup.
- GUI/agent clients cannot be pointed at a stable global `nullius` command using the README alone.

No wrapper, link, global package, or `PATH` entry was created during this diagnosis.

### WIN-002 — Resolved: the Windows project-local launcher now prefers `PATH`

Initial severity: recovery/portability defect; it did not block the first smoke run.

Follow-up result: resolved for the intended portable recovery contract. The `.cmd` launcher now searches with `where nullius`, rejects its own `.cmd` path and extensionless sibling, invokes another `nullius` when available, and falls back to the baked paths only when no external command resolves. A Windows regression test proves that a distinct PATH wrapper is selected without recursion.

Observed generated launcher:

```bat
if not exist "C:\Program Files\nodejs\node.exe" (... exit /b 127)
if not exist "C:\Users\chensu\Documents\nullius\packages\orchestrator\dist\cli.js" (... exit /b 127)
"C:\Program Files\nodejs\node.exe" "C:\Users\chensu\Documents\nullius\packages\orchestrator\dist\cli.js" %* --project-root "%PROJECT_ROOT%"
```

The POSIX launcher generated in `packages/orchestrator/src/project-local-nullius.ts` first resolves a different `nullius` from `PATH` and only then falls back to baked absolute paths. The Windows branch in the same function contains only the baked-path checks and invocation; it has no corresponding `PATH` preference.

Impact (source-grounded inference):

- An initialized external project stops launching through `.nullius\bin\nullius.cmd` if the development checkout or Node executable moves.
- Installing a working `nullius` on `PATH` later does not rescue an older `.cmd` launcher whose baked paths are missing.
- This falls short of the portable/reconnect behavior described by the README and by the generated POSIX launcher's own comments.

The initial `.cmd` smoke was successful, including a project path containing spaces and Chinese characters. No checkout path was moved or removed to force the inferred failure.

### WIN-003 — Required maintenance commands remain POSIX-only

Severity: developer/acceptance blocker on native Windows; not a blocker for the initial `pnpm -r build`.

Confirmed failure:

```text
pnpm codegen:check
> bash meta/scripts/codegen.sh && ...
'bash' is not recognized as an internal or external command,
operable program or batch file.
```

`bash` and `sh` are not on this machine's `PATH`. This matters because repository governance requires `pnpm codegen:check` whenever `meta/schemas/` changes.

Related source-only finding: the `clean` script in nearly every workspace package is `rm -rf ...`. That command is likewise POSIX-specific when pnpm runs scripts through native Windows `cmd.exe`. It was not executed because it is destructive.

This issue is separate from the successful installation/build path, but it prevents the documented repository acceptance workflow from being fully native-Windows compatible.

### WIN-004 — Graphviz availability detection uses the Unix-only `which` command

Severity: post-install feature defect affecting PNG/SVG graph rendering.

`packages/shared/src/graph-viz/graphviz.ts` checks Graphviz with:

```ts
spawnSync('which', ['dot'], { encoding: 'utf8' })
```

Native Windows does not provide `which`; its conventional command lookup is `where.exe`. Therefore `isDotAvailable()` returns false on native Windows before attempting `dot`, even when a `dot.exe` installation is available on `PATH`.

Impact: `nullius graph --format png` and `--format svg` can incorrectly warn that Graphviz is missing and emit only DOT output.

This machine does not currently have Graphviz installed, so the false-negative-with-`dot.exe` case was identified from the direct source path rather than reproduced by altering the machine installation.

## Non-blocking observations

- `pnpm install --frozen-lockfile` emits Node's `[DEP0169]` warning because pnpm 9 uses deprecated `url.parse()` behavior under Node 24. The install still exits successfully; this is not classified as a Nullius installation blocker.
- The documented skill set resolves successfully with `install_skill.py --dry-run`. It reports that `research-team` also needs `literature-workflows`, while `pdg-lookup` and `zotero-import` need `hep-mcp`; those non-skill dependencies must be configured separately. No skills were installed or overwritten during this phase.
- PDG SQLite and Zotero were not configured. They are optional provider capabilities and are outside the base CLI build result.

## Successful checks

```text
pnpm install --frozen-lockfile
pnpm -r build
node .\packages\orchestrator\dist\cli.js --help
node --check .\packages\hep-mcp\dist\index.js
nullius init smoke via node against an external temporary project root
.nullius\bin\nullius.cmd status --json
skill installation dry-run for all README-listed skills
```

Targeted tests:

```text
@nullius/orchestrator:
  3 test files passed
  220 tests passed, 8 skipped

@nullius/shared:
  2 test files passed
  56 tests passed
```

The temporary lifecycle smoke project was intentionally created outside the development repository, under `%TEMP%`, in accordance with the repository's project-root rules.

## Initial diagnostic-phase boundaries

The following statements describe the first diagnosis phase, before the adaptation follow-up:

- No source defect was fixed.
- No Windows global wrapper or `PATH` entry was created.
- No skills were installed.
- No PDG database or Zotero integration was configured.
- No existing user source modification was altered.

## Follow-up verification

```text
pnpm -r build                                           -> passed
pnpm install:cli                                        -> passed
nullius --help                                          -> passed
external nullius init/status smoke                      -> passed
project-local Windows PATH self-skip smoke              -> passed
check-shell-boundary-anti-drift.mjs                     -> passed
check-portable-paths-anti-drift.mjs                     -> passed
orchestrator targeted suite                             -> 224 passed, 8 skipped
hep-mcp docToolDrift                                    -> 15 passed
copy full build                                         -> passed
copy installer dry-run                                  -> passed
copy focused Windows/installer tests                    -> 20 passed
```

The pre-existing `packages/orchestrator/src/orch-tools/verification.ts` change remains untouched as user-owned work.
