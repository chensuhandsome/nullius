import { z } from 'zod';
import { optionalBudgetInt } from '@nullius/shared';

const SortSchema = z.enum(['mostrecent', 'mostcited']);

export const SafePathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(s => !s.includes('/') && !s.includes('\\'), {
    message: 'must not include path separators',
  })
  .refine(s => s !== '.' && s !== '..' && !s.includes('..'), {
    message: 'contains unsafe segment',
  });

export const HepProjectCreateToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const HepProjectGetToolSchema = z.object({
  project_id: SafePathSegmentSchema,
});

export const HepProjectListToolSchema = z.object({});

export const HepHealthToolSchema = z.object({
  check_inspire: z.boolean().optional().default(false),
  inspire_timeout_ms: optionalBudgetInt({ min: 1 }).default(5000),
});

/**
 * A whole-number limit given as a number or a digit string. Unlike the
 * lenient shared helper, a value that is not a whole number or lies outside
 * [min, max] is refused (INVALID_PARAMS), never replaced by the default.
 */
export function strictBudgetInt(options: { min?: number; max?: number } = {}) {
  let inner = z.number().int();
  if (options.min !== undefined) inner = inner.min(options.min);
  if (options.max !== undefined) inner = inner.max(options.max);
  const parsed = z.preprocess(
    value => (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value.trim()) : value),
    inner.optional(),
  );
  // Optional on the outside too, so the published input schema does not
  // list the field as required (an omitted value takes the tool's default).
  const schema = parsed.optional();
  // Publish the bounds in the tool's input schema, as the shared helper does.
  for (const node of [parsed, schema]) {
    Object.defineProperty(node, '__mcpBudget', {
      value: { ...options, integer: true },
      configurable: true,
    });
  }
  return schema;
}

export const OutputDirSchema = z
  .string()
  .min(1)
  .describe(
    'Directory inside project_root that receives this call\'s output files, relative to project_root or absolute '
      + '(any spelling of the root). Requires project_root. Created if missing; it may not traverse a symbolic link, '
      + 'and may not lie under .nullius/, team/runs/ or artifacts/hep-mcp/. A call never replaces an existing file '
      + '(it is refused if any of its files already exists), and a call that fails removes what it had published and staged. '
      + 'If that cleanup fails, the error says what is left: published files make it UNSAFE_FS "outputs are incomplete" with '
      + 'files_left; staging files alone are added to the original error as staging_left (staging_path if unidentified). '
      + 'Only a crash during publication can leave part of a set unreported. Later calls naming leftover files are refused until they are removed.'
  );

// The tools that write into output_dir, and the lexical evidence query, use
// strict schemas: an undeclared argument (a misspelled output_dir, a removed
// parameter) is refused instead of being silently dropped.
export const HepImportFromZoteroToolSchema = z.object({
  // Declared here because the refinement below keeps the registry from
  // adding its generic project_root field to this schema.
  project_root: z.string().optional().describe('Absolute path to the initialized nullius project root that contains output_dir.'),
  output_dir: OutputDirSchema,
  collection_key: SafePathSegmentSchema.optional(),
  item_keys: z.array(SafePathSegmentSchema).optional().default([]),
  limit: strictBudgetInt({ min: 1 }),
  start: strictBudgetInt({ min: 0 }),
  concurrency: strictBudgetInt({ min: 1, max: 16 }).default(4),
}).strict().refine(v => Boolean(v.collection_key) || v.item_keys.length > 0, {
  message: 'Either collection_key or item_keys is required',
});

export const SearchExportFormatSchema = z.enum(['jsonl', 'json']);

export const HepInspireSearchExportToolSchema = z.object({
  output_dir: OutputDirSchema,
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: strictBudgetInt({ min: 1, max: 1000 }).default(1000).describe(
    'Records per INSPIRE page. If omitted: HEP_BUDGET_INSPIRE_SEARCH_PAGE_SIZE when set, otherwise 1000.'
  ),
  max_results: strictBudgetInt({ min: 1, max: 10_000 }).default(10_000).describe(
    'Most records to export (at most 10000). If omitted: HEP_BUDGET_INSPIRE_SEARCH_MAX_RESULTS when set, otherwise 10000.'
  ),
  output_format: SearchExportFormatSchema.optional().default('jsonl'),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
}).strict();

export const HepInspireResolveIdentifiersToolSchema = z.object({
  output_dir: OutputDirSchema,
  identifiers: z.array(z.string().min(1)).min(1),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
}).strict();

const EvidenceTypeSchema = z.enum([
  'title',
  'abstract',
  'section',
  'paragraph',
  'equation',
  'figure',
  'table',
  'theorem',
  'citation_context',
]);
const PdfEvidenceTypeSchema = z.enum(['pdf_page', 'pdf_region']);
const QueryEvidenceTypeSchema = z.union([EvidenceTypeSchema, PdfEvidenceTypeSchema]);

export const HepProjectBuildEvidenceToolSchema = z
  .object({
    project_id: SafePathSegmentSchema,
    paper_id: SafePathSegmentSchema.optional(),
    identifier: z.string().min(1).optional(),
    main_tex_path: z.string().min(1).optional(),
    include_inline_math: z.boolean().optional().default(false),
    include_cross_refs: z.boolean().optional().default(false),
    max_paragraph_length: optionalBudgetInt({ min: 0 }).default(0),
  })
  .refine(p => Boolean(p.identifier) || Boolean(p.main_tex_path), {
    message: 'Either identifier or main_tex_path is required',
  });

export const HepProjectQueryEvidenceToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  paper_id: SafePathSegmentSchema.optional(),
  query: z.string().min(1),
  types: z.array(QueryEvidenceTypeSchema).optional(),
  // Lexical search is the only mode; naming another one is refused rather than ignored.
  mode: z.literal('lexical').optional(),
  concurrency: strictBudgetInt({ min: 1, max: 16 }).default(4),
  limit: strictBudgetInt({ min: 1, max: 50 }).default(10),
}).strict();

export const HepProjectPlaybackEvidenceToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  paper_id: SafePathSegmentSchema,
  evidence_id: z.string().min(1),
  before_chars: optionalBudgetInt({ min: 0, max: 1000 }).default(40),
  after_chars: optionalBudgetInt({ min: 0, max: 2000 }).default(120),
});
