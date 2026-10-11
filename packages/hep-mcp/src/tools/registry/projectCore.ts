import {
  HEP_PROJECT_CREATE,
  HEP_PROJECT_GET,
  HEP_PROJECT_LIST,
  HEP_HEALTH,
  HEP_PROJECT_BUILD_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_PROJECT_PLAYBACK_EVIDENCE,
  HEP_INSPIRE_SEARCH_EXPORT,
  HEP_INSPIRE_RESOLVE_IDENTIFIERS,
} from '../../tool-names.js';
import { createProject, getProject, listProjects } from '../../core/projects.js';
import { buildProjectEvidenceCatalog, playbackProjectEvidence, queryProjectEvidence } from '../../core/evidence.js';
import { hepInspireSearchExport } from '../../core/inspire/searchExport.js';
import { hepInspireResolveIdentifiers } from '../../core/inspire/resolveIdentifiers.js';
import { getHepHealth } from '../utils/health.js';
import type { ToolSpec } from './types.js';
import {
  HepProjectCreateToolSchema,
  HepProjectGetToolSchema,
  HepProjectListToolSchema,
  HepHealthToolSchema,
  HepInspireSearchExportToolSchema,
  HepInspireResolveIdentifiersToolSchema,
  HepProjectBuildEvidenceToolSchema,
  HepProjectQueryEvidenceToolSchema,
  HepProjectPlaybackEvidenceToolSchema,
} from './projectSchemas.js';

export const RAW_PROJECT_CORE_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_PROJECT_CREATE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a local paper/evidence project and return `hep://projects/{project_id}` (local manifest pointer; local-only)',
    zodSchema: HepProjectCreateToolSchema,
    handler: async params => {
      const project = createProject(params);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_GET,
    tier: 'core',
    exposure: 'standard',
    description:
      'Get a project summary + `hep://projects/{project_id}` URI (local manifest pointer; local-only)',
    zodSchema: HepProjectGetToolSchema,
    handler: async params => {
      const project = getProject(params.project_id);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
          updated_at: project.updated_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_LIST,
    tier: 'core',
    exposure: 'standard',
    description:
      'List local projects (small summaries + `hep://projects/{project_id}` local manifest pointers; local-only)',
    zodSchema: HepProjectListToolSchema,
    handler: async () => {
      const projects = listProjects().map(p => ({
        project_id: p.project_id,
        name: p.name,
        updated_at: p.updated_at,
        project_uri: `hep://projects/${encodeURIComponent(p.project_id)}`,
      }));
      return { total: projects.length, projects };
    },
  },
  {
    name: HEP_HEALTH,
    tier: 'core',
    exposure: 'standard',
    description:
      'Server health/config snapshot + optional INSPIRE connectivity probe (local-only; network optional).',
    zodSchema: HepHealthToolSchema,
    handler: async params =>
      getHepHealth({ check_inspire: params.check_inspire, inspire_timeout_ms: params.inspire_timeout_ms }),
  },
  {
    name: HEP_PROJECT_BUILD_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build a LaTeX Evidence Catalog for a project paper and write `catalog.jsonl` (Evidence-first: URI + summary; local-only)',
    zodSchema: HepProjectBuildEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxParagraphLengthProvided = Object.prototype.hasOwnProperty.call(raw, 'max_paragraph_length');
      return buildProjectEvidenceCatalog({ ...params, budget_hints: { max_paragraph_length_provided: maxParagraphLengthProvided } });
    },
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Lexical query over a project Evidence Catalog (local-only).',
    zodSchema: HepProjectQueryEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, 'concurrency');
      return queryProjectEvidence({
        project_id: params.project_id,
        paper_id: params.paper_id,
        query: params.query,
        types: params.types,
        limit: params.limit,
        concurrency: params.concurrency,
        budget_hints: { concurrency_provided: concurrencyProvided },
      });
    },
  },
  {
    name: HEP_PROJECT_PLAYBACK_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description: 'Playback an evidence locator and return a stable snippet (local-only)',
    zodSchema: HepProjectPlaybackEvidenceToolSchema,
    handler: async params => playbackProjectEvidence(params),
  },
  {
    name: HEP_INSPIRE_SEARCH_EXPORT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export an INSPIRE search (safe pagination) into output_dir inside project_root (jsonl/json records + meta + the INSPIRE requests/responses used). Network (INSPIRE); returns project-relative paths + summary.',
    zodSchema: HepInspireSearchExportToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const sizeProvided = Object.prototype.hasOwnProperty.call(raw, 'size');
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return hepInspireSearchExport({
        output_dir: params.output_dir,
        query: params.query,
        sort: params.sort,
        size: params.size,
        max_results: params.max_results,
        output_format: params.output_format,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: {
          size_provided: sizeProvided,
          max_results_provided: maxResultsProvided,
        },
      });
    },
  },
  {
    name: HEP_INSPIRE_RESOLVE_IDENTIFIERS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Batch resolve identifiers (recid/arXiv/DOI) to INSPIRE recids, writing the mapping + meta + the INSPIRE requests/responses used into output_dir inside project_root (network; returns project-relative paths + summary).',
    zodSchema: HepInspireResolveIdentifiersToolSchema,
    handler: async params =>
      hepInspireResolveIdentifiers({
        output_dir: params.output_dir,
        identifiers: params.identifiers,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
      }),
  },
];
