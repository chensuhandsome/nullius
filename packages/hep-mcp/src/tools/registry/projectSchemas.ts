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

export const OutputDirSchema = z
  .string()
  .min(1)
  .describe(
    'Directory inside project_root that receives this call\'s output files, relative to project_root or absolute '
      + '(any spelling of the root). Requires project_root. Created if missing; it may not traverse a symbolic link, '
      + 'and may not lie under .nullius/, team/runs/ or artifacts/hep-mcp/.'
  );

export const HepImportFromZoteroToolSchema = z.object({
  output_dir: OutputDirSchema,
  collection_key: SafePathSegmentSchema.optional(),
  item_keys: z.array(SafePathSegmentSchema).optional().default([]),
  limit: optionalBudgetInt({ min: 1 }),
  start: optionalBudgetInt({ min: 0 }),
  concurrency: optionalBudgetInt({ min: 1, max: 16 }).default(4),
}).refine(v => Boolean(v.collection_key) || v.item_keys.length > 0, {
  message: 'Either collection_key or item_keys is required',
});

export const SearchExportFormatSchema = z.enum(['jsonl', 'json']);

export const HepInspireSearchExportToolSchema = z.object({
  output_dir: OutputDirSchema,
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: optionalBudgetInt({ min: 1, max: 1000 }).default(1000),
  max_results: optionalBudgetInt({ min: 1, max: 10_000 }).default(10_000),
  output_format: SearchExportFormatSchema.optional().default('jsonl'),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
});

export const HepInspireResolveIdentifiersToolSchema = z.object({
  output_dir: OutputDirSchema,
  identifiers: z.array(z.string().min(1)).min(1),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
});

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
  concurrency: optionalBudgetInt({ min: 1, max: 16 }).default(4),
  limit: optionalBudgetInt({ min: 1, max: 50 }).default(10),
});

export const HepProjectPlaybackEvidenceToolSchema = z.object({
  project_id: SafePathSegmentSchema,
  paper_id: SafePathSegmentSchema,
  evidence_id: z.string().min(1),
  before_chars: optionalBudgetInt({ min: 0, max: 1000 }).default(40),
  after_chars: optionalBudgetInt({ min: 0, max: 2000 }).default(120),
});
