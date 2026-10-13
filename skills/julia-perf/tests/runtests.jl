using Test, BenchmarkTools, JSON3, TOML
include(joinpath(@__DIR__, "..", "scripts", "run_perf.jl"))

@testset "measurement protocol" begin
    @test_throws ErrorException normalize_benchmark_cases([])
    @test_throws ErrorException normalize_benchmark_cases(["x" => () -> 1, "x" => () -> 2])
    @test_throws ErrorException protocol_config(Dict("benchmark" => Dict("samples" => 0)))
    @test_throws ErrorException protocol_config(Dict("benchmark" => Dict("evals" => Dict("policy" => "auto"))))
    @test_throws ErrorException regression_config(Dict("regression" => Dict("max_time_ratio" => NaN)))
    @test_throws ErrorException parse_args(["--config", "unused", "--worker"])
    p = protocol_config(Dict("benchmark" => Dict("samples" => 3, "seconds" => 0.01)))
    # Returning allocated objects prevents compiler elimination; setup bytes
    # belong to fixture preparation, not to the kernel allocation metric.
    b = @benchmarkable [zeros(16), zeros(32)] evals=1
    row = run_benchmark_case("allocate", b, p)
    @test row["allocations"] >= 2
    @test row["memory_bytes"] >= 16 * 8 + 32 * 8
    @test row["samples"] == length(row["sample_times_ns"])
    @test row["current_median_ns"] == median(row["sample_times_ns"])
    @test row["evals"] == 1
    mut = @benchmarkable (x[1] += 1; x[1] == 1 || error("fixture reused")) setup=(x=zeros(Int, 1)) evals=1
    @test run_benchmark_case("mutation", mut, p)["allocations"] == 0
    @test length(validate_rows([row])) == 1
    bad = deepcopy(row); bad["allocations"] = true
    @test_throws ErrorException validate_rows([bad])
    bad = deepcopy(row); bad["current_median_ns"] += 1
    @test_throws ErrorException validate_rows([bad])
end

@testset "ordinary suite includes and runtime options" begin
    mktempdir() do dir
        write(joinpath(dir, "helper.jl"), "make_values() = [zeros(2), zeros(3)]\n")
        suite = joinpath(dir, "suite.jl")
        write(suite, "using BenchmarkTools\ninclude(\"helper.jl\")\nJULIA_PERF_BENCHMARKS = [\"nested\" => @benchmarkable(make_values(), evals=1)]\n")
        cases = load_suite_cases(suite)
        @test first(first(cases)) == "nested"
        protocol = protocol_config(Dict("benchmark" => Dict("samples" => 2, "seconds" => 0.01)))
        row = Base.invokelatest(run_benchmark_case, first(cases).first, first(cases).second, protocol)
        @test row["allocations"] >= 2
        @test haskey(runtime_options(), "opt_level_min")
        @test haskey(runtime_options(), "cpu_target")
    end
end

@testset "baseline and declared thresholds" begin
    base = Dict{String,Any}("name" => "x", "current_median_ns" => 10.0,
        "allocations" => 3, "memory_bytes" => 32, "samples" => 3,
        "sample_times_ns" => [8.0,10.0,12.0])
    rows = [deepcopy(base)]
    rows[1]["current_median_ns"] = 20.0
    @test length(compare_rows!(rows, Dict("x" => base), Dict("max_time_ratio" => 1.1))) == 1
    @test rows[1]["allocations_delta"] == 0
    @test isempty(compare_rows!(rows, Dict("x" => base), Dict("max_memory_bytes" => 32)))
    @test_throws ErrorException compare_rows!(rows, Dict("different" => base), Dict())
    missing_absolute = deepcopy(base); delete!(missing_absolute, "allocations"); missing_absolute["allocations_delta"] = 0
    @test_throws ErrorException validate_rows([missing_absolute])
    mktempdir() do dir
        path = joinpath(dir, "baseline.json")
        write(path, "[]")
        @test_throws Exception load_baseline(path)
        write(path, "{broken")
        @test_throws Exception load_baseline(path)
        @test_throws Exception load_baseline(joinpath(dir, "missing"))
        latest = joinpath(dir, "latest"); mkpath(latest)
        write(joinpath(latest, "keep"), "keep")
        @test_throws ErrorException materialize_output_dir(latest)
        @test read(joinpath(latest, "keep"), String) == "keep"
    end
end

@testset "dependency and workspace fingerprints" begin
    mktempdir() do dir
        dep = joinpath(dir, "dep"); mkpath(joinpath(dep,"src")); mkpath(joinpath(dep,"ext"))
        write(joinpath(dep,"Project.toml"), "name=\"FixtureDependency\"\n")
        write(joinpath(dep,"src","FixtureDependency.jl"), "module FixtureDependency end\n")
        extension = joinpath(dep,"ext","FixtureExtension.jl")
        write(extension,"module FixtureExtension end\n")
        project = joinpath(dir,"Project.toml"); write(project,"[deps]\n")
        manifest = joinpath(dir,"Manifest.toml")
        write(manifest,"manifest_format=\"2.0\"\n[[deps.FixtureDependency]]\npath=\"dep\"\nuuid=\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"\n")
        first = runtime_fingerprint(;project)
        write(extension,"module ChangedFixtureExtension end\n")
        second = runtime_fingerprint(;project)
        @test first["dependencies"] != second["dependencies"]
        @test first["manifest_toml_sha256"] == second["manifest_toml_sha256"]
        @test length(second["julia_sysimage_sha256"]) == 64
        if VERSION >= v"1.12"
            bench = joinpath(dir,"bench"); mkpath(bench)
            bench_project=joinpath(bench,"Project.toml"); write(bench_project,"[deps]\n")
            write(project,"[workspace]\nprojects=[\"bench\"]\n")
            # A conflicting child manifest must not override the root selected
            # by the actual runtime workspace loader.
            write(joinpath(bench,"Manifest.toml"),"manifest_format=\"2.0\"\n")
            workspace = runtime_fingerprint(;project=bench_project)
            @test workspace["manifest_toml_sha256"] == sha256_file(manifest)
            @test haskey(workspace["dependencies"],"FixtureDependency")
        end
    end
end

@testset "artifact status and supervisor" begin
    mktempdir() do dir
        suite = joinpath(dir, "suite.jl")
        write(suite, "using BenchmarkTools\nJULIA_PERF_BENCHMARKS = [\"x\" => @benchmarkable(zeros(16), evals=1)]\n")
        config = joinpath(dir, "config.toml")
        cfg = Dict{String,Any}("benchmark" => Dict("suite_file" => "suite.jl", "samples" => 3, "seconds" => 0.01, "timeout_seconds" => 0.2))
        open(io -> TOML.print(io, cfg), config, "w")
        out = joinpath(dir, "base"); mkpath(out)
        opts = Dict{String,Any}("save_baseline" => true)
        @test worker_main(opts, cfg, config, out) == 0
        status = JSON3.read(read(joinpath(out,"summary.json"),String))
        @test status.verdict == "BASELINE_CREATED"
        @test status.claim_verified == false && status.thresholds_passed == false
        manifest, rows = load_baseline(joinpath(out,"baseline.json"))
        @test haskey(manifest["runtime"], "blas_threads")
        @test length(rows) == 1
        cfg["benchmark"]["baseline_file"] = "base/baseline.json"
        open(io -> TOML.print(io, cfg), config, "w")
        out2 = joinpath(dir, "comparison"); mkpath(out2)
        @test worker_main(Dict("save_baseline"=>false),cfg,config,out2) == 2
        cfg["regression"] = Dict("max_allocations"=>0)
        open(io -> TOML.print(io, cfg), config, "w")
        out3 = joinpath(dir,"regress"); mkpath(out3)
        @test worker_main(Dict("save_baseline"=>false),cfg,config,out3) == 1
        cfg["regression"] = Dict("max_allocations"=>100)
        open(io -> TOML.print(io, cfg), config, "w")
        out4 = joinpath(dir,"pass"); mkpath(out4)
        @test worker_main(Dict("save_baseline"=>false),cfg,config,out4) == 0
        @test JSON3.read(read(joinpath(out4,"summary.json"),String)).claim_verified == false
        write(suite, "JULIA_PERF_BENCHMARKS=[]\n")
        out5 = joinpath(dir,"empty"); mkpath(out5)
        @test worker_main(opts,cfg,config,out5) == 1
        @test !isfile(joinpath(out5,"baseline.json"))
        # A short supervisor deadline deterministically covers loading/startup;
        # there are no assertions about measured kernel wall times.
        @test main(["--config",config,"--out-dir",joinpath(dir,"timeout"),"--save-baseline"]) == 1
        status = JSON3.read(read(joinpath(dir,"timeout","summary.json"),String))
        @test status.hard_failures[1].check_id == "timeout"
    end
end
