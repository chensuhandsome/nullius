# Computational interfaces

The rules below are package policy synthesized from the primary sources in
[sources.md](sources.md); they do not require every library to adopt SciML or JuMP.

## Design around the mathematical operation

Use a small functional API when sufficient. For repeated solves, a typed problem
can hold immutable inputs, an algorithm can select the numerical method, a
workspace can own mutable scratch state, and a result can carry both outputs and
diagnostics. Prefer existing interfaces when integrating with another ecosystem.

An input object must not quietly change when a workspace is reused. Specify
ownership, copy behavior and whether modifying a parameter invalidates cached
geometry, factors or plans. Prefer narrow, measurable caching over hidden global
memoization. Do not put mutable array contents into a cache key without a defined
invalidation mechanism.

Do not extend a foreign function on exclusively foreign types unless an explicitly
coordinated interface requires it. Extend a documented function on your owned
type, or use a wrapper. Declare packages used directly; do not reach through
another package's imported dependency, private submodule or unpromised field.

## Scalars and arrays

Choose supported scalar types deliberately. Generic code should propagate types
through `zero`, `one`, `oftype`, `promote_type` and output construction where
appropriate. Test claimed support with actual calls, including complex values or
high precision only where meaningful. An AD-compatible interface must preserve
dual values, avoid destructive conversions, and document nondifferentiable
branches. A precision-specific implementation should advertise that restriction.

Use abstract arguments to express interfaces and parametric fields to preserve
specialization. A concrete `Vector{Float64}` argument is justified by a real
implementation requirement, not the assumption that abstract signatures are
slow. Factorization APIs can impose narrower element-type or layout requirements
than the surrounding code: check the entire call chain.

For multi-array operations, validate compatible axes before using common indices.
For supported strided/views/sparse inputs, test those representations. A custom
array interface requires its documented indexing methods, not simply inheritance.
If only conventional axes are supported, `Base.require_one_based_indexing` is an
explicit boundary. Avoid unsafe indexing based on `1:length(A)` behind a broad
array signature.

Specify aliasing for destination, input and workspace. A zero-allocation routine
may still be incorrect if destination writes destroy unread input. Reusing a
workspace must not change a previously returned result unless the API explicitly
returns a borrowed view.

For nested arrays or immutable wrappers containing mutable members, top-level
copying/immutability is insufficient evidence of a stable snapshot. Check saved
results after later execution and workspace reset. If reuse is supported,
define its reset state and capability limits as described in
[ecosystem-patterns.md](ecosystem-patterns.md).

## Numerical failure is part of the API

For a solver or estimator, define what successful termination establishes. Keep
iteration termination, convergence, usable candidate, uncertainty validity and
domain applicability distinct where relevant. An enum/symbol and structured
diagnostics are usually clearer than one overloaded Boolean.

Check finite values and domain after any intentional narrowing conversion. Test
`NaN`, infinities, zero, tiny positive inputs and extremely large finite values
where the public signature admits them, against the declared rejection or
propagation semantics; do not universally ban them in ordinary arithmetic.
Avoid catches that replace a programming
error with a plausible numeric answer. A fallback must meet the same requested
contract or return an explicit qualified status.

Validate representation-sensitive operations with invariants or another
representation. Include negative controls that would reject the original defect.
Trace validity metadata through accessors, `show`, serialization and optional
plotting; no consumer should transform a failed estimate into an unqualified
interval or result.

## Concurrency and reproducibility

Prefer an explicit `rng` argument for random algorithms and explicit workspace
ownership for parallel calls. A seed alone does not guarantee identical streams
across Julia versions; archive input draws when exact cross-version reproduction
is needed. Test concurrent/reentrant calls if support is claimed.

Do not index mutable task scratch buffers by `Threads.threadid()` under a
migratable schedule. A deliberately fixed scheduling strategy needs a documented
restriction and tests; it is not a general solution for composable libraries.
Do not silently set process-wide BLAS thread counts in a library. A benchmark or
application launcher may configure them and must record that choice.

Inspect the exact method and runtime for `BigFloat` precision/rounding changes.
The non-function setters change global defaults and are unsafe alongside
unrelated concurrent calculations. Older restoring function forms also used
global settings, but the BigFloat function forms in
[Julia 1.12.6 source](https://github.com/JuliaLang/julia/blob/v1.12.6/base/mpfr.jl)
use `ScopedValue` bindings (also verified in the 1.12.0 tag). New tasks inherit
the dynamic scope at task creation; distributed workers do not automatically
inherit it. Do not treat a modern scoped `do` block as the old
global setter, or assume every numeric type implements the same specialization.
For supported older/global implementations, a package-local lock cannot protect
unrelated host code; enforce an appropriate serial/process boundary. For scoped
implementations, test concurrent tasks, scope inheritance and exception cleanup
on the supported version floor. Do not infer whole-algorithm thread safety from
precision scoping alone.
