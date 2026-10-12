import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compareWithBaseline,
  loadBaseline,
  runEvalSet,
  saveBaseline,
  type EvalResult,
} from '../../src/eval/index.js';
import { withHepDataRoot } from '../../src/data/dataDir.js';
import { makeProjectRoot } from '../support/hepProjectUri.js';
import { assertEvalSnapshot, BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  ALLOWED_AGGREGATE_METRICS,
  ALLOWED_PROOF_TAGS,
  EXPECTED_PROOF_TAGS_BY_CASE,
  PRIMARY_PROOF_TAG_BY_DIMENSION,
  buildActual,
  evaluateInvariant,
  evaluateRubric,
  matchesExpected,
  passesEvidenceSufficiency,
  passesFailClosed,
  type ProofExpected,
  type ProofInput,
  type ProofMetadata,
  type ProofNormalizedActual,
  validateProofMetadata,
} from './researchQualityProofSchema.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { generateCriticalQuestions } = await import('../../src/tools/research/criticalQuestions.js');
const { performTheoreticalConflicts } = await import('../../src/tools/research/theoreticalConflicts.js');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function makePaper(overrides: Record<string, unknown> = {}) {
  return {
    recid: '1001',
    title: 'A Review of Surprising Results',
    abstract: 'This breakthrough claims to revolutionize the field and prove a new discovery.',
    authors: ['Alice Example'],
    author_count: 1,
    year: 2018,
    citation_count: 60,
    publication_type: [],
    document_type: [],
    publication_summary: '',
    arxiv_categories: ['hep-th'],
    collaborations: [],
    ...overrides,
  };
}

const SEM04_OUTPUT_DIR = 'eval/research_quality_proof';

/** Run inside a fresh temporary project root, as the dispatcher would for a call naming it. */
async function withTempProjectRoot<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-quality-proof-'));
  const projectRoot = makeProjectRoot(tmpDir);
  try {
    return await withHepDataRoot(projectRoot, () => run(projectRoot));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runSem04Once(input: Extract<ProofInput, { surface: 'sem04' }>['payload']): Promise<ProofNormalizedActual> {
  return withTempProjectRoot(async projectRoot => {
    vi.resetAllMocks();
    vi.mocked(api.getPaper).mockImplementation(async (recid: string) => {
      const paper = input.papers.find(candidate => candidate.recid === recid);
      if (!paper) throw new Error(`missing recid mock: ${recid}`);
      return paper as never;
    });

    const res = await performTheoreticalConflicts({
      output_dir: SEM04_OUTPUT_DIR,
      recids: input.papers.map(paper => paper.recid),
      subject_entity: input.subject_entity,
      inputs: input.inputs,
      prompt_version: 'v2',
      max_candidates_total: 10,
      max_llm_requests: 10,
    }, {
      createMessage: vi.fn().mockResolvedValue({
        model: 'quality-proof-sem04',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
      }),
    });

    expect(res.summary).toBeTruthy();
    const conflicts = readJson<{
      conflicts: Array<{
        relation?: string;
        provenance?: { decision_status?: string; reason_code?: string };
      }>;
    }>(path.join(projectRoot, SEM04_OUTPUT_DIR, 'theoretical_conflicts_v1.json'));
    const firstEdge = conflicts.conflicts[0] ?? {};

    return buildActual('sem04', firstEdge.provenance?.decision_status ?? 'unknown', firstEdge.provenance?.reason_code ?? null, {
      decision_status: firstEdge.provenance?.decision_status ?? null,
      relation: firstEdge.relation ?? null,
    });
  });
}

async function runSem05Once(input: Extract<ProofInput, { surface: 'sem05' }>['payload']): Promise<ProofNormalizedActual> {
  vi.resetAllMocks();
  vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: input.recid, ...input.paper }) as never);
  vi.mocked(api.search).mockResolvedValue({
    total: input.comments_exist ? 1 : 0,
    papers: input.comments_exist ? [{ recid: 'c1', title: 'Comment' }] : [],
    has_more: false,
  } as never);

  const result = await generateCriticalQuestions({ recid: input.recid });
  expect(result.provenance).not.toHaveProperty('authority');

  return buildActual('sem05', result.provenance.status, result.provenance.reason_code, {
    paper_type: result.paper_type,
    provenance_status: result.provenance.status,
  });
}

async function runProofOnce(input: ProofInput): Promise<ProofNormalizedActual> {
  switch (input.surface) {
    case 'sem04':
      return runSem04Once(input.payload);
    case 'sem05':
      return runSem05Once(input.payload);
  }
}

async function runProofCase(input: ProofInput): Promise<ProofNormalizedActual> {
  return runProofOnce(input);
}

function meanForTag(results: Array<EvalResult<ProofNormalizedActual>>, tag: string, metric: string): number {
  const scoped = results.filter(result => result.tags.includes(tag));
  if (scoped.length === 0) return 0;
  return scoped.reduce((sum, result) => sum + (result.metrics[metric] ?? 0), 0) / scoped.length;
}

function validateHarnessBoundary(evalSet: {
  description?: unknown;
  cases: Array<{ id: string; tags: string[]; metadata: unknown }>;
}): void {
  expect(evalSet.description).toBe(
    'Minimal fixed-fixture validity harness for bounded judgment checks on cleaned HEP research surfaces, not a benchmark, scorecard, or eval platform.',
  );

  const proofTagUniverse = new Set<string>();
  for (const evalCase of evalSet.cases) {
    validateProofMetadata(evalCase.metadata);
    const metadata = evalCase.metadata as ProofMetadata;
    const proofTags = evalCase.tags.filter(tag => tag.startsWith('proof:'));
    proofTags.forEach(tag => proofTagUniverse.add(tag));

    expect(proofTags).toContain('proof:trace_conformance');
    expect(proofTags).toEqual(EXPECTED_PROOF_TAGS_BY_CASE[evalCase.id as keyof typeof EXPECTED_PROOF_TAGS_BY_CASE]);
    expect(proofTags).toContain(PRIMARY_PROOF_TAG_BY_DIMENSION[metadata.quality_dimension]);
  }

  expect(Array.from(proofTagUniverse).sort()).toEqual([...ALLOWED_PROOF_TAGS].sort());
}

describe('eval: research-quality proof harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks a minimal judgment-quality proof on cleaned surfaces', async () => {
    const evalSet = readEvalSetFixture('research_quality_proof_eval.json');
    validateHarnessBoundary(evalSet as { description?: unknown; cases: Array<{ id: string; tags: string[]; metadata: unknown }> });
    const report = await runEvalSet<ProofInput, ProofNormalizedActual>(evalSet, {
      run: input => runProofCase(input),
      judge: (expected, actual, evalCase) => {
        const expectedProof = expected as ProofExpected;
        validateProofMetadata(evalCase.metadata);
        const metadata = evalCase.metadata as ProofMetadata;
        const canonicalTracePass = matchesExpected(actual, expectedProof);
        const primaryDimensionPass = evaluateRubric(actual, metadata) ? 1 : 0;
        const evidencePass = passesEvidenceSufficiency(actual) ? 1 : 0;
        const failClosedPass = passesFailClosed(actual) ? 1 : 0;
        const reproducibilityPass = canonicalTracePass ? 1 : 0;
        const applicableDimensions = evalCase.tags.filter(tag => tag.startsWith('proof:'));
        const dimensionScores = applicableDimensions.map(tag => {
          if (tag === 'proof:trace_conformance') return reproducibilityPass;
          if (tag === 'proof:evidence_sufficiency') return evidencePass;
          if (tag === 'proof:fail_closed') return failClosedPass;
          return 0;
        });
        const partialProgress = dimensionScores.length === 0
          ? 0
          : dimensionScores.reduce((sum, value) => sum + value, 0) / dimensionScores.length;

        return {
          passed: primaryDimensionPass === 1 && reproducibilityPass === 1,
          metrics: {
            evidence_sufficiency_case: evalCase.tags.includes('proof:evidence_sufficiency') ? evidencePass : 0,
            fail_closed_case: evalCase.tags.includes('proof:fail_closed') ? failClosedPass : 0,
            trace_conformance_case: evalCase.tags.includes('proof:trace_conformance') ? reproducibilityPass : 0,
          },
          outcome: {
            task_success: primaryDimensionPass === 1 && reproducibilityPass === 1,
            partial_progress: partialProgress,
          },
          resource_overhead: { token_usage: null, cost_usd: null },
        };
      },
      aggregate: results => ({
        evidence_sufficiency: meanForTag(results, 'proof:evidence_sufficiency', 'evidence_sufficiency_case'),
        fail_closed: meanForTag(results, 'proof:fail_closed', 'fail_closed_case'),
        trace_conformance: meanForTag(results, 'proof:trace_conformance', 'trace_conformance_case'),
        overall_gate_pass_rate: results.length === 0 ? 0 : results.filter(result => result.passed).length / results.length,
      }),
    });
    const traceSnapshot = report.caseResults.map(result => ({
      caseId: result.caseId,
      trace: result.actual
        ? {
            surface: result.actual.surface,
            verdict: result.actual.verdict,
            reason_code: result.actual.reason_code,
            state: result.actual.state,
          }
        : null,
    }));
    assertEvalSnapshot('research_quality_proof_trace', traceSnapshot);

    expect(report.summary.total).toBe(2);
    expect(report.summary.passRate).toBe(1);
    expect(report.aggregateMetrics.evidence_sufficiency).toBe(1);
    expect(report.aggregateMetrics.fail_closed).toBe(1);
    expect(report.aggregateMetrics.trace_conformance).toBe(1);
    expect(report.aggregateMetrics.overall_gate_pass_rate).toBe(1);
    expect(Object.keys(report.aggregateMetrics).sort()).toEqual([...ALLOWED_AGGREGATE_METRICS].sort());
    expect(report.aggregateOutcome.task_success_rate).toBe(1);
    expect(report.aggregateOutcome.partial_progress_mean).toBe(1);

    if (process.env.EVAL_UPDATE_BASELINES === '1') saveBaseline(report, BASELINES_DIR);
    const comparison = compareWithBaseline(report, loadBaseline(evalSet.name, BASELINES_DIR));
    expect(comparison.isFirstRun).toBe(false);
    expect(comparison.deltas.evidence_sufficiency?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.fail_closed?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.trace_conformance?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.overall_gate_pass_rate?.delta ?? NaN).toBeCloseTo(0, 9);
  });

  it('rejects traces by walking the real rubric invariant wiring from the fixed fixture metadata', () => {
    const evalSet = readEvalSetFixture('research_quality_proof_eval.json');
    const failClosedCase = evalSet.cases.find(evalCase => evalCase.id === 'sem05_keyword_signal_stays_fail_closed');
    const evidenceCase = evalSet.cases.find(evalCase => evalCase.id === 'sem04_weak_evidence_abstains');

    expect(failClosedCase).toBeTruthy();
    expect(evidenceCase).toBeTruthy();

    validateProofMetadata(failClosedCase?.metadata);
    validateProofMetadata(evidenceCase?.metadata);

    const failClosedMetadata = failClosedCase?.metadata as ProofMetadata;
    const evidenceMetadata = evidenceCase?.metadata as ProofMetadata;

    expect(failClosedMetadata.rubric.invariants).toEqual([
      'missing_sampling_must_stay_unavailable',
      'claim_words_must_not_create_semantic_authority',
    ]);
    expect(evidenceMetadata.rubric.invariants).toEqual([
      'weak_evidence_requires_abstention',
      'decision_status_must_stay_abstained',
      'relation_must_remain_unclear',
    ]);

    // Fail-closed by status, but the claim words still set the paper type: only the invariant can catch it.
    const failClosedInvariantOnlyBreak = buildActual('sem05', 'unavailable', 'sampling_required', {
      paper_type: 'review',
      provenance_status: 'unavailable',
    });
    // Claim words turned into a classification without semantic sampling.
    const keywordClassification = buildActual('sem05', 'applied', 'keyword_signal', {
      paper_type: 'review',
      provenance_status: 'applied',
    });
    const failClosedWiringMetadata: ProofMetadata = {
      ...failClosedMetadata,
      rubric: {
        ...failClosedMetadata.rubric,
        expected_trace: {
          verdict: failClosedInvariantOnlyBreak.verdict,
          reason_code: failClosedInvariantOnlyBreak.reason_code,
          state: failClosedInvariantOnlyBreak.state,
        },
      },
    };
    const keywordClassificationMetadata: ProofMetadata = {
      ...failClosedMetadata,
      rubric: {
        ...failClosedMetadata.rubric,
        expected_trace: {
          verdict: keywordClassification.verdict,
          reason_code: keywordClassification.reason_code,
          state: keywordClassification.state,
        },
      },
    };
    // A relation claimed from the weak title-only evidence.
    const claimedRelation = buildActual('sem04', 'accepted', 'semantic_relation', {
      decision_status: 'accepted',
      relation: 'competing',
    });

    expect(matchesExpected(failClosedInvariantOnlyBreak, failClosedWiringMetadata.rubric.expected_trace)).toBe(true);
    expect(passesFailClosed(failClosedInvariantOnlyBreak)).toBe(true);
    expect(evaluateInvariant('claim_words_must_not_create_semantic_authority', failClosedInvariantOnlyBreak)).toBe(false);
    expect(evaluateRubric(failClosedInvariantOnlyBreak, failClosedWiringMetadata)).toBe(false);

    expect(matchesExpected(keywordClassification, keywordClassificationMetadata.rubric.expected_trace)).toBe(true);
    expect(passesFailClosed(keywordClassification)).toBe(false);
    expect(evaluateInvariant('missing_sampling_must_stay_unavailable', keywordClassification)).toBe(false);
    expect(evaluateRubric(keywordClassification, keywordClassificationMetadata)).toBe(false);

    expect(evaluateRubric(claimedRelation, evidenceMetadata)).toBe(false);
    expect(passesEvidenceSufficiency(claimedRelation)).toBe(false);
    expect(evaluateInvariant('weak_evidence_requires_abstention', claimedRelation)).toBe(false);
  });
});
