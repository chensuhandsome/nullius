# Primary sources and selection

Checked 2026-10-13. These links support the technical facts; the skill's acceptance
and workflow requirements are a synthesis, not a claim that each source mandates
the entire policy. `v1`, `stable`, `latest` and branch links move: consult the docs
matching the target runtime before changing version-dependent behavior.

## Language and package management

| Source | What to consult |
|---|---|
| [Julia Style Guide](https://docs.julialang.org/en/v1/manual/style-guide/) | Generic arguments, mutation naming, accessors, owned types and piracy. |
| [Julia Interfaces](https://docs.julialang.org/en/v1/manual/interfaces/) | Required methods for iteration, indexing and custom arrays. |
| [Julia Modules](https://docs.julialang.org/en/v1/manual/modules/) | Definition ownership, relative imports, exports/public names and runtime initialization. |
| [Julia Code Loading](https://docs.julialang.org/en/v1/manual/code-loading/) | Extension triggers, dependency lookup, entrypoints and manifest-mediated loading. |
| [Julia 1.11 release notes](https://docs.julialang.org/en/v1.11/NEWS/#Language-changes) | Version-specific restrictions on extension precompile dependency cycles. |
| [Julia Performance Tips](https://docs.julialang.org/en/v1/manual/performance-tips/) | Function barriers, concrete fields, layout, fusion tradeoffs, views/copies and compilation costs. |
| [Bounds checking](https://docs.julialang.org/en/v1/devdocs/boundscheck/) | Unsafe consequences of one-based assumptions under `@inbounds`. |
| [Multi-threading](https://docs.julialang.org/en/v1/manual/multi-threading/) | Task migration, buffer ownership, races and scheduling restrictions. |
| [Numbers](https://docs.julialang.org/en/v1/base/numbers/) and [Julia 1.12.6 MPFR source](https://github.com/JuliaLang/julia/blob/v1.12.6/base/mpfr.jl) | Distinguish global setters from version-specific scoped function forms. |
| [Scoped Values](https://docs.julialang.org/en/v1/base/scopedvalues/) | Dynamic scope inheritance by tasks, distinct from distributed workers. |
| [Random](https://docs.julialang.org/en/v1/stdlib/Random/) | Explicit RNGs and the limits of cross-version stream reproducibility. |
| [Pkg: Creating Packages](https://pkgdocs.julialang.org/v1/creating-packages/) | Layout, test environments, weak dependencies, extensions and managed caches. |
| [Pkg: TOML files](https://pkgdocs.julialang.org/v1/toml-files/) | Project versus Manifest authority, sources and workspace version requirements. |
| [Pkg: Compatibility](https://pkgdocs.julialang.org/v1/compatibility/) | Version-range meaning, including pre-1.0 semver. |
| [Julia 1.11 public API](https://docs.julialang.org/en/v1.11/base/base/#public) | `public` availability and distinction from exporting. |
| [Julia learning resources](https://julialang.org/learning/) | Official entry to tutorials; choose a tutorial appropriate to the actual task. |

## Representative package practices

This is a bounded selection across numerical interfaces and package tooling, not
an exhaustive survey or a recommendation to depend on every package.

| Package/source | Transferable practice |
|---|---|
| [SciMLBase common interface](https://docs.sciml.ai/SciMLBase/stable/) and [solutions](https://docs.sciml.ai/SciMLBase/stable/interfaces/Solutions/) | Separate problem, algorithm, solve and diagnostics; interpret return codes through the supported accessor. |
| [MathOptInterface solutions](https://jump.dev/MathOptInterface.jl/stable/manual/solutions/) | Termination, result existence and primal/dual status are different questions. |
| [JuMP developer style](https://jump.dev/JuMP.jl/stable/developers/style/) | Document public operations and execute examples; isolate test fixtures. |
| [ForwardDiff limitations](https://juliadiff.org/ForwardDiff.jl/stable/user/limitations/) and [API](https://juliadiff.org/ForwardDiff.jl/stable/user/api/) | Type propagation and function-specific configuration constrain AD/cache reuse. |
| [GenericLinearAlgebra](https://github.com/JuliaLinearAlgebra/GenericLinearAlgebra.jl) | Generic scalar support may require a matching linear algebra implementation. |
| [AbstractFFTs API](https://juliamath.github.io/AbstractFFTs.jl/stable/api/) and [FFTW thread safety](https://www.fftw.org/fftw3_doc/Thread-safety.html) | Plan applicability, possible planning mutation, and planning versus execution ownership. |
| [StaticArrays](https://juliaarrays.github.io/StaticArrays.jl/stable/) | Small fixed sizes can benefit; large/dynamic sizes incur compilation tradeoffs. |
| [Distributions extension guide](https://juliastats.org/Distributions.jl/latest/extends/) | RNG-taking samplers and reusable sampling setup. |
| [QuadGK examples](https://juliamath.github.io/QuadGK.jl/stable/quadgk-examples/) | Error estimates depend on norm and scale; expose relevant tolerance semantics. |
| [Aqua](https://juliatesting.github.io/Aqua.jl/stable/) | Structural package quality checks, with targeted justified exclusions. |
| [JET tutorial](https://aviatesk.github.io/JET.jl/stable/tutorial/) | Analyze concrete entrypoints; report availability and interpretation limits. |
| [Documenter doctests](https://documenter.juliadocs.org/stable/man/doctests/) and [public API](https://documenter.juliadocs.org/stable/lib/public/) | Executable docs and controlled, localized output filtering. |
| [PkgTemplates](https://juliaci.github.io/PkgTemplates.jl/stable/user/) | Repeatable package scaffold and configurable QA/CI/docs integration. |
| [BenchmarkTools manual](https://juliaci.github.io/BenchmarkTools.jl/stable/manual/) | Interpolation, sample setup and real time/allocation trials. |
| [SciML integrator interface](https://docs.sciml.ai/DiffEqDocs/stable/basics/integrator/) and [problem specialization](https://docs.sciml.ai/SciMLBase/dev/interfaces/Problems/) | Restart state, callback invalidation, capability limits, output ownership and compilation/runtime tradeoffs. |
| [Plots recipes](https://docs.juliaplots.org/stable/recipes/) and [RecipesPipeline](https://docs.juliaplots.org/dev/RecipesPipeline/) | Lightweight adapter protocols, transformation phases and backend separation. |
| [PrecompileTools reference](https://julialang.github.io/PrecompileTools.jl/stable/reference/) | Preparation versus captured calls, first-inference ordering and representative workloads. |

The source inspection behind [ecosystem-patterns.md](ecosystem-patterns.md)
used DifferentialEquations 8.1.1, OrdinaryDiffEq 7.8.1, OrdinaryDiffEqCore 4.15.2,
SciMLBase 3.50.0, DiffEqBase 7.19.0, RecursiveArrayTools 4.5.1, Plots 1.41.7,
RecipesBase 1.3.4, RecipesPipeline 0.6.12 and PrecompileTools 1.3.4. These are
reviewed examples, not required versions or package recommendations. Relevant
entrypoints, restart/callback implementation, nested-copy helpers, recipe phases,
configuration precedence and workload capture were read. Internal names are
not proposed as public APIs. In particular, historical manual loading hooks,
global backend queries, shallow shared-default copies and cleanup performed
only on normal exit are not standards to copy.

## Structured and parallel execution

| Source | Transferable practice and evidence scope |
|---|---|
| [SymbolicUtils code generation](https://docs.sciml.ai/SymbolicUtils/stable/manual/codegen/) | Pure-function and branching assumptions for expression reuse; installed 4.46.2 source/docs inspected. |
| [Symbolics build_function](https://docs.sciml.ai/Symbolics/stable/manual/build_function/) | Generated expression/callable and destination-write choices; official docs/default-branch source inspected, no local runtime check. |
| [ModelingToolkit FAQ](https://docs.sciml.ai/ModelingToolkit/stable/basics/FAQ/) and [internals](https://docs.sciml.ai/ModelingToolkit/stable/internals/) | Prepare generation outside differentiation loops; documented symbolic indexing and reconstruction after lowering. Official docs inspected, no local runtime check. |
| [LinearSolve caching](https://docs.sciml.ai/LinearSolve/stable/tutorials/caching_interface/) | Right-hand-side, numeric and symbolic factorization reuse/invalidation; installed 5.14.1 source/docs inspected. |
| [KernelAbstractions](https://juliagpu.github.io/KernelAbstractions.jl/stable/) | Backend-dependent completion, transfer lifetimes, read-only/non-alias assertions and workgroup barriers; cached 0.9.41 source/docs inspected, outside the active environment, no device test. |
| [Dagger task errors](https://juliaparallel.org/Dagger.jl/dev/task-spawning/#Errors), [block size](https://juliaparallel.org/Dagger.jl/stable/stencils/#Choosing-a-Block-Size) and [data management](https://juliaparallel.org/Dagger.jl/stable/data-management/) | Completion versus error propagation, task overhead and placement; official docs inspected, no local source/runtime check. |

These sources inform
[structured-and-device-work.md](../../julia-perf/references/structured-and-device-work.md).
Remote branch/docs evidence is not an immutable installed-source identity.
Neither source inspection nor an optimization mechanism establishes a speedup;
measure the actual supported workload before making a performance claim.

## MIT affiliation

[Julia's entity description](https://julialang.org/blog/2019/02/julia-entities/)
distinguishes the language project, MIT Julia Lab and other organizations.
[MIT Julia Lab research projects](https://julia.mit.edu/research-grants/) identify
its involvement in SciML work including Symbolics, ModelingToolkit, NeuralPDE,
Catalyst and JumpProcesses. [JuliaLabs](https://github.com/JuliaLabs) identifies
itself as the MIT CSAIL lab organization. [FFTW](https://www.fftw.org/) identifies
the underlying C library's MIT origin; its Julia wrapper is a separate project.
The lab's PAPPA project also names Dagger and KernelAbstractions, and its
MIT-Caltech collaboration names Enzyme and Diffractor. This supports a research
or collaboration relationship, not exclusive authorship of those packages.

Use actual authorship/organization evidence. JuMP, JuliaArrays, JuliaStats,
JuliaDiff, JuliaCI, JuliaTesting and JuliaDocs are ecosystem organizations, not
interchangeable names for one MIT team. An MIT license supplies no affiliation
evidence. Package features should be adopted for applicability and verified
behavior, not institutional attribution.
