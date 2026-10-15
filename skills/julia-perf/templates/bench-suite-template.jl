# Example benchmark suite for julia-perf.
#
# Contract:
# - Define JULIA_PERF_BENCHMARKS or julia_perf_benchmarks() returning
#   name => Benchmark pairs. Pure zero-arg functions are supported with
#   config policy="fixed"; setup/teardown belongs in Benchmark objects.

using BenchmarkTools, Random

# Local fixed input; random generation is excluded from the timed kernel.
const input = rand(MersenneTwister(17), 256)
transform!(y, x) = (@. y = sin(x) + 3 * x)

const JULIA_PERF_BENCHMARKS = [
    "reduction" => @benchmarkable(sum($input), evals=1),
    "broadcast-kernel" => @benchmarkable(transform!(y, $input), setup=(y=similar($input)), evals=1),
]

