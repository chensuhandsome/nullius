import {
  getToolRiskLevel,
  type ToolRiskLevel,
  type ToolRiskTable,
} from '@nullius/shared';
import * as T from './tool-names.js';

export type { ToolRiskLevel } from '@nullius/shared';

/**
 * hep-mcp owns the concrete risk authority for the tool catalog it exposes,
 * including consolidated sibling-provider tools surfaced through hep-mcp.
 */
export const HEP_TOOL_RISK_LEVELS: ToolRiskTable = {
  [T.HEP_HEALTH]: 'read',
  [T.HEP_IMPORT_FROM_ZOTERO]: 'write',
  [T.HEP_INSPIRE_SEARCH_EXPORT]: 'write',
  // Writes its mapping and API records into the caller's output_dir.
  [T.HEP_INSPIRE_RESOLVE_IDENTIFIERS]: 'write',
  [T.INSPIRE_SEARCH]: 'write',
  [T.INSPIRE_SEARCH_NEXT]: 'read',
  [T.INSPIRE_TOPIC_ANALYSIS]: 'read',
  [T.INSPIRE_NETWORK_ANALYSIS]: 'read',
  [T.INSPIRE_FIND_CONNECTIONS]: 'read',
  [T.INSPIRE_TRACE_ORIGINAL_SOURCE]: 'read',
  [T.INSPIRE_LITERATURE]: 'read',
  [T.INSPIRE_PAPER_SOURCE]: 'write',
  [T.INSPIRE_PARSE_LATEX]: 'write',
  [T.INSPIRE_RESOLVE_CITEKEY]: 'read',
  [T.INSPIRE_GRADE_EVIDENCE]: 'read',
  [T.INSPIRE_DETECT_MEASUREMENT_CONFLICTS]: 'read',
  [T.INSPIRE_CRITICAL_ANALYSIS]: 'read',
  [T.INSPIRE_CLASSIFY_REVIEWS]: 'read',
  // Writes its records and map into the caller's output_dir.
  [T.INSPIRE_THEORETICAL_CONFLICTS]: 'write',
  [T.INSPIRE_FIND_CROSSOVER_TOPICS]: 'read',
  [T.INSPIRE_ANALYZE_CITATION_STANCE]: 'read',
  [T.INSPIRE_CLEANUP_DOWNLOADS]: 'destructive',
  [T.INSPIRE_VALIDATE_BIBLIOGRAPHY]: 'read',
  [T.ARXIV_SEARCH]: 'read',
  [T.ARXIV_GET_METADATA]: 'read',
  [T.ARXIV_PAPER_SOURCE]: 'write',
  [T.PDG_INFO]: 'read',
  [T.PDG_FIND_PARTICLE]: 'read',
  [T.PDG_FIND_REFERENCE]: 'read',
  [T.PDG_GET_REFERENCE]: 'read',
  [T.PDG_GET_PROPERTY]: 'read',
  [T.PDG_GET]: 'read',
  [T.PDG_GET_DECAYS]: 'read',
  [T.PDG_GET_MEASUREMENTS]: 'read',
  [T.PDG_BATCH]: 'read',
  [T.ZOTERO_LOCAL]: 'read',
  [T.ZOTERO_FIND_ITEMS]: 'read',
  [T.ZOTERO_SEARCH_ITEMS]: 'read',
  [T.ZOTERO_EXPORT_ITEMS]: 'read',
  [T.ZOTERO_GET_SELECTED_COLLECTION]: 'read',
  [T.ZOTERO_ADD]: 'write',
  [T.ZOTERO_CONFIRM]: 'write',
  [T.ZOTERO_DELETE]: 'write',
  [T.HEPDATA_SEARCH]: 'read',
  [T.HEPDATA_GET_RECORD]: 'read',
  [T.HEPDATA_GET_TABLE]: 'read',
  [T.HEPDATA_DOWNLOAD]: 'destructive',
  [T.OPENALEX_SEARCH]: 'read',
  [T.OPENALEX_SEMANTIC_SEARCH]: 'read',
  [T.OPENALEX_GET]: 'read',
  [T.OPENALEX_FILTER]: 'read',
  [T.OPENALEX_GROUP]: 'read',
  [T.OPENALEX_REFERENCES]: 'read',
  [T.OPENALEX_CITATIONS]: 'read',
  [T.OPENALEX_BATCH]: 'read',
  [T.OPENALEX_AUTOCOMPLETE]: 'read',
  [T.OPENALEX_CONTENT]: 'destructive',
  [T.OPENALEX_RATE_LIMIT]: 'read',
};

export function getHepToolRiskLevel(
  toolName: string,
  fallback: ToolRiskLevel = 'read',
): ToolRiskLevel {
  return getToolRiskLevel(toolName, HEP_TOOL_RISK_LEVELS, fallback);
}
