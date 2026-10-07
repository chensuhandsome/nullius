import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "bin" / "triangulate_citation.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("triangulate_citation", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _load_module()


def _block(provider, **overrides):
    base = {
        "provider": provider,
        "title": None,
        "authors": None,
        "year": None,
        "doi": None,
        "venue": None,
        "identifier": None,
    }
    base.update(overrides)
    return base


def _write_json(directory, name, payload):
    path = Path(directory) / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


class TitleNormalizationTests(unittest.TestCase):
    def test_latex_greek_matches_unicode_greek(self):
        latex = MOD.fold_text(r"Study of the $\alpha$ decay").replace(" ", "")
        unicode_form = MOD.fold_text("Study of the α decay").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_latex_superscript_matches_unicode_superscript(self):
        latex = MOD.fold_text(r"Search in $^{212}$Po decays").replace(" ", "")
        unicode_form = MOD.fold_text("Search in ²¹²Po decays").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_latex_accent_matches_unicode_accent(self):
        latex = MOD.fold_text(r"M\o ller scattering and Schr\"odinger dynamics")
        unicode_form = MOD.fold_text("Møller scattering and Schrödinger dynamics")
        self.assertEqual(latex, unicode_form)

    def test_case_whitespace_and_dashes_fold(self):
        first = MOD.fold_text("Electron--Positron  Annihilation")
        second = MOD.fold_text("electron–positron annihilation")
        self.assertEqual(first, second)

    def test_math_wrappers_are_dropped(self):
        wrapped = MOD.fold_text(r"The $\mathrm{X}(3872)$ state")
        plain = MOD.fold_text("The X(3872) state")
        self.assertEqual(wrapped, plain)

    def test_latex_subscript_matches_unicode_subscript(self):
        latex = MOD.fold_text(r"Properties of H$_{2}$O clusters").replace(" ", "")
        unicode_form = MOD.fold_text("Properties of H₂O clusters").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_relation_symbols_stay_distinct(self):
        equal = MOD.fold_text("Conditions for A = B")
        unequal = MOD.fold_text("Conditions for A \u2260 B")
        self.assertNotEqual(equal, unequal)
        self.assertEqual(MOD.fold_text(r"A $\neq$ B"), MOD.fold_text("A \u2260 B"))
        self.assertEqual(MOD.fold_text(r"A $\ne$ B"), MOD.fold_text("A \u2260 B"))
        self.assertEqual(MOD.fold_text(r"x $\leq$ y"), MOD.fold_text("x \u2264 y"))
        self.assertEqual(MOD.fold_text(r"x $\geq$ y"), MOD.fold_text("x \u2265 y"))
        self.assertNotEqual(MOD.fold_text("x < y"), MOD.fold_text("x > y"))
        self.assertEqual(MOD.fold_text(r"a $\approx$ b"), MOD.fold_text("a \u2248 b"))

    def test_precomposed_negations_need_no_map_entries(self):
        # Every precomposed negated relation decomposes (NFD) to base + U+0338 before the
        # symbol pass, so the overlay path alone must produce the shared "not <base>" form.
        for precomposed, base in (("≠", "="), ("≮", "<"), ("≯", ">"), ("≰", "≤"), ("≱", "≥"), ("≉", "≈"), ("≢", "≡"), ("≁", "∼"), ("≄", "≃"), ("∉", "∈")):
            self.assertNotIn(precomposed, MOD._UNICODE_TOKEN_MAP)
            self.assertEqual(MOD.fold_text(f"A {precomposed} B"), MOD.fold_text(f"A {base}\u0338 B"), precomposed)
            self.assertEqual(MOD.fold_text(f"A {precomposed} B"), f"a not {MOD._UNICODE_TOKEN_MAP[base]} b", precomposed)

    def test_combining_negation_matches_the_precomposed_symbol(self):
        combining = MOD.fold_text("A =\u0338 B")    # "=" followed by U+0338
        precomposed = MOD.fold_text("A \u2260 B")
        self.assertEqual(combining, precomposed)
        self.assertNotEqual(combining, MOD.fold_text("A = B"))
        self.assertEqual(MOD.fold_text("x <\u0338 y"), MOD.fold_text("x \u226e y"))
        self.assertEqual(MOD.fold_text(r"x \nless y"), MOD.fold_text("x \u226e y"))

    def test_negations_without_a_precomposed_form_and_latex_not_are_kept(self):
        # a negated proportionality has no precomposed character: the overlay negates the token
        self.assertNotEqual(MOD.fold_text("A \u221d\u0338 B"), MOD.fold_text("A \u221d B"))
        self.assertNotEqual(MOD.fold_text("A \u2270 B"), MOD.fold_text("A B"))          # not-less-or-equal survives
        self.assertNotEqual(MOD.fold_text("A \u2270 B"), MOD.fold_text("A \u2264 B"))
        self.assertEqual(MOD.fold_text(r"A \nleq B"), MOD.fold_text("A \u2270 B"))
        # LaTeX \not negates what follows it, agreeing with the dedicated spellings
        self.assertEqual(MOD.fold_text(r"A \not= B"), MOD.fold_text("A \u2260 B"))
        self.assertEqual(MOD.fold_text(r"A \not= B"), MOD.fold_text(r"A \neq B"))
        self.assertNotEqual(MOD.fold_text(r"A \not= B"), MOD.fold_text("A = B"))
        self.assertEqual(MOD.fold_text(r"A \not\approx B"), MOD.fold_text("A \u2249 B"))
        self.assertNotEqual(MOD.fold_text(r"A \not\approx B"), MOD.fold_text(r"A \approx B"))
        self.assertEqual(MOD.fold_text(r"A \not\propto B"), MOD.fold_text("A \u221d\u0338 B"))
        self.assertNotEqual(MOD.fold_text(r"A \not\foo B"), MOD.fold_text(r"A \foo B"))  # unknown target keeps the distinction
        blocks = [_block("one", title="A \u221d B", year=2001), _block("two", title="A \u221d\u0338 B", year=2001)]
        self.assertEqual(MOD.compare_blocks(blocks)["verdict"], "conflicted")
        blocks = [_block("one", title=r"A \not\approx B", year=2001), _block("two", title="A \u2249 B", year=2001)]
        self.assertEqual(MOD.compare_blocks(blocks)["fields"]["title"]["status"], "agree")

    def test_latex_inequalities_and_not_control_word_boundary(self):
        self.assertNotEqual(MOD.fold_text(r"A \lt B"), MOD.fold_text(r"A \gt B"))
        self.assertEqual(MOD.fold_text(r"A \lt B"), MOD.fold_text("A < B"))
        self.assertEqual(MOD.fold_text(r"A \gt B"), MOD.fold_text("A > B"))
        blocks = [_block("one", title=r"A \lt B", year=2001), _block("two", title=r"A \gt B", year=2001)]
        self.assertEqual(MOD.compare_blocks(blocks)["verdict"], "conflicted")
        # \notag is an unrelated command, dropped like any unknown one; \notin is set membership
        self.assertEqual(MOD.fold_text(r"A = B\notag"), MOD.fold_text("A = B"))
        self.assertEqual(MOD.fold_text(r"x \notin S"), MOD.fold_text("x \u2209 S"))
        self.assertNotEqual(MOD.fold_text(r"x \notin S"), MOD.fold_text(r"x \in S"))

    def test_accented_greek_keeps_its_letter(self):
        precomposed = "\u03ac = \u03b2"          # ά (precomposed) = β
        combining = "\u03b1\u0301 = \u03b2"      # α + combining acute
        self.assertEqual(MOD.fold_text(precomposed), MOD.fold_text("\u03b1 = \u03b2"))
        self.assertEqual(MOD.fold_text(combining), MOD.fold_text("\u03b1 = \u03b2"))
        self.assertNotEqual(MOD.fold_text(precomposed), MOD.fold_text("= \u03b2"))

    def test_negation_of_a_negated_relation_folds_identically_in_every_spelling(self):
        # (plain strings: a raw string would leave "\\u2260" as literal text instead of the symbol)
        forms = ["A \\not\u2260 B", "A \\not\\neq B", "A \u2260\u0338 B", "A \\not=\u0338 B"]
        folded = {MOD.fold_text(f) for f in forms}
        self.assertEqual(len(folded), 1, folded)
        self.assertNotEqual(folded.pop(), MOD.fold_text("A \u2260 B"))
        forms = ["A \\not\u2270 B", "A \\not\\nleq B", "A \u2270\u0338 B"]
        self.assertEqual(len({MOD.fold_text(f) for f in forms}), 1)
        blocks = [_block("one", title="A \\not\u2260 B", year=2001), _block("two", title="A \\not\\neq B", year=2001)]
        self.assertEqual(MOD.compare_blocks(blocks)["fields"]["title"]["status"], "agree")
        # an overlay after an ordinary space is not a negation target
        self.assertEqual(MOD.fold_text("A \u0338 B"), MOD.fold_text("A B"))

    def test_overlay_after_a_named_latex_relation_negates_it(self):
        self.assertEqual(MOD.fold_text("A \\neq\u0338 B"), MOD.fold_text("A \u2260\u0338 B"))
        self.assertNotEqual(MOD.fold_text("A \\neq\u0338 B"), MOD.fold_text("A \u2260 B"))
        self.assertEqual(MOD.fold_text("A \\leq\u0338 B"), MOD.fold_text("A \u2270 B"))
        self.assertEqual(MOD.fold_text("A \\leq\u0338\u0338 B"), MOD.fold_text("A \u2270\u0338 B"))
        blocks = [_block("one", title="A \\leq\u0338 B", year=2001), _block("two", title="A \u2264 B", year=2001)]
        self.assertEqual(MOD.compare_blocks(blocks)["verdict"], "conflicted")

    def test_simeq_is_its_own_relation(self):
        self.assertEqual(MOD.fold_text(r"A \simeq B"), MOD.fold_text("A \u2243 B"))
        self.assertNotEqual(MOD.fold_text(r"A \simeq B"), MOD.fold_text(r"A \approx B"))
        self.assertNotEqual(MOD.fold_text("A \u2243 B"), MOD.fold_text("A \u2248 B"))
        self.assertNotEqual(MOD.fold_text("A \u2243 B"), MOD.fold_text("A B"))

    def test_opposing_relations_make_titles_disagree(self):
        blocks = [
            _block("one", title="Conditions for A = B", year=2001),
            _block("two", title="Conditions for A \u2260 B", year=2001),
        ]
        report = MOD.compare_blocks(blocks)
        self.assertEqual(report["fields"]["title"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")
        agreeing = [_block("one", title="A \u2260 B", year=2001), _block("two", title="A =\u0338 B", year=2001)]
        self.assertEqual(MOD.compare_blocks(agreeing)["fields"]["title"]["status"], "agree")

    def test_latex_macron_accent_still_folds_to_its_letter(self):
        self.assertEqual(MOD.fold_text(r"M\=aori studies"), MOD.fold_text("M\u0101ori studies"))
        self.assertEqual(MOD.fold_text(r"M\=aori studies"), "maori studies")
        # an escaped backslash (LaTeX line break) before "=" is not a macron: the relation survives
        self.assertEqual(MOD.fold_text("A\\\\=B"), MOD.fold_text("A = B"))
        # the run's parity decides: three backslashes = line break + macron, four = two escaped backslashes + relation
        self.assertEqual(MOD.fold_text("M\\\\\\=aori studies"), "m aori studies")  # the line break splits the word; "=" is no relation
        self.assertEqual(MOD.fold_text("A\\\\\\\\=B"), MOD.fold_text("A = B"))

    def test_latex_spacing_commands_are_whitespace_not_relations(self):
        for spacing in ("\\,", "\\;", "\\:", "\\!", "\\>", "\\ "):
            self.assertEqual(MOD.fold_text(f"A {spacing} B"), MOD.fold_text("A B"), spacing)
            self.assertEqual(MOD.fold_text(f"A{spacing}B"), "a b", spacing)
        self.assertNotEqual(MOD.fold_text("A \\> B"), MOD.fold_text("A > B"))  # a medium space is not the relation ">"
        # an escaped backslash pair (a line break) before ">" leaves the relation in place; three = line break + spacing command
        self.assertEqual(MOD.fold_text("A\\\\> B"), MOD.fold_text("A > B"))
        self.assertEqual(MOD.fold_text("A\\\\\\> B"), MOD.fold_text("A B"))

    def test_empty_after_folding_is_empty_string(self):
        self.assertEqual(MOD.fold_text("$~{}$"), "")


class AuthorNormalizationTests(unittest.TestCase):
    def test_comma_and_natural_order_agree(self):
        self.assertEqual(
            MOD.extract_family_name("Smith, John"),
            MOD.extract_family_name("John Smith"),
        )

    def test_initials_and_full_given_names_agree(self):
        self.assertEqual(
            MOD.extract_family_name("J. A. Smith"),
            MOD.extract_family_name("John Albert Smith"),
        )

    def test_particles_fold_into_family(self):
        self.assertEqual(
            MOD.extract_family_name("Johannes van der Waals"),
            MOD.extract_family_name("van der Waals, Johannes"),
        )
        self.assertEqual(MOD.extract_family_name("Johannes van der Waals"), "vanderwaals")

    def test_bare_particle_family_is_kept_whole(self):
        # A lowercase particle head on a bare name marks a family name, so
        # family-only provider records agree with given-name records.
        for spelling in ("de Groot", "A. de Groot", "de Groot, A.", "Anna de Groot"):
            self.assertEqual(MOD.extract_family_name(spelling), "degroot", spelling)
        for spelling in ("von Neumann", "J. von Neumann", "von Neumann, John"):
            self.assertEqual(MOD.extract_family_name(spelling), "vonneumann", spelling)
        for spelling in ("van't Hoff", "J. van't Hoff", "van't Hoff, J.", "van 't Hoff"):
            self.assertEqual(MOD.extract_family_name(spelling), "vanthoff", spelling)

    def test_capitalized_particle_head_reads_as_given_name(self):
        # "Van" here is a given name, not a particle prefix of the family.
        self.assertEqual(MOD.extract_family_name("Van Morrison"), "morrison")
        self.assertEqual(
            MOD.extract_family_name("Van Morrison"),
            MOD.extract_family_name("Morrison, Van"),
        )

    def test_accented_family_matches_latex_family(self):
        self.assertEqual(
            MOD.extract_family_name(r"Schr\"odinger, Erwin"),
            MOD.extract_family_name("Erwin Schrödinger"),
        )

    def test_suffix_is_dropped_in_natural_order(self):
        self.assertEqual(MOD.extract_family_name("Martin Smith Jr."), "smith")

    def test_suffix_is_dropped_across_all_comma_forms(self):
        # "John Smith, Jr." is a natural-order name whose comma introduces a
        # suffix, "Smith Jr., John" is a comma form whose family part carries
        # the suffix, and "Smith, John, Jr." is a three-segment comma form.
        # All must agree with the plain forms.
        for spelling in (
            "Smith, John",
            "John Smith",
            "John Smith Jr.",
            "John Smith, Jr.",
            "Smith Jr., John",
            "Smith, John, Jr.",
            "SMITH, JOHN, JR",
        ):
            self.assertEqual(MOD.extract_family_name(spelling), "smith", spelling)

    def test_initials_only_difference_is_tolerated_by_design(self):
        # Documented limitation: family-name comparison cannot distinguish
        # two different people sharing a family name and position ("J. Smith"
        # versus "B. Smith"); the raw author rows in the report carry the
        # given names for human inspection.
        self.assertEqual(
            MOD.extract_family_name("J. Smith"),
            MOD.extract_family_name("B. Smith"),
        )


class DoiNormalizationTests(unittest.TestCase):
    def test_url_prefix_and_case_fold(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1103/PhysRevD.104.114034"),
            MOD.normalize_doi("10.1103/physrevd.104.114034"),
        )

    def test_doi_scheme_prefix_and_trailing_dot(self):
        self.assertEqual(
            MOD.normalize_doi("doi:10.1000/ABC.123."),
            "10.1000/abc.123",
        )

    def test_url_query_and_fragment_are_transport_artifacts(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1000/ABC?utm_source=x#frag"),
            "10.1000/abc",
        )

    def test_url_percent_encoding_is_decoded(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1002/%28SICI%291234"),
            "10.1002/(sici)1234",
        )

    def test_bare_doi_form_keeps_question_mark(self):
        # Query stripping applies to URL forms only: a rare DOI name may
        # itself contain "?" and the doi: form is not a URL.
        self.assertEqual(MOD.normalize_doi("doi:10.1000/a?b"), "10.1000/a?b")

    def test_trailing_copy_paste_punctuation_is_stripped(self):
        self.assertEqual(MOD.normalize_doi("10.1000/xyz;"), "10.1000/xyz")

    def test_preprint_registry_version_suffix_folds(self):
        # The preprint registry's DataCite DOIs are version-agnostic: the
        # versioned and unversioned spellings denote the same work.
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.2109.01038v2"),
            MOD.normalize_doi("10.48550/arxiv.2109.01038"),
        )
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.48550/arXiv.2109.01038v1"),
            "10.48550/arxiv.2109.01038",
        )
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.hep-ph/9901234v3"),
            MOD.normalize_doi("10.48550/arxiv.hep-ph/9901234"),
        )
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.2109.01038v12."),
            "10.48550/arxiv.2109.01038",
        )
        # Casefolding runs before the fold, so an uppercase suffix (and an
        # uppercase registry spelling) folds identically.
        self.assertEqual(
            MOD.normalize_doi("10.48550/ARXIV.2109.01038V2"),
            "10.48550/arxiv.2109.01038",
        )

    def test_mixed_trailing_junk_is_fully_stripped(self):
        # Trailing copy-paste tails mixing slashes and punctuation strip to
        # a fixed point, so they cannot block the version fold.
        self.assertEqual(MOD.normalize_doi("10.1000/xyz/."), "10.1000/xyz")
        self.assertEqual(
            MOD.normalize_doi("10.48550/arxiv.2109.01038v2/."),
            "10.48550/arxiv.2109.01038",
        )

    def test_version_folding_never_merges_distinct_ids(self):
        # Negative controls: folding must not make genuinely different
        # identifiers compare equal.
        self.assertNotEqual(
            MOD.normalize_doi("10.48550/arxiv.2109.01038v2"),
            MOD.normalize_doi("10.48550/arxiv.2109.01039"),
        )
        self.assertNotEqual(
            MOD.normalize_doi("10.48550/arxiv.2109.01038"),
            MOD.normalize_doi("10.48550/arxiv.2109.0103"),
        )

    def test_version_suffix_outside_preprint_registry_is_kept(self):
        # Elsewhere a trailing "v" + digits can be a legitimate part of the
        # registered DOI name, so the fold is scoped to the preprint-registry
        # prefix and must not fire on other registrants.
        self.assertEqual(MOD.normalize_doi("10.1000/xyzv2"), "10.1000/xyzv2")
        self.assertNotEqual(
            MOD.normalize_doi("10.1000/xyzv2"), MOD.normalize_doi("10.1000/xyz")
        )
        self.assertEqual(
            MOD.normalize_doi("10.5555/collection.123.v2"),
            "10.5555/collection.123.v2",
        )

    def test_bare_version_only_suffix_is_not_folded(self):
        # A degenerate "id" that is nothing but a version marker is left
        # alone rather than folded to an empty identifier.
        self.assertEqual(
            MOD.normalize_doi("10.48550/arxiv.v2"), "10.48550/arxiv.v2"
        )


class VerdictTests(unittest.TestCase):
    def _report(self, blocks, citation_key=None):
        validated = [MOD._validate_block(block, "test") for block in blocks]
        return MOD.build_report(validated, citation_key)

    def test_consistent_two_providers(self):
        report = self._report(
            [
                _block(
                    "arxiv",
                    title=r"Study of the $\alpha$ decay",
                    authors=["J. Smith", "A. de Groot"],
                    year=2021,
                    doi="10.1103/PhysRevD.104.114034",
                ),
                _block(
                    "openalex",
                    title="Study of the α decay",
                    authors=["John Smith", "Anna De Groot"],
                    year=2021,
                    doi="https://doi.org/10.1103/physrevd.104.114034",
                ),
            ]
        )
        self.assertEqual(report["verdict"], "consistent")
        self.assertEqual(report["exit_code"], 0)
        for field in ("title", "authors", "year", "doi"):
            self.assertEqual(report["fields"][field]["status"], "agree")

    def test_year_off_by_one_is_conflicted(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2020),
                _block("openalex", title="Same title", year=2021),
            ]
        )
        self.assertEqual(report["fields"]["year"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")
        self.assertEqual(report["exit_code"], 1)

    def test_author_count_mismatch_is_conflicted(self):
        report = self._report(
            [
                _block("arxiv", authors=["J. Smith", "B. Doe"], year=2021),
                _block("inspire", authors=["J. Smith"], year=2021),
            ]
        )
        self.assertEqual(report["fields"]["authors"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")

    def test_single_provider_is_insufficient(self):
        report = self._report([_block("arxiv", title="Only one record", year=2020)])
        self.assertEqual(report["verdict"], "insufficient_sources")
        self.assertEqual(report["exit_code"], 2)

    def test_all_key_fields_missing_is_insufficient(self):
        report = self._report(
            [
                _block("arxiv", venue="Some venue"),
                _block("openalex", title="Only here"),
            ]
        )
        self.assertEqual(report["verdict"], "insufficient_sources")
        self.assertEqual(report["exit_code"], 2)

    def test_partial_missing_fields_still_consistent(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2021),
                _block("openalex", title="Same title", doi="10.1000/xyz"),
            ]
        )
        self.assertEqual(report["fields"]["title"]["status"], "agree")
        self.assertEqual(report["fields"]["year"]["status"], "missing")
        self.assertEqual(report["fields"]["doi"]["status"], "missing")
        self.assertEqual(report["verdict"], "consistent")

    def test_doi_version_variant_is_not_a_conflict(self):
        # A versioned preprint-registry DOI and its unversioned form are the
        # same identifier; records differing only in the version suffix must
        # not read as an identifier conflict.
        report = self._report(
            [
                _block(
                    "arxiv",
                    title="Same title",
                    doi="10.48550/arXiv.2109.01038v2",
                ),
                _block(
                    "openalex",
                    title="Same title",
                    doi="10.48550/arxiv.2109.01038",
                ),
            ]
        )
        self.assertEqual(report["fields"]["doi"]["status"], "agree")
        self.assertEqual(report["verdict"], "consistent")

    def test_different_preprint_ids_still_conflict(self):
        report = self._report(
            [
                _block(
                    "arxiv",
                    title="Same title",
                    doi="10.48550/arXiv.2109.01038v2",
                ),
                _block(
                    "openalex",
                    title="Same title",
                    doi="10.48550/arxiv.2109.01039",
                ),
            ]
        )
        self.assertEqual(report["fields"]["doi"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")

    def test_venue_difference_never_conflicts(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2021, venue="Phys. Rev. D"),
                _block(
                    "openalex",
                    title="Same title",
                    year=2021,
                    venue="Physical Review D",
                ),
            ]
        )
        self.assertEqual(report["fields"]["venue"]["status"], "reported")
        self.assertEqual(report["verdict"], "consistent")

    def test_disagreement_pairs_are_named(self):
        report = self._report(
            [
                _block("arxiv", year=2020, title="Same title"),
                _block("openalex", year=2021, title="Same title"),
                _block("inspire", year=2020, title="Same title"),
            ]
        )
        pairs = report["fields"]["year"]["disagreements"]
        self.assertIn(["arxiv", "openalex"], pairs)
        self.assertIn(["openalex", "inspire"], pairs)


class ValidationTests(unittest.TestCase):
    def _expect_input_error(self, block, fragment):
        with self.assertRaises(MOD.InputError) as ctx:
            MOD._validate_block(block, "test")
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_field_key_is_rejected(self):
        block = _block("arxiv")
        del block["doi"]
        self._expect_input_error(block, "missing provider-block keys")

    def test_unknown_field_key_is_rejected(self):
        block = _block("arxiv", extra="oops")
        self._expect_input_error(block, "unknown provider-block keys")

    def test_empty_provider_is_rejected(self):
        self._expect_input_error(_block("  "), "'provider'")

    def test_bad_year_type_is_rejected(self):
        self._expect_input_error(_block("arxiv", year=20.21), "'year'")
        self._expect_input_error(_block("arxiv", year=True), "'year'")
        self._expect_input_error(_block("arxiv", year="21"), "'year'")

    def test_year_string_is_coerced(self):
        validated = MOD._validate_block(_block("arxiv", year="2021"), "test")
        self.assertEqual(validated["year"], 2021)

    def test_non_doi_string_is_rejected(self):
        self._expect_input_error(
            _block("arxiv", doi="arXiv:2109.01038"), "does not look like a DOI"
        )

    def test_empty_author_list_is_rejected(self):
        self._expect_input_error(_block("arxiv", authors=[]), "'authors'")

    def test_non_string_author_is_rejected(self):
        self._expect_input_error(_block("arxiv", authors=["Ok Name", 7]), "authors[1]")

    def test_duplicate_provider_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "dup.json",
                [_block("arxiv", year=2021), _block("ArXiv", year=2021)],
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("duplicate provider", str(ctx.exception))

    def test_conflicting_citation_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = _write_json(
                tmp,
                "a.json",
                {"citation_key": "smith2021", "providers": [_block("arxiv", year=2021)]},
            )
            second = _write_json(
                tmp,
                "b.json",
                {"citation_key": "doe2020", "providers": [_block("openalex", year=2021)]},
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([first, second])
            self.assertIn("conflicting citation_key", str(ctx.exception))

    def test_unknown_container_key_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "c.json",
                {"providers": [_block("arxiv")], "extra": 1},
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("unknown container keys", str(ctx.exception))

    def test_empty_providers_list_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(tmp, "empty.json", {"providers": []})
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("non-empty list", str(ctx.exception))

    def test_title_normalizing_to_empty_is_rejected(self):
        self._expect_input_error(
            _block("arxiv", title="$~{}$"), "normalizes to an empty string"
        )


class CliTests(unittest.TestCase):
    def _run(self, arguments, cwd):
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH)] + arguments,
            capture_output=True,
            text=True,
            cwd=cwd,
        )

    def test_unexpected_internal_failure_exits_5_never_a_verdict(self):
        # Python's default exit for an uncaught exception is 1, which this contract
        # names "conflicted"; a crash must leave through its own code instead.
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(tmp, "arxiv.json", _block("arxiv", title="A title", authors=["J. Smith"], year=2021, doi="10.1000/xyz123"))
            out_json = os.path.join(tmp, "report.json")
            original = MOD.build_report
            try:
                def boom(*args, **kwargs):
                    raise RuntimeError("synthetic crash")
                MOD.build_report = boom
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    rc = MOD.main([path, "--out-json", out_json])
            finally:
                MOD.build_report = original
            self.assertEqual(rc, MOD.EXIT_UNEXPECTED_FAILURE)
            self.assertEqual(MOD.EXIT_UNEXPECTED_FAILURE, 5)
            self.assertNotIn(rc, set(MOD.VERDICT_EXIT_CODES.values()) | {MOD.EXIT_INVALID_INPUT, MOD.EXIT_WRITE_FAILURE})
            self.assertIn("unexpected failure: RuntimeError: synthetic crash", stderr.getvalue())
            self.assertFalse(os.path.exists(out_json))  # nothing was persisted

    def test_stdout_encoding_failure_after_the_reports_keeps_the_verdict_code(self):
        for extra in ([], ["--quiet"]):
            with tempfile.TemporaryDirectory() as tmp:
                path = _write_json(tmp, "arxiv.json", _block("arxiv", title="A title", authors=["J. Smith"], year=2021, doi="10.1000/xyz123"))
                out_json, out_md = os.path.join(tmp, "report.json"), os.path.join(tmp, "report.md")
                ascii_stdout = io.TextIOWrapper(io.BytesIO(), encoding="ascii", errors="strict")
                stderr = io.StringIO()
                with contextlib.redirect_stdout(ascii_stdout), contextlib.redirect_stderr(stderr):
                    rc = MOD.main([path, "--citation-key", "cl\u00e9", "--out-json", out_json, "--out-md", out_md] + extra)
                self.assertEqual(rc, MOD.EXIT_INSUFFICIENT, extra)  # one block: the computed verdict survives the print failure
                self.assertTrue(os.path.exists(out_json) and os.path.exists(out_md), extra)
                self.assertIn("could not encode the summary", stderr.getvalue(), extra)

    def test_consistent_run_exit_zero_and_reports_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            arxiv = _write_json(
                tmp,
                "arxiv.json",
                _block(
                    "arxiv",
                    title="A shared title",
                    authors=["J. Smith"],
                    year=2021,
                    doi="10.1000/xyz123",
                ),
            )
            openalex = _write_json(
                tmp,
                "openalex.json",
                _block(
                    "openalex",
                    title="A Shared Title",
                    authors=["John Smith"],
                    year=2021,
                    doi="HTTPS://DOI.ORG/10.1000/XYZ123",
                ),
            )
            out_json = os.path.join(tmp, "out", "report.json")
            out_md = os.path.join(tmp, "out", "report.md")
            result = self._run(
                [
                    arxiv,
                    openalex,
                    "--citation-key",
                    "smith2021",
                    "--out-json",
                    out_json,
                    "--out-md",
                    out_md,
                ],
                cwd=tmp,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("verdict [smith2021]: consistent", result.stdout)

            report = json.loads(Path(out_json).read_text(encoding="utf-8"))
            self.assertEqual(report["verdict"], "consistent")
            self.assertEqual(report["citation_key"], "smith2021")
            self.assertEqual(report["exit_code"], 0)

            markdown = Path(out_md).read_text(encoding="utf-8")
            self.assertIn("consistent", markdown)
            self.assertIn("| title |", markdown)

            leftovers = [
                name
                for name in os.listdir(os.path.join(tmp, "out"))
                if name.startswith(".tmp-")
            ]
            self.assertEqual(leftovers, [])

    def test_conflicted_run_exit_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                {
                    "citation_key": "smith2021",
                    "providers": [
                        _block("arxiv", title="Same title", year=2020),
                        _block("openalex", title="Same title", year=2021),
                    ],
                },
            )
            result = self._run([path], cwd=tmp)
            self.assertEqual(result.returncode, 1)
            self.assertIn("conflicted", result.stdout)

    def test_single_provider_exit_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(tmp, "one.json", _block("arxiv", year=2021))
            result = self._run([path], cwd=tmp)
            self.assertEqual(result.returncode, 2)
            self.assertIn("insufficient_sources", result.stdout)

    def test_invalid_json_exit_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            path.write_text("{not json", encoding="utf-8")
            result = self._run([str(path)], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertIn("invalid JSON", result.stderr)

    def test_invalid_utf8_input_exit_three_and_no_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "bad.json")
            Path(path).write_bytes(b'{"provider": "a", "title": "\xff\xfe"}')
            out_json = os.path.join(directory, "report.json")
            completed = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), path, "--out-json", out_json, "--out-md", os.path.join(directory, "report.md")],
                capture_output=True, text=True,
            )
            self.assertEqual(completed.returncode, MOD.EXIT_INVALID_INPUT, completed.stderr)
            self.assertIn("not valid UTF-8", completed.stderr)
            self.assertFalse(os.path.exists(out_json))

    def test_escaped_unpaired_surrogate_is_invalid_input_not_a_verdict(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "blocks.json")
            Path(path).write_text('[{"provider": "a", "title": "T\\ud800", "authors": null, "year": 2001, "doi": null, "venue": null, "identifier": null},'
                                  ' {"provider": "b", "title": "T\\ud800", "authors": null, "year": 2001, "doi": null, "venue": null, "identifier": null}]')
            out_json = os.path.join(directory, "report.json")
            completed = subprocess.run([sys.executable, str(SCRIPT_PATH), path, "--out-json", out_json], capture_output=True, text=True)
            self.assertEqual(completed.returncode, MOD.EXIT_INVALID_INPUT, completed.stderr)
            self.assertIn("cannot be written as UTF-8", completed.stderr)
            self.assertFalse(os.path.exists(out_json))

    def test_escaped_unpaired_surrogate_in_citation_key_is_invalid_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "blocks.json")
            Path(path).write_text('{"citation_key": "T\\ud800", "providers": ['
                                  '{"provider": "a", "title": "T", "authors": null, "year": 2001, "doi": null, "venue": null, "identifier": null},'
                                  ' {"provider": "b", "title": "T", "authors": null, "year": 2001, "doi": null, "venue": null, "identifier": null}]}')
            completed = subprocess.run([sys.executable, str(SCRIPT_PATH), path], capture_output=True, text=True)  # no outputs: the verdict line itself is printed
            self.assertEqual(completed.returncode, MOD.EXIT_INVALID_INPUT, completed.stderr)
            self.assertIn("cannot be written as UTF-8", completed.stderr)
            self.assertEqual(MOD.main([path, "--citation-key", "x\ud800"]), MOD.EXIT_INVALID_INPUT)

    def test_missing_file_exit_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run([os.path.join(tmp, "absent.json")], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertIn("cannot read input file", result.stderr)

    def test_schema_error_exit_three_and_no_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            block = _block("arxiv", year=2021)
            del block["title"]
            path = _write_json(tmp, "bad.json", block)
            out_json = os.path.join(tmp, "report.json")
            result = self._run([path, "--out-json", out_json], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertFalse(os.path.exists(out_json))

    def test_unwritable_report_path_exit_four(self):
        # An unusable output path must not surface a verdict exit code:
        # rc=1 would read as "conflicted" to automation.
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("arxiv", title="Same title", year=2021),
                    _block("openalex", title="Same title", year=2021),
                ],
            )
            blocker = Path(tmp) / "not-a-dir"
            blocker.write_text("occupied", encoding="utf-8")
            out_json = os.path.join(str(blocker), "report.json")
            result = self._run([path, "--out-json", out_json], cwd=tmp)
            self.assertEqual(result.returncode, 4)
            self.assertIn("cannot write report", result.stderr)

    def test_aliased_output_paths_are_rejected_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = _write_json(directory, "blocks.json", [
                _block("a", title="T", year=2001, doi="10.1000/x"), _block("b", title="T", year=2001, doi="10.1000/x"),
            ])
            before = Path(path).read_bytes()
            same = os.path.join(directory, "report.out")
            rc = MOD.main([path, "--out-json", same, "--out-md", same])
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertFalse(os.path.exists(same))
            rc = MOD.main([path, "--out-json", path])  # output aliasing the input
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(Path(path).read_bytes(), before)
            link = os.path.join(directory, "link.json"); os.symlink(path, link)
            rc = MOD.main([path, "--out-md", link])  # symlink alias of the input
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(Path(path).read_bytes(), before)
            insensitive = MOD._directory_is_case_insensitive(directory)
            self.assertEqual(insensitive, os.path.exists(os.path.join(directory, "BLOCKS.JSON")))  # the probe agrees with the filesystem
            upper = os.path.join(directory, "BLOCKS.JSON")
            rc = MOD.main([path, "--out-json", upper])  # case variant of an existing input
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT if insensitive else MOD.EXIT_CONSISTENT)
            self.assertEqual(Path(path).read_bytes(), before)
            # two outputs that do not exist yet and differ only in case
            rc = MOD.main([path, "--out-json", os.path.join(directory, "Report.json"), "--out-md", os.path.join(directory, "report.json")])
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT if insensitive else MOD.EXIT_CONSISTENT)
            if insensitive:
                self.assertFalse(os.path.exists(os.path.join(directory, "Report.json")))
            else:  # case-sensitive: distinct files, both written
                self.assertTrue(os.path.exists(os.path.join(directory, "Report.json")) and os.path.exists(os.path.join(directory, "report.json")))
            hard = os.path.join(directory, "hard.json"); os.link(path, hard)
            rc = MOD.main([path, "--out-json", hard])  # hard-link alias of the input
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(Path(path).read_bytes(), before)

    def test_case_probe_swaps_only_the_file_name(self):
        with tempfile.TemporaryDirectory() as directory:
            nested = os.path.join(directory, "MixedCase", "dir"); os.makedirs(nested)
            queried = []
            original_exists = MOD.os.path.exists
            def recording_exists(p):
                queried.append(p); return original_exists(p)
            MOD._CASE_INSENSITIVE_CACHE.clear()
            MOD.os.path.exists = recording_exists
            try:
                MOD._directory_is_case_insensitive(nested)
            finally:
                MOD.os.path.exists = original_exists
            probes = [q for q in queried if os.path.basename(q).startswith(".cASEpROBE-")]
            self.assertTrue(probes, queried)
            self.assertTrue(all(os.path.dirname(q) == nested for q in probes), probes)  # ancestors keep their spelling

    def test_cli_paths_resolve_in_filesystem_order(self):
        with tempfile.TemporaryDirectory() as directory:
            base, remote = os.path.join(directory, "base"), os.path.join(directory, "remote")
            os.makedirs(os.path.join(remote, "child")); os.makedirs(base)
            os.symlink(os.path.join(remote, "child"), os.path.join(base, "link"))  # /base/link -> /remote/child
            blocks = [_block("a", title="T", year=2001, doi="10.1000/x"), _block("b", title="T", year=2001, doi="10.1000/x")]
            inp = _write_json(remote, "input.json", blocks)  # /remote/input.json
            spelled_input = os.path.join(base, "link", "..", "input.json")  # the filesystem reads this as /remote/input.json
            before = Path(inp).read_bytes()
            rc = MOD.main([spelled_input, "--out-json", inp])  # output names the very file the input opens
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(Path(inp).read_bytes(), before)
            rc = MOD.main([inp, "--out-json", os.path.join(base, "link", "..", "report.json")])
            self.assertEqual(rc, MOD.EXIT_CONSISTENT)
            self.assertTrue(os.path.exists(os.path.join(remote, "report.json")))   # written where the filesystem points
            self.assertFalse(os.path.exists(os.path.join(base, "report.json")))    # not where lexical normalization would

    def test_quiet_flag_prints_only_verdict_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("arxiv", title="Same title", year=2021),
                    _block("openalex", title="Same title", year=2021),
                ],
            )
            result = self._run([path, "--quiet"], cwd=tmp)
            self.assertEqual(result.returncode, 0)
            lines = [line for line in result.stdout.splitlines() if line.strip()]
            self.assertEqual(lines, ["verdict: consistent"])

    def test_markdown_cell_truncation_never_splits_an_escape(self):
        cell = MOD._markdown_cell("x" * 76 + "|" + "y" * 10)  # the inserted "\\|" straddles the cut
        self.assertEqual(cell, "x" * 76 + "...")
        self.assertFalse(cell[:-3].endswith("\\"))

    def test_markdown_cell_folds_carriage_returns(self):
        self.assertEqual(MOD._markdown_cell("a\r\nb|c"), "a  b\\|c")

    def test_markdown_pipes_are_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("ar|xiv", title="A | B", year=2021),
                    _block("openalex", title="A | B", year=2021),
                ],
            )
            out_md = os.path.join(tmp, "report.md")
            result = self._run([path, "--out-md", out_md], cwd=tmp)
            self.assertEqual(result.returncode, 0)
            markdown = Path(out_md).read_text(encoding="utf-8")
            self.assertIn("ar\\|xiv", markdown)
            self.assertIn("A \\| B", markdown)


if __name__ == "__main__":
    unittest.main()
