# Structured kernels and device execution

Apply these checks only when the implementation exposes the corresponding
optimization. The source examples are summarized in
[julia-package sources](../../julia-package/references/sources.md); they do not
require adopting a symbolic framework, accelerator or task scheduler.

## Symbolic transformations and generated kernels

Declare the domain and program-semantic assumptions of cancellation, common
subexpression elimination, hoisting and related transformations. A simplified
expression may assume a nonzero denominator; common subexpression elimination
may assume pure functions and change call count/order. Eager evaluation can
evaluate a branch the reference never evaluates. Test applicable singular,
side-effect and unselected-invalid-branch counterexamples. Algebraic agreement
on ordinary values alone does not establish the original program's semantics.

Separate symbolic analysis, code generation, compilation, numerical preparation
and execution costs. For stable structure, prepare generated functions outside
repeated execution or differentiation loops and update numerical parameters
through supported interfaces. Regenerate when model structure, layout or
relevant generation options change. Differentiating a prepared numerical
function and differentiating the code-generation process are distinct claims;
test only the supported one and preserve parameter/type propagation.

Check the actual generated mutating kernel's write contract. For full outputs,
pre-fill destinations with nonzero sentinels, vary inputs and reuse the buffers;
check every required output, including mathematical zeros and sparse value
slots. A zero-filled fresh fixture can conceal skipped writes. A deliberately
partial update must specify which other positions remain unchanged. Inspect
generation options and emitted assignments instead of assuming an option name
guarantees complete initialization.

Structural lowering may reorder or eliminate variables. Bind inputs, outputs
and cached indices to stable semantic identities through documented accessors
and retain any required reconstruction map. Verify consumed eliminated outputs
as well as retained variables. A structure/layout change invalidates old indices,
setters and generated functions unless their continued applicability is checked.
Compare the transformed representation to the reference through this mapping,
not by equating unrelated array positions.

## Sparse structure and factor reuse

For factorization-based reuse, distinguish right-hand-side, numerical-value and
structural changes. A right-hand-side-only change can retain numerical factors
when their applicability contract permits it. Changed operator values invalidate
old numerical factors unless a supported factor update establishes validity;
a changed sparsity pattern also invalidates structural analysis unless a
supported update handles it. Equal shape and nonzero count do not prove equal
pattern. Do not infer a structural zero from one numerical evaluation alone.

Notify changes through the documented setter/invalidation route, including
in-place matrix/parameter mutation. Skip structural checks only with a declared
invariance guarantee. Test equal-shape/equal-count but different patterns,
value-only changes and right-hand-side-only changes, as applicable. Measure
analysis, factor/update, repeated solve and required reconstruction separately;
record which work was actually rebuilt. Do not use private dirty flags as a
cross-package API or hide refactorization in an alleged cached-solve benchmark.

Unchanged structure does not guarantee that retained numerical pivots remain
stable after values change. A reuse/update path needs the method's stability
checks and residual/error acceptance, with a supported fresh-factor/pivot
fallback when needed. Test a relevant fixed-pattern change that invalidates
the reuse assumptions. Keep the tolerance tied to the requested observable;
do not copy one backend's pivot-growth threshold as a universal rule.

## Completion, transfers and ownership

Inspect the actual backend's completion contract. An operation may enqueue work
and return before completion; a CPU implementation can instead complete before
returning even under a common API. Do not infer either behavior from the function
name or host-side launch latency.

Completion and success are distinct. Use the runtime's result/error interface
to propagate task failures; a readiness predicate or completion wait may not
raise them. A benchmark that merely waits for a failed task has not established
successful computation.

Time completion of the work being claimed. When execution is asynchronous,
place the required wait/synchronization inside the measured operation. Clear
pre-existing queued work before sampling if it is excluded from the contract.
Declare whether transfer, allocation and host materialization belong to the
requested result, and report separate kernel-only and end-to-end measurements
only with their scopes explicit. Consume lazy/task/device results when the
consumer's contract requires them. A quick launch alone is not fast computation.

Record actual backend/device identity and supported storage/layout. Make device
adaptation and transfers explicit; host scalar iteration behind an abstract
array signature can invalidate both portability and the intended workload.
An asynchronous transfer must keep source/destination storage alive and valid
until completion, including any host-memory registration/ownership requirement.
A preserve scope ending at enqueue is insufficient when the backend retains
the storage afterward. Pinning/zero-copy availability and benefit are backend
dependent, not universal prescriptions.

## Kernel assertions and synchronization

Read the exact semantics of optimization annotations. For example,
KernelAbstractions' `@Const` asserts both no writes through that argument and no
aliasing with other arguments; Julia's ordinary `const` binding is a different
concept. Prove the promised read-only/non-alias conditions or reject unsupported
aliases. Do not add unchecked annotations solely to remove allocations or
enable vectorization.

A workgroup barrier coordinates that workgroup; it does not establish a grid
barrier or completion visible to the host. Required participants must converge
at a barrier according to the backend/API contract. Test tail workgroups,
non-multiple launch ranges and changed indexing/masking paths with diagnostic
bounds/race tools when available. Include a negative case for violated alias or
synchronization preconditions when that case can be safely tested. An available
CPU implementation or successful compilation does not validate a GPU kernel;
unavailable hardware checks remain unverified.

## Scheduled work and data placement

Choose task/block granularity from useful computation, scheduling overhead,
available parallelism and data movement together. More tasks can increase
overhead; fewer can leave resources idle. Observe actual task counts,
dependencies, input placement, callable/captured-data movement and final result
retrieval. Use representative workloads rather than copying a package's fixed
cutoff or example timing. When batching, retain the original output/error and
ownership contract; scheduling overhead is not permission to share mutable
scratch unsafely.
