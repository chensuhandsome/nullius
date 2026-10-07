import { describe, expect, it } from 'vitest';

import { formatPaperMarkdown } from '../src/utils/formatters.js';
import { compactPaperSummary } from '../src/utils/compactPaper.js';

describe('formatPaperMarkdown', () => {
  it('prints a copy/paste-friendly IDs line when identifiers exist', () => {
    const md = formatPaperMarkdown({
      recid: '1234567',
      title: 'Test Paper',
      authors: ['Author A'],
      year: 2024,
      arxiv_id: '2301.12345',
      doi: '10.1103/PhysRevD.107.014001',
    } as any);

    expect(md).toContain(
      'IDs: recid=`1234567` | arXiv=`2301.12345` | DOI=`10.1103/PhysRevD.107.014001`'
    );
  });

  it('omits the IDs line when no identifiers exist', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: ['Author A'],
    } as any);

    expect(md).not.toContain('IDs:');
  });

  // Regression: a compact projection keeps three names and author_count 4; the
  // old formatter printed the three names as if the list were complete.
  it('marks omitted authors explicitly when the record holds more names than shown', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: ['Author, One', 'Author, Two', 'Author, Three'],
      author_count: 4,
    } as any);

    expect(md).toContain('*Author, One, Author, Two, Author, Three et al. (+1 more)*');
  });

  it('prints every author with no marker when the list is complete', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: ['A', 'B', 'C', 'D', 'E', 'F'],
      author_count: 6,
    } as any);

    expect(md).toContain('*A, B, C, D, E, F*');
    expect(md).not.toContain('et al.');
  });

  it('never emits a bare et al. without the omitted count', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      author_count: 2900,
    } as any);

    expect(md).toContain('et al. (+2890 more)');
    expect(md).not.toMatch(/et al\.(?! \(\+)/);
  });

  it('states the author count when a record carries a count but no names', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: [],
      author_count: 2900,
      collaborations: ['Example Collaboration'],
    } as any);

    expect(md).toContain('*Example Collaboration (2900 authors; names not carried in this view)*');
  });

  it('caps the displayed names and counts the rest in the marker', () => {
    const names = Array.from({ length: 14 }, (_, i) => `Author ${i + 1}`);
    const md = formatPaperMarkdown({ title: 'Test Paper', authors: names, author_count: 14 } as any);

    expect(md).toContain('Author 10 et al. (+4 more)');
    expect(md).not.toContain('Author 11');
  });

  it('keeps the omissions a compact projection recorded even when author_count is understated', () => {
    const compact = compactPaperSummary({
      title: 'Test Paper',
      authors: ['A', 'B', 'C', 'D', 'E'],
      author_count: 2,
    } as any);
    expect(compact.authors_omitted).toBe(2);
    const md = formatPaperMarkdown(compact as any);
    expect(md).toContain('*A, B, C et al. (+2 more)*');
  });

  it('names the collaboration when no names and no count are carried', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: [],
      collaborations: ['Example Collaboration'],
    } as any);

    expect(md).toContain('*Example Collaboration (author names not carried in this view)*');
  });

  it('prints no author line when neither names nor a count exist', () => {
    const md = formatPaperMarkdown({ title: 'Test Paper', authors: [] } as any);
    expect(md).not.toContain('authors');
  });
});

