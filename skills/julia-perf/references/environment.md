# Environment Contract

## Minimum Runtime

- Julia: `>= 1.10`

## Package Contract

Required packages:
- `BenchmarkTools`
- `JSON3`

Recommended packages:
- `JET`

## Bootstrap

From the skill directory:

```bash
julia --project=scripts -e 'using Pkg; Pkg.instantiate()'
```

Use the environment that actually loads the candidate package and benchmark
dependencies. Instantiate before running measurements; the runner does not add,
resolve, or mutate dependencies. For a package-specific benchmark environment,
declare `BenchmarkTools` and `JSON3` there and use `--project` for that environment.

## Diagnostic boundary

The runner collects Trials and comparisons. It does not invoke `JET`,
`@code_warntype`, or implementation-identity checks. Capture those separately
for the declared hotpaths when a performance claim needs them. Missing external
diagnostics must not be represented as an automated pass.

## Determinism Notes

- Retain the resolved manifest used by the benchmark process. The runner records
  its hash, active project hash, Julia binary/sysimage/options/version, BenchmarkTools
  version, dependencies (including all non-candidate path-dependency files,
  excluding `.git`),
  Julia default/interactive thread pools, actual GC threads and requested GC
  settings, BLAS implementation/threads, machine, OS, architecture, and CPU.
- Candidate source changes are recorded separately and permitted across a
  comparison. Other protocol/input/runtime/hardware/dependency changes make a
  baseline incomparable.
- Manifest selection follows Julia's actual read-only loader helper, including
  explicit manifest paths, version-specific filenames and workspace roots. A
  runtime without that selector fails explicitly instead of guessing a manifest.
- The supervisor passes the active project and Julia runtime options to its
  child. Its hard worker deadline covers startup, loading, compilation, warmup,
  and measurement; supervisor imports occur before the deadline starts.
- `--startup-file=no` avoids implicit startup customizations. For sandboxed
  tests, `--compiled-modules=no` permits reading an existing depot without
  writing precompile caches. Such runtime options are part of comparability.
