# Package lifecycle

## Dependency and environment policy

Keep `Project.toml` authoritative for package name, UUID, version, direct
dependencies, weak dependencies and compatibility. Add dependencies through Pkg
when possible, check resulting changes, and avoid runtime `Pkg.add`/`activate` in
library source. List test/docs/benchmark imports in their actual environments.

Use compatibility ranges reflecting supported releases, including the Julia
floor. Confirm lower bounds by resolving and testing an appropriate environment;
the default resolver choosing a recent release does not exercise the minimum.
Do not derive a compatibility range mechanically from one installed version.

Version-sensitive features, checked against official documentation on 2026-10-13:

| Feature | Julia floor | Consequence |
|---|---|---|
| Native weak dependencies and package extensions | 1.9 | Test the core and triggered extension separately. |
| `public` keyword and `[sources]` | 1.11 | Do not introduce them unconditionally in a package supporting earlier releases. |
| Pkg workspaces | 1.12 | New packages meeting this floor can use the current recommended workspace test layout. |

For a lower declared floor, use a supported test environment/target layout and
explicit `Pkg.develop` for local docs/bench sources as needed. Do not raise the
Julia floor solely to satisfy this table. Recheck official docs before changing
policy. In workspaces, child environments declare their own imports and parent
package dependency; root dependencies are not automatically available to them.

A package's root Manifest is not a contract imposed on downstream consumers.
For libraries, choose whether to track development manifests according to project
policy; CI should also resolve against declared compat. For applications and
reproduction workloads, retain the actual selected manifest, Julia version and
source identity. Respect version-specific manifests if used. Local path sources
can be appropriate during development but do not establish portable installation.
Test the intended registry, URL, monorepo or explicit local-develop route in a
fresh environment, without a hidden global environment.

Use package artifacts/JLL infrastructure for distributed native resources and
Scratch for disposable managed caches when appropriate. Important user output
belongs at a caller-selected path. Builds, tests and importing a package should
not modify installed package source.

## Tests and CI

Create focused regressions through public entrypoints; verify a numerical change
against an independent reference appropriate to its scope. Cover invalid input,
termination/fallback behavior, mutation/aliasing, cache reuse/invalidation and
non-default settings when touched. A larger test count is not itself stronger
evidence. Reserve expensive tests for their appropriate lane and keep cheap
structural or exact cases available during development.

For dependency/API/release work, CI should cover the supported minimum and
current stable Julia, meaningful OS/backends and changed extensions. Nightly is
optional early warning, not a substitute for supported-version checks. Include a
bounds-enabled run for unsafe-indexing changes. Separate numerical regressions
from timing comparisons on shared CI hosts.

Use Aqua's targeted checks (ambiguities, stale deps, compat, piracy, unbound type
parameters and others) where applicable; record narrowly justified exclusions.
Use JET on selected supported entrypoints and inspect reports for their runtime
and tool-version limitations. No universal zero-warning requirement applies to
intentional dynamic setup or heterogeneous orchestration.

## Documentation and release

Provide a minimal executable public example plus docstrings for assumptions,
inputs, outputs, failure/status behavior and supported representations. Keep
examples consistent with current source. Develop the checkout into the docs
environment before building so an installed older release cannot supply the
documented definitions. Use Documenter doctests and missing-doc checks as useful
evidence, accounting for floating-point and platform variation deliberately.

Release checks include clean supported-environment installation, required tests,
docs against the candidate source, optional integration checks, license and
accurate version/compat metadata. Keep benchmark evidence only for actual
performance claims. Update migration notes when public behavior changes; follow
the project's current compatibility policy rather than inventing legacy shims.
Registrator/TagBot or publishing automation is a separate authorized action.
