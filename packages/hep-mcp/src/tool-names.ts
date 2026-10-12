/**
 * hep-mcp local tool-name authority.
 *
 * HEP-owned tool families live here. For convenience, hep-mcp also re-exports
 * the non-HEP tool constants it composes from sibling provider packages.
 */

export const HEP_PROJECT_CREATE = 'hep_project_create' as const;
export const HEP_PROJECT_GET = 'hep_project_get' as const;
export const HEP_PROJECT_LIST = 'hep_project_list' as const;
export const HEP_HEALTH = 'hep_health' as const;
export const HEP_PROJECT_BUILD_EVIDENCE = 'hep_project_build_evidence' as const;
export const HEP_PROJECT_QUERY_EVIDENCE = 'hep_project_query_evidence' as const;
export const HEP_PROJECT_PLAYBACK_EVIDENCE = 'hep_project_playback_evidence' as const;

export const HEP_IMPORT_FROM_ZOTERO = 'hep_import_from_zotero' as const;
export const HEP_INSPIRE_SEARCH_EXPORT = 'hep_inspire_search_export' as const;
export const HEP_INSPIRE_RESOLVE_IDENTIFIERS = 'hep_inspire_resolve_identifiers' as const;

// Admin / maintenance tools. These manage hep-mcp's own state (caches, indices,
// project paper layout) and never modify human/agent-written knowledge_base or
// research_*.md files.
export const HEP_ADMIN_MIGRATE_PAPERS_CACHE = 'hep_admin_migrate_papers_cache' as const;
export const HEP_ADMIN_PRUNE_PAPER_CACHE = 'hep_admin_prune_paper_cache' as const;
export const HEP_ADMIN_IMPORT_PAPER = 'hep_admin_import_paper' as const;
export const HEP_ADMIN_LINK_KB_NOTES = 'hep_admin_link_kb_notes' as const;

export {
  ARXIV_GET_METADATA,
  ARXIV_PAPER_SOURCE,
  ARXIV_SEARCH,
  HEPDATA_DOWNLOAD,
  HEPDATA_GET_RECORD,
  HEPDATA_GET_TABLE,
  HEPDATA_SEARCH,
  INSPIRE_ANALYZE_CITATION_STANCE,
  INSPIRE_CLASSIFY_REVIEWS,
  INSPIRE_CLEANUP_DOWNLOADS,
  INSPIRE_CRITICAL_ANALYSIS,
  INSPIRE_DETECT_MEASUREMENT_CONFLICTS,
  INSPIRE_FIND_CROSSOVER_TOPICS,
  INSPIRE_FIND_CONNECTIONS,
  INSPIRE_GRADE_EVIDENCE,
  INSPIRE_LITERATURE,
  INSPIRE_NETWORK_ANALYSIS,
  INSPIRE_PAPER_SOURCE,
  INSPIRE_PARSE_LATEX,
  INSPIRE_RESOLVE_CITEKEY,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_THEORETICAL_CONFLICTS,
  INSPIRE_TOPIC_ANALYSIS,
  INSPIRE_TRACE_ORIGINAL_SOURCE,
  INSPIRE_VALIDATE_BIBLIOGRAPHY,
  OPENALEX_AUTOCOMPLETE,
  OPENALEX_BATCH,
  OPENALEX_CITATIONS,
  OPENALEX_CONTENT,
  OPENALEX_FILTER,
  OPENALEX_GET,
  OPENALEX_GROUP,
  OPENALEX_RATE_LIMIT,
  OPENALEX_REFERENCES,
  OPENALEX_SEARCH,
  OPENALEX_SEMANTIC_SEARCH,
  PDG_BATCH,
  PDG_FIND_PARTICLE,
  PDG_FIND_REFERENCE,
  PDG_GET,
  PDG_GET_DECAYS,
  PDG_GET_MEASUREMENTS,
  PDG_GET_PROPERTY,
  PDG_GET_REFERENCE,
  PDG_INFO,
  ZOTERO_ADD,
  ZOTERO_CONFIRM,
  ZOTERO_DELETE,
  ZOTERO_EXPORT_ITEMS,
  ZOTERO_FIND_ITEMS,
  ZOTERO_GET_SELECTED_COLLECTION,
  ZOTERO_LOCAL,
  ZOTERO_SEARCH_ITEMS,
} from '@nullius/shared';
