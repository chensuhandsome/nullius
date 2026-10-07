/**
 * Compact PaperSummary projection (H-13 L1)
 * Retains LLM-decision-relevant fields, drops redundant URLs and classification arrays.
 * ~63% size reduction per paper (~600 bytes → ~220 bytes).
 */

import type { PaperSummary } from '@nullius/shared';

export interface CompactPaperSummary {
  recid?: string;
  arxiv_id?: string;
  title: string;
  authors?: string[];
  author_count?: number;
  /** Names not carried in `authors`, including omissions from earlier projections; present only when > 0. */
  authors_omitted?: number;
  collaborations?: string[];
  year?: number;
  citation_count?: number;
  texkey?: string;
  arxiv_primary_category?: string;
  publication_summary?: string;
}

/** Project a full PaperSummary to the compact LLM-decision subset. */
export function compactPaperSummary(p: PaperSummary): CompactPaperSummary {
  const carried = p.authors?.length ?? 0;
  const authors = p.authors?.slice(0, 3);
  const authorCount = p.author_count ?? p.authors?.length;
  const upstreamOmitted = (p as Partial<CompactPaperSummary>).authors_omitted ?? 0;
  // Make the truncation explicit in the JSON itself: a consumer that reads only
  // `authors` must still see that names were dropped and how many. Count from
  // the larger of the declared count and the names actually carried, so an
  // understated author_count cannot hide a projection drop. The dispatcher
  // may compact again during auto-summarization, so retain earlier omissions.
  const authorsOmitted = Math.max(0, Math.max(authorCount ?? 0, carried + upstreamOmitted) - (authors?.length ?? 0));
  return {
    recid: p.recid,
    arxiv_id: p.arxiv_id,
    title: p.title,
    authors,
    author_count: authorCount,
    ...(authorsOmitted > 0 ? { authors_omitted: authorsOmitted } : {}),
    collaborations: p.collaborations,
    year: p.year,
    citation_count: p.citation_count,
    texkey: p.texkey,
    arxiv_primary_category: p.arxiv_primary_category,
    publication_summary: p.publication_summary,
  };
}

/**
 * Apply compact projection to any paper arrays found in a result object.
 * Returns a shallow copy with papers compacted; does not mutate the original.
 * Handles both raw PaperSummary[] arrays and objects with a `papers` key.
 */
export function compactPapersInResult(result: unknown): unknown {
  // M-21 R2 fix: handle raw PaperSummary[] arrays (e.g. inspire_literature get_references)
  if (Array.isArray(result)) {
    let anyCompacted = false;
    const compacted = result.map((p: unknown) => {
      if (p && typeof p === 'object' && 'title' in p) {
        anyCompacted = true;
        return compactPaperSummary(p as PaperSummary);
      }
      return p;
    });
    return anyCompacted ? compacted : result;
  }

  if (!result || typeof result !== 'object') return result;

  const record = result as Record<string, unknown>;
  let changed = false;
  const copy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'papers' && Array.isArray(value)) {
      copy[key] = value.map((p: unknown) => {
        if (p && typeof p === 'object' && 'title' in p) {
          return compactPaperSummary(p as PaperSummary);
        }
        return p;
      });
      changed = true;
    } else {
      copy[key] = value;
    }
  }

  return changed ? copy : result;
}
