# @nullius/shared

Provider-neutral types, schemas, and utilities consumed across the nullius monorepo. This is the **shared contracts layer** — every package that crosses a contract boundary (control plane, domain packs, provider atoms) imports from here rather than redefining the type.

## Layer

Shared contracts layer (cross-cutting). Sits between the control plane (`@nullius/orchestrator`) and the domain/provider packages. Not itself a runtime entrypoint.

## Subpath exports

| Entry | What lives there |
| --- | --- |
| `@nullius/shared` | Top-level barrel including all sub-exports plus `./generated` types |
| `@nullius/shared/types` | Hand-written domain-neutral TypeScript types |
| `@nullius/shared/utils` | Helpers (path/sha256/clock/etc.) used by control plane and domain packs |
| `@nullius/shared/graph-viz` | Memory-graph visualization helpers |
| `@nullius/shared/discovery` | Discovery-pipeline contracts (capabilities, ranking, dedup) |

## Generated contracts

TypeScript types under `src/generated/` are **codegen output** from `meta/schemas/`. Do not edit them by hand. Re-run codegen with:

```bash
pnpm codegen           # regenerate
pnpm codegen:check     # regenerate and fail if the working tree drifts
```

A long-term symbol must not adopt drift-prone suffixes like `v2`, `new_*`, `legacy_*`, or `W1/W2` — see [AGENTS.md](../../AGENTS.md) §Stable Public Invariants.

Gate-result envelopes follow the gate's actual semantics. Team/draft/reproduction
convergence uses `convergence_gate_result_v1`; the pre-dispatch delegation-budget
quality gate uses `delegation_budget_gate_result_v1` with
`pass | fail | input_error`. Do not add non-convergence gate ids to the
convergence envelope.

Notebook content-review evidence reuses `verification_subject_v1`,
`verification_check_run_v1`, `verification_subject_verdict_v1`,
`verification_coverage_v1`, and `ArtifactRef` rather than defining another
verification authority. It binds the complete UTF-8 notebook and required
declared dependencies by SHA-256 of their actual bytes, including automatic
blocks and uncommitted edits. The semantic check is supporting evidence;
accepted prose review is neither decisive computation validation nor proof of
scientific truth. Coverage and reviewer independence remain explicit limits.

Automatically linked binary or oversized files are immutable opaque snapshots
and SHA-256 locators in `opaque_links`. They participate in review-swarm manifest
freshness, but are neither embedded nor read. The report's `opaque_sources` must
explain every path, hash and `required_for_reasoning`; a missing assessment or any
required unread source prevents acceptance. Supply independently checked readable
text dependencies for reasoning that depends on such material. Hash identity is
not semantic reading. The notebook and explicit `--dependency` inputs require
strict UTF-8; the text packet closure is limited to 1 MiB and total snapshot
storage to 64 MiB, with refusal rather than silent truncation. This review
currently accepts only tool mode `none`; other modes are unavailable. It executes
one reviewer and does not establish a cross-family quorum.

## Build & test

```bash
pnpm -C packages/shared build
pnpm -C packages/shared test
```

## See also

- Root [README.md](../../README.md) §3 Layer Model — where `shared` fits
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority — authoritative scope
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane / contracts boundary discussion
