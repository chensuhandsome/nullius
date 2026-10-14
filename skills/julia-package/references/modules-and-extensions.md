# Modules and package extensions

Consult the [Julia Modules manual](https://docs.julialang.org/en/v1/manual/modules/),
[Code Loading manual](https://docs.julialang.org/en/v1/manual/code-loading/), and
[Pkg package guide](https://pkgdocs.julialang.org/v1/creating-packages/)
matching the declared Julia floor. Language loading semantics and the package
organization policy below are distinct: the language permits layouts a reusable
library may have good reasons to avoid.

## Source layout and definition ownership

The conventional entrypoint is `src/PackageName.jl` with `module PackageName`,
matching `Project.toml`. Keep imports and include order easy to inspect there.
Files may partition one module without creating submodules. Introduce a
submodule when it supplies a meaningful namespace or responsibility boundary,
not merely because a file exists or has become long.

`include` evaluates a file in the including module; it is not a package import
or a shared-definition mechanism. Give every shared type and generic function
one owning module. Consumers import that binding. Re-including a type definition
in two modules creates distinct types even if their names and fields match.
Do not fix that divergence by broadening methods or silently converting between
accidental copies.

Make dependencies flow from shared definitions/interfaces to implementations
and optional integrations. Avoid cyclic imports and initialization-order
dependencies; move the genuinely shared contract to a suitable existing/common
owner rather than adding reciprocal includes. Do not require `Main`, a caller's
include sequence, current directory or manual `LOAD_PATH` edits for package use.
Namespace containment and root-level coordination/re-exports do not themselves
constitute a circular implementation dependency.

## Namespaces and public surfaces

- Submodules do not inherit parent bindings automatically. Use relative imports
  such as `using ..SharedTypes: Input` inside sibling consumers, or qualified
  access where appropriate. Declare external package imports as direct
  dependencies in the applicable environment.
- Use selective imports or qualified names to avoid ambiguous exports. To add
  unqualified methods to an imported function, explicitly `import` that
  function; alternatively define a qualified method. `using` alone is not the
  unqualified method-extension permission.
- Export the intended root convenience API deliberately. Mark documented
  unexported APIs with `public` only on supported Julia versions (1.11+); an
  export and a public declaration serve different namespace purposes.
  An ordinary version conditional does not hide unsupported syntax from an older
  parser. For a 1.10 floor, prefer documented APIs/exports unless a deliberate,
  syntax-compatible declaration mechanism is actually needed.
- A root re-export should retain the original binding/type identity, not create
  another type. If qualified submodule APIs are supported, document and test
  them; otherwise treat them as internal. Moving a symbol or redefining its
  owning generic can break dispatch and downstream callers despite the same
  printed name.
- Do not replace foreign methods during import/precompilation, or use broad
  method piracy to glue modules together. Extensions of a documented foreign
  interface on your owned types remain ordinary supported integration.

## Initialization and precompilation

Keep top-level package loading deterministic and bounded. Process-specific
pointers, native-library handles and other runtime resources must not be
assumed valid because they existed when a precompile cache was made. Initialize
necessary runtime resources in `__init__` or through an explicit lazy resource
owner; state ownership, failure and concurrency behavior. Prefer lazy setup for
expensive resources that ordinary import does not need.

`__init__` is runtime initialization, not permission to activate/install packages,
download data, change directories or silently set process-wide numerical policy.
Do not swallow initialization failures and leave a plausible half-initialized
capability. Use a representative small precompile workload where beneficial,
but test its operations separately without swallowing errors; opt-out of
precompilation needs a concrete incompatibility rather than masking defects.
`__precompile__(false)` can also prevent use by other precompiled modules; test
that consequence rather than treating the opt-out as a harmless local switch.

## Native extension contract

Native package extensions require Julia 1.9+. For new integrations on a
supporting floor, use the native loader rather than inventing manual load-order
hooks. An existing lower-floor support policy must be addressed explicitly; do
not silently add a compatibility backend or raise the floor merely for convenience.

1. Declare optional packages under `[weakdeps]` with UUIDs and applicable
   `[compat]`. A weak dependency is not automatically installed. Packages used
   by core computations remain ordinary `[deps]`; do not hide a mandatory
   mathematical dependency as optional.
2. Map each `[extensions]` key to a trigger name or list. The entrypoint is
   `ext/ExtensionName.jl` or `ext/ExtensionName/ExtensionName.jl`, defining
   `module ExtensionName`. Keep one discoverable entrypoint and include its
   private files normally.
3. The parent package and **all** listed triggers must be loaded before the
   extension activates. Installation or one trigger alone is insufficient.
   Triggers must be declared weak or ordinary dependencies. Extension dependency
   lookup follows the parent with its triggers additionally available; it does
   not grant arbitrary access to every weak dependency.
4. Import the parent and required triggers inside the extension. Extend the
   documented parent generic or a documented external interface on an owned
   type. Keep shared core types/generics in their owner; extension-local helper
   types are fine when the optional integration genuinely owns them.
5. Core must not unconditionally import a weak dependency, include extension
   source manually, or require an extension's private implementation to load.
   Offer optional behavior through the documented public API, with an explicit
   absence contract: an unavailable capability may produce a documented method
   or capability error. Do not silently substitute a different calculation.
6. `Base.get_extension(ParentModule, :ExtensionName)` inspects whether an extension
   has loaded and returns `nothing` otherwise. It does not force activation.
   Use it for loading checks or deliberate parent integration; ordinary callers
   should use the documented package API. Direct access to extension-local
   symbols requires an intentionally documented optional API.
7. Avoid parent/extension/trigger dependency cycles. Do not make an extension
   load another package whose loading requires that same extension. Check the
   actual declared floor: loader restrictions and cycle diagnostics evolve;
   do not use runtime `@eval using ...` to evade them.

For intentional extension-to-extension dependencies, Julia 1.11+ restricts
precompile dependencies to extensions with a **strict subset** of the dependent
extension's triggers. Check this topology and the declared floor separately;
do not attribute that restriction to 1.12 or assume older versions behave the
same way. Prefer a clear shared parent interface or a combined integration over
mutually dependent extensions. See the
[Julia 1.11 release notes](https://docs.julialang.org/en/v1.11/NEWS/#Language-changes).

## Checks before accepting a layout/integration change

Run changed public examples through package loading in a fresh process. Check
the entrypoint with `using`/`import`; directly including its source is not an
equivalent package-loading test. Check
shared type identity with `===`, intended qualified/root APIs, and absence of
method-overwrite/ambiguity problems. Test import/precompile behavior when
initialization changes; success with `--compiled-modules=no` alone does not
establish cache/precompile correctness.

For a changed extension, keep the following cases small and independent:

| Environment/load case | Required observation |
|---|---|
| Core-only environment without optional packages | Parent loads; core behavior works; extension is absent. |
| Triggers installed but not loaded | Extension remains absent. |
| Multiple triggers, each omitted in turn | `get_extension` remains `nothing`; documented absence behavior holds. |
| Parent then all triggers | Extension loads and the public integration actually works. |
| All triggers then parent | Same public behavior; no reliance on incidental load order. |
| Relevant changed extension combinations | No ambiguity/overwrite or changed method-selection behavior. |

Use fresh processes: loaded packages/extensions cannot be made absent by deleting
bindings. Include a separate consumer environment with the parent as a dependency;
tests with the parent itself as the active project can conceal downstream
dependency-lookup defects. Ensure test/docs environments explicitly contain triggers needed for
their examples, use the current source checkout, and retain a compatible resolved
Manifest (old manifests may lack extension metadata). Select combinations based
on interacting methods and changed trigger sets, not an unconditional exhaustive
power set. Unavailable runtime/device/trigger checks remain unverified. Package
loading success does not establish the optional backend's numerical correctness.
