# Reuse, adapters and execution costs

These conditional checks are synthesized from the
[primary sources](sources.md). Adopt the applicable behavior, not an ecosystem's
entire framework. Small functions need neither capability registries nor a
multi-stage pipeline. Package code is an example to inspect, not an authority
that every implementation choice is correct or faster.

## Component dependencies and capability limits

Choose the documented component that supplies the needed operation when it has
a supported standalone entrypoint. A convenience umbrella may suit broad
interactive use. Do not reach into private components to reduce dependencies,
or call splitting a package a measured latency improvement. Test the chosen
entrypoint with only its declared dependencies and optional triggers.

An abstract supertype, available generic method or successful import does not
establish that an operation is supported. Use a documented capability query
where one exists; simple explicit dispatch is sufficient otherwise. A basic
capability may exclude particular keywords, representations or algorithms.
Validate the requested combination, including adapter-provided versus native
support. Unsupported behavior must fail explicitly or use a path satisfying
the same contract. A catch-all exception fallback can hide a programming error.

## Restart as a state transition

For a reusable workspace, list what reset preserves and what it reinitializes:
input/state, parameter-dependent factors, history/controller state, schedules,
callback initialization, saved output, counters, termination/validity status,
and any owned external process or random state, where applicable. Resetting the
visible input array alone is not evidence of a fresh computation.

Test the documented restart against fresh construction after relevant prior
success, early termination and failure states. If reuse after an exit is
unsupported, document and reject it rather than promising recovery. Use a
small public example and the task's already declared error budget. This checks
reuse behavior; the same solver run is not an independent scientific oracle.

Specify input and result ownership separately. Nested arrays and immutable
wrappers can retain mutable members; a shallow copy or immutable outer object
does not guarantee a snapshot. Save a result, continue/reset the workspace, and
check whether the saved data changes. Borrowed outputs need an explicit
lifetime and concurrent-use restriction. Copy depth is a contract choice, not
a universal instruction to `deepcopy` every object.

## Callbacks and cache invalidation

Changes to state, parameters, time or an operator can invalidate derived
derivatives, interpolation, factors or predictions. Provide a documented
mutation/invalidation route. Observation-only callbacks may opt out of
recomputation only when the relevant inputs remain unchanged.

When several effects share one execution step, combine their invalidation
requirements conservatively: one effect requiring a rebuild must not be
cancelled by another reporting no modification. Test that the aggregation
does not depend on the order of independent reports, including an observer
running last. Effects themselves need not commute; this check concerns the
invalidation decision, not equality of arbitrarily reordered state changes.

## Output requirements define the workload

State what the consumer needs: an endpoint, selected components, sampled
history, event-side values, queryable interpolation, or materialized adapter
output. Saving fewer values may reduce memory while internal work is still
required for accuracy, event location or queries. Preserve those requirements
when changing output policy.

Benchmark construction/setup, repeated execution and actual output consumption
as appropriate. Returning an unconsumed lazy result omits work paid later by
the consumer. Compare the same requested outputs, tolerances, validity and
effective backend; classify a changed consumer requirement as a workload
change. Do not suppress invalidity information to make an output smaller or
more convenient to plot.

## Lightweight presentation adapters

Keep numerical data and validity independent of a rendering backend. Native
extensions are the default for an optional heavyweight integration on a
supporting Julia floor. A lightweight public recipe protocol is another
deliberate dependency choice when multiple renderers consume the same owned
type; it need not make the renderer a core dependency.

Adapters use documented data/accessors and preserve units, axes, ordering,
branch/continuity conventions and validity metadata where relevant. Any
sampling, interpolation, transformation or omission must be explicit and
validated. Do not silently rerun a solver, replace failed results, normalize
data or drop exceptional values merely to produce a plausible presentation.
Avoid mutating caller-owned data/configuration unless the API promises mutation.

## Transformation phases and configuration

If an adapter recursively lowers rich inputs to backend operations, define
each phase's accepted representation and output invariants. A recursive
rewrite must make progress or terminate with a useful error. For changed rules,
test a non-progressing rule and relevant multi-step cycles; detecting a direct
self-cycle alone does not establish general termination. Use an appropriate
progress argument or cycle/depth boundary rather than imposing one global
framework on ordinary direct dispatch.

Document precedence among explicit user choices, derived defaults and mandatory
constraints. When that distinction affects behavior, retain whether a value
was explicitly supplied even if it equals the default. Normalize aliases at
the conversion boundary and define conflicting alias/canonical-name behavior.
Test explicit default values and relevant conflicts. If copied configuration
shares nested/default storage, declare whether later mutation changes existing
objects; `copy` alone does not prove isolation.

For an object that retains a backend/resource owner, bind capability checks,
execution, fallback and cleanup to that owner. Test creating an object, changing
the global default and operating on the old object. A design intentionally
using the current default at each call must document that behavior instead.
Record requested and effective choices when selection or fallback can differ.

## Specialization and precompilation

Measure specialization policy using the intended variety and frequency of
callable, parameter and size types. Stable concrete kernel storage and dynamic
outer orchestration can coexist. Full specialization may improve repeated
throughput but increase first-call cost across many distinct types. Encoding
high-cardinality runtime values in types needs a measured reason. Record the
effective strategy and its fallback/eligibility limits; inspect actual call
chains before labeling dynamic dispatch a defect.

Use bounded, representative precompile workloads for supported public calls.
With PrecompileTools, keep data preparation in `@setup_workload` and target
calls in a top-level `@compile_workload`. Dynamic-dispatch capture depends on
first inference: do not execute the target method/type combinations in setup
before the capture region. Check the installed dependency's Julia compatibility,
not merely the mechanism's historical availability.

Precompile workloads really execute code. Avoid external services and expensive
production inputs; scope environment changes and clean up owned files, handles,
devices/windows and temporary state with exception-safe resource management.
Do not serialize a process-specific handle or a temporary current object as
durable package state. Test the representative operations separately, and
measure fresh-process first-call latency with the required extension load
sequence. Added macros or warmed trials alone do not establish a latency gain.
