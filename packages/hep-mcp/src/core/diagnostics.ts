import type { OutputArtifactRef, OutputBatch } from './outputDir.js';

export type BudgetDimensionV1 = 'breadth' | 'depth' | 'budget';
export type BudgetSourceKindV1 = 'tool_args' | 'env' | 'default';
export type WarningSeverityV1 = 'info' | 'warning' | 'error';

export interface HepWarningV1 {
  version: 1;
  created_at: string;
  severity: WarningSeverityV1;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface BudgetSourceV1 {
  kind: BudgetSourceKindV1;
  arg_path?: string;
  env_var?: string;
  default_value?: number;
  raw_value?: unknown;
}

export interface BudgetEntryV1 {
  key: string;
  dimension: BudgetDimensionV1;
  value: number;
  unit?: string;
  source: BudgetSourceV1;
}

export type BudgetHitActionV1 = 'truncate' | 'cap' | 'skip' | 'clamp';

export interface BudgetHitV1 {
  key: string;
  dimension: BudgetDimensionV1;
  unit?: string;
  limit: number;
  observed: number;
  action: BudgetHitActionV1;
  message: string;
  data?: Record<string, unknown>;
}

export interface OutputDiagnosticsArtifactV1 {
  version: 1;
  generated_at: string;
  operation: string;
  output_dir: string;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

export class BudgetTrackerV1 {
  private budgetsByKey = new Map<string, BudgetEntryV1>();
  private hits: BudgetHitV1[] = [];
  private warnings: HepWarningV1[] = [];

  resolveInt(params: {
    key: string;
    dimension: BudgetDimensionV1;
    unit?: string;
    arg_path?: string;
    tool_value?: unknown;
    tool_value_present?: boolean;
    env_var?: string;
    default_value: number;
    min?: number;
    max?: number;
  }): number {
    const min = params.min ?? 0;
    const max = params.max ?? Number.POSITIVE_INFINITY;

    const toolValuePresent = params.tool_value_present ?? params.tool_value !== undefined;
    const fromTool = toolValuePresent ? toFiniteInt(params.tool_value) : null;
    const fromEnv = (() => {
      const envVar = params.env_var;
      if (!envVar) return null;
      return toFiniteInt(process.env[envVar]);
    })();

    let value: number;
    let source: BudgetSourceV1;

    if (fromTool !== null) {
      value = fromTool;
      source = {
        kind: 'tool_args',
        arg_path: params.arg_path,
        raw_value: toolValuePresent ? params.tool_value : undefined,
      };
    } else if (fromEnv !== null) {
      value = fromEnv;
      source = {
        kind: 'env',
        env_var: params.env_var,
        raw_value: params.env_var ? process.env[params.env_var] : undefined,
      };
    } else {
      value = Math.trunc(params.default_value);
      source = {
        kind: 'default',
        default_value: params.default_value,
      };
    }

    if (!Number.isFinite(value)) value = Math.trunc(params.default_value);
    value = Math.max(min, Math.min(max, value));

    if (!this.budgetsByKey.has(params.key)) {
      this.budgetsByKey.set(params.key, {
        key: params.key,
        dimension: params.dimension,
        value,
        unit: params.unit,
        source,
      });
    }

    return value;
  }

  recordHit(params: BudgetHitV1): void {
    this.hits.push(params);
    this.warnings.push({
      version: 1,
      created_at: nowIso(),
      severity: 'warning',
      code: 'budget_hit',
      message: params.message,
      data: {
        key: params.key,
        dimension: params.dimension,
        unit: params.unit,
        limit: params.limit,
        observed: params.observed,
        action: params.action,
        ...(params.data ?? {}),
      },
    });
  }

  warn(params: Omit<HepWarningV1, 'version' | 'created_at'> & { data?: Record<string, unknown> }): void {
    this.warnings.push({
      version: 1,
      created_at: nowIso(),
      severity: params.severity,
      code: params.code,
      message: params.message,
      data: params.data,
    });
  }

  snapshot(): { budgets: BudgetEntryV1[]; hits: BudgetHitV1[]; warnings: HepWarningV1[] } {
    const budgets = Array.from(this.budgetsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
    const hits = [...this.hits];
    const warnings = [...this.warnings];
    return { budgets, hits, warnings };
  }
}

/** Budget and warning record of one tool call, staged in its output batch. */
export function writeOutputDiagnosticsArtifact(params: {
  batch: OutputBatch;
  operation: string;
  artifact_name: string;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
}): { ref: OutputArtifactRef; payload: OutputDiagnosticsArtifactV1 } {
  const payload: OutputDiagnosticsArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    operation: params.operation,
    output_dir: params.batch.out.relative,
    budgets: params.budgets,
    hits: params.hits,
    warnings: params.warnings,
  };
  return { ref: params.batch.json(params.artifact_name, payload), payload };
}
