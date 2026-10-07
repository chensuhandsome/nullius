"""Tests for fetch_citation_records.py with an injected offline fetcher.

The fixtures keep the real response STRUCTURE of each public API (Crossref,
OpenAlex, INSPIRE, arXiv Atom, Open Library) with synthetic content, so the
tests exercise the parsers without touching the network.
"""

import importlib.util
import contextlib
import io
import json
import sys
import subprocess
import shutil
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "bin" / "fetch_citation_records.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _load_module():
    spec = importlib.util.spec_from_file_location("fetch_citation_records", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _load_module()

DOI = "10.1000/example.12.012345"
ARXIV = "example-ph/0001001"
ISBN = "9780000000002"


def _fixture(name):
    return (FIXTURES / name).read_bytes()


class FakeFetcher:
    """Route URLs to fixture bodies; record every URL requested."""

    def __init__(self, overrides=None, failing_substrings=(), redirects=None):
        self.urls = []
        self.overrides = overrides or {}
        self.failing_substrings = tuple(failing_substrings)
        self.redirects = redirects or {}  # URL substring -> the URL that finally served the bytes

    def __call__(self, url, headers, timeout):
        self.urls.append(url)
        for needle in self.failing_substrings:
            if needle in url:
                raise urllib.error.URLError("simulated transport failure")
        status, response_headers, body = self._respond(url)
        final_url = next((target for needle, target in self.redirects.items() if needle in url), url)
        return status, response_headers, body, final_url

    def _respond(self, url):
        for needle, response in self.overrides.items():
            if needle in url:
                return response
        if "api.crossref.org/works/" in url:
            return 200, {"content-type": "application/json"}, _fixture("crossref_work.json")
        if "api.openalex.org/works/" in url:
            return 200, {"content-type": "application/json"}, _fixture("openalex_work.json")
        if "inspirehep.net/api/literature?q=" in url:
            return 200, {"content-type": "application/json"}, _fixture("inspire_search_one_hit.json")
        if "inspirehep.net/api/doi/" in url or "inspirehep.net/api/arxiv/" in url or "inspirehep.net/api/literature/" in url:
            return 200, {"content-type": "application/json"}, _fixture("inspire_record.json")
        if "export.arxiv.org/api/query" in url:
            return 200, {"content-type": "application/atom+xml"}, _fixture("arxiv_query.xml")
        if f"openlibrary.org/isbn/{ISBN}.json" in url:
            return 200, {"content-type": "application/json"}, _fixture("openlibrary_edition.json")
        if "openlibrary.org/authors/" in url:
            return 200, {"content-type": "application/json"}, _fixture("openlibrary_author.json")
        return 404, {"content-type": "application/json"}, b"{}"


def _run(args, fetcher):
    return MOD.main(args, fetcher=fetcher, sleep=lambda _seconds: None)


def _snapshot(root):
    """Recursive {relative path: bytes} snapshot of an output directory."""
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            out[os.path.relpath(full, root)] = Path(full).read_bytes()
    return out


def _read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


class IdentifierParsingTests(unittest.TestCase):
    def test_prefixed_and_bare_forms(self):
        self.assertEqual(MOD.parse_identifier(f"doi:{DOI}"), ("doi", DOI))
        self.assertEqual(MOD.parse_identifier(f"https://doi.org/{DOI.upper()}"), ("doi", DOI))
        self.assertEqual(MOD.parse_identifier("10.1000/XYZ123"), ("doi", "10.1000/xyz123"))
        self.assertEqual(MOD.parse_identifier("arxiv:2109.01038v2"), ("arxiv", "2109.01038"))
        self.assertEqual(MOD.parse_identifier("https://arxiv.org/abs/2109.01038"), ("arxiv", "2109.01038"))
        self.assertEqual(MOD.parse_identifier(f"arXiv:{ARXIV}"), ("arxiv", ARXIV))
        self.assertEqual(MOD.parse_identifier("https://inspirehep.net/literature/1000001"), ("inspire", "1000001"))
        self.assertEqual(MOD.canonical_identifier("inspire", "0001000001"), "1000001")  # zero padding is not a different record
        self.assertEqual(MOD.parse_identifier("isbn: 978-0-000-00000-2"), ("isbn", ISBN))
        self.assertEqual(MOD.parse_identifier("jref:Ex.Rev.Lett.,12,012345"), ("jref", "Ex.Rev.Lett.,12,012345"))

    def test_doi_url_with_query_tail_and_encoding_is_normalized_whole(self):
        self.assertEqual(MOD.parse_identifier(f"https://doi.org/{DOI.upper()}?utm_source=x#frag"), ("doi", DOI))
        self.assertEqual(MOD.parse_identifier("https://doi.org/10.1000/a%28b%29"), ("doi", "10.1000/a(b)"))

    def test_inspire_url_with_trailing_text_is_rejected(self):
        with self.assertRaises(MOD.InputError):
            MOD.parse_identifier("https://inspirehep.net/literature/1000001anything")
        self.assertEqual(MOD.parse_identifier("https://inspirehep.net/literature/1000001?ln=en"), ("inspire", "1000001"))

    def test_isbn_with_wrong_check_digit_is_rejected_as_input(self):
        with self.assertRaises(MOD.InputError):
            MOD.parse_identifier("isbn:0306406153")  # valid form, wrong check digit
        self.assertEqual(MOD.parse_identifier("isbn:0306406152"), ("isbn", "0306406152"))
        self.assertIsNone(MOD._normalize_isbn("0306406153"))  # record values with a bad check digit never match anything

    def test_journal_reference_must_have_three_parts(self):
        for bad in ("jref:Ex.Rev.Lett.,12", "jref:Ex.Rev.Lett.,,012345", "jref:Ex.Rev.Lett.,12,012345,extra"):
            with self.assertRaises(MOD.InputError, msg=bad):
                MOD.parse_identifier(bad)
        self.assertEqual(MOD.parse_identifier("jref: Ex.Rev.Lett. , 12 , 012345 "), ("jref", "Ex.Rev.Lett.,12,012345"))
        self.assertEqual(MOD.parse_identifier("jref:Ex.Rev.Lett.,12,012345-012350"), ("jref", "Ex.Rev.Lett.,12,012345"))  # range → start page
        self.assertEqual(MOD.parse_identifier("jref:Ex.Rev.Lett.,12,A-123"), ("jref", "Ex.Rev.Lett.,12,A-123"))  # article id kept whole
        self.assertEqual(MOD.parse_identifier("jref:Ex.Rev.Lett.,12,123\u2014130"), ("jref", "Ex.Rev.Lett.,12,123"))  # em dash range

    def test_unclassifiable_identifier_is_rejected(self):
        with self.assertRaises(MOD.InputError):
            MOD.parse_identifier("Example 2005 recursion")
        with self.assertRaises(MOD.InputError):
            MOD.parse_identifier("inspire:not-digits")


class SingleCitationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "out")

    def tearDown(self):
        self.tmp.cleanup()

    def test_doi_input_fetches_three_providers_chains_arxiv_and_reports_title_conflict(self):
        fetcher = FakeFetcher()
        rc = _run(["--id", f"doi:{DOI}", "--citation-key", "k1", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)

        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["admitted_providers"], ["crossref", "openalex", "inspire", "arxiv"])
        self.assertEqual(log["providers"]["arxiv"]["lookup"]["derived_from"], ["inspire"])
        self.assertEqual(log["providers"]["openlibrary"]["status"], "not_queried")

        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        by_provider = {b["provider"]: b for b in blocks["providers"]}
        self.assertEqual(blocks["citation_key"], "k1")
        for provider in ("crossref", "openalex", "inspire", "arxiv"):
            self.assertEqual(len(by_provider[provider]["authors"]), 4, provider)
        self.assertEqual(by_provider["crossref"]["authors"][0], "Example, Alice")
        self.assertEqual(by_provider["inspire"]["identifier"], "1000001")
        self.assertEqual(by_provider["arxiv"]["identifier"], f"{ARXIV}v2")
        arxiv_details = log["providers"]["arxiv"]["details"]
        self.assertEqual((arxiv_details["search_hits_total"], arxiv_details["search_hits_returned"]), (1, 1))

        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertEqual(report["verdict"], "conflicted")
        self.assertEqual(report["fields"]["title"]["status"], "disagree")  # preprint vs journal title
        self.assertEqual(report["fields"]["authors"]["status"], "agree")
        self.assertEqual(report["fields"]["year"]["status"], "agree")
        self.assertEqual(report["fields"]["doi"]["status"], "agree")
        self.assertTrue(os.path.exists(os.path.join(self.out, "report.md")))

    def test_raw_responses_are_saved_byte_exact_with_hashes(self):
        fetcher = FakeFetcher()
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        self.assertEqual(len(fetcher.urls), 1)
        self.assertIn("api.crossref.org/works/", fetcher.urls[0])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        outcome = log["providers"]["crossref"]
        raw = Path(self.out) / outcome["raw_path"]
        self.assertEqual(raw.read_bytes(), _fixture("crossref_work.json"))
        meta = _read_json(str(raw.with_name("crossref.meta.json")))
        self.assertEqual(meta["sha256"], outcome["raw_sha256"])
        self.assertEqual(meta["url"], fetcher.urls[0])
        self.assertEqual(meta["final_url"], fetcher.urls[0])  # no redirect: the requested URL served the bytes
        self.assertTrue(outcome["raw_sha256"].startswith("sha256:"))
        # Report-only details for identity work: the deposit's author order is kept.
        self.assertEqual(outcome["details"]["deposit_author_order"][0]["sequence"], "first")

    def test_journal_reference_single_hit_is_admitted_and_chains_by_doi(self):
        fetcher = FakeFetcher()
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["lookup"], {"kind": "jref", "value": "Ex.Rev.Lett.,12,012345"})
        self.assertEqual(log["providers"]["crossref"]["lookup"]["derived_from"], ["inspire"])
        self.assertEqual(log["providers"]["crossref"]["lookup"]["value"], DOI)
        self.assertIn("inspirehep.net/api/literature?q=j%20Ex.Rev.Lett.%2C12%2C012345&size=2", fetcher.urls[0])

    def test_journal_reference_with_several_hits_contributes_no_block(self):
        doc = json.loads(_fixture("inspire_search_one_hit.json"))
        doc["hits"]["total"] = 2
        doc["hits"]["hits"].append({"id": "1000002", "metadata": dict(doc["hits"]["hits"][0]["metadata"])})
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/literature?q=": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "ambiguous")
        self.assertEqual(log["admitted_providers"], [])
        self.assertFalse(os.path.exists(os.path.join(self.out, "blocks.json")))
        self.assertEqual(len(fetcher.urls), 1)  # nothing to chain from a refused search

    def test_truncated_author_list_is_nulled_never_completed(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["authors"] = doc["metadata"]["authors"][:3]  # 3 of 4 names returned
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--no-derived"], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        inspire = next(b for b in blocks["providers"] if b["provider"] == "inspire")
        self.assertIsNone(inspire["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("never completed" in n for n in log["providers"]["inspire"]["notes"]))
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertEqual(report["fields"]["authors"]["status"], "agree")  # crossref vs openalex only
        self.assertIsNone(report["fields"]["authors"]["normalized"]["inspire"])

    def test_transport_failure_is_recorded_and_other_providers_continue(self):
        fetcher = FakeFetcher(failing_substrings=("api.crossref.org",))
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "fetch_failed")
        self.assertIn("transport error", log["providers"]["crossref"]["notes"][0])
        self.assertEqual(log["admitted_providers"], ["openalex", "inspire", "arxiv"])
        self.assertTrue(all(r["sha256"].startswith("sha256:") and isinstance(r["bytes"], int) for r in log["requests"]))

    def test_isbn_book_path_single_source_is_insufficient(self):
        fetcher = FakeFetcher()
        rc = _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertEqual(len(blocks["providers"]), 1)
        book = blocks["providers"][0]
        self.assertEqual(book["provider"], "openlibrary")
        self.assertEqual(book["title"], "The Example Theory of Fields, Volume 1")
        self.assertEqual(book["authors"], ["Alice Example"])
        self.assertEqual(book["year"], 2001)
        self.assertEqual(book["venue"], "Example University Press")
        self.assertEqual(book["identifier"], "/books/OL1000001M")
        self.assertIsNone(book["doi"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        details = log["providers"]["openlibrary"]["details"]
        self.assertEqual(details["series"], ["Example Theory of Fields (1)"])
        self.assertEqual(details["subtitle"], "Foundations")
        self.assertEqual(details["isbn_13"], [ISBN])
        self.assertTrue(any("openlibrary.org/authors/OL1000001A.json" in u for u in fetcher.urls))
        self.assertEqual(details["author_fetches"][0]["status"], "ok")
        self.assertEqual(details["author_fetches"][0]["name"], "Alice Example")
        self.assertTrue(details["author_fetches"][0]["raw_sha256"].startswith("sha256:"))

    def test_nameless_author_entry_nulls_the_list_instead_of_shortening_it(self):
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["author"][1] = {"ORCID": "https://orcid.org/0000-0000-0000-0000", "sequence": "additional"}
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        crossref = next(b for b in blocks["providers"] if b["provider"] == "crossref")
        self.assertIsNone(crossref["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("carry no name" in n for n in log["providers"]["crossref"]["notes"]))

    def test_nameless_entries_null_the_list_on_every_provider_path(self):
        inspire = json.loads(_fixture("inspire_record.json"))
        inspire["metadata"]["authors"][1] = {"uuid": "no-name"}
        del inspire["metadata"]["author_count"]
        arxiv = _fixture("arxiv_query.xml").decode().replace("<name>Bob Sample</name>", "", 1).encode()
        edition = json.loads(_fixture("openlibrary_edition.json"))
        edition["authors"].append({"type": "/type/author_role"})
        fetcher = FakeFetcher(overrides={
            "inspirehep.net/api/doi/": (200, {}, json.dumps(inspire).encode()),
            "export.arxiv.org/api/query": (200, {}, arxiv),
            f"openlibrary.org/isbn/{ISBN}.json": (200, {}, json.dumps(edition).encode()),
        })
        _run(["--id", f"doi:{DOI}", "--id", f"arxiv:{ARXIV}", "--id", f"isbn:{ISBN}", "--out-dir", self.out,
              "--providers", "inspire,arxiv,openlibrary"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        for block in blocks["providers"]:
            self.assertIsNone(block["authors"], block["provider"])
            self.assertTrue(any("never shortened" in n for n in log["providers"][block["provider"]]["notes"]), block["provider"])
        self.assertEqual({b["provider"] for b in blocks["providers"]}, {"inspire", "arxiv", "openlibrary"})

    def test_openalex_truncation_flag_nulls_the_author_list(self):
        fetcher = FakeFetcher(overrides={"api.openalex.org/works/": (200, {}, _fixture("openalex_work_truncated.json"))})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "openalex"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("truncated" in n for n in log["providers"]["openalex"]["notes"]))

    def test_oversized_response_body_is_refused_by_the_fetcher(self):
        class FakeResponse:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __init__(self, size): self.size = size
            def read(self, n=-1): return b"x" * (self.size if n < 0 else min(n, self.size))
            def geturl(self): return "https://example.invalid/record?served=1"  # where the bytes finally came from
            def __enter__(self): return self
            def __exit__(self, *exc): return False

        original = MOD.urllib.request.urlopen
        try:
            MOD.urllib.request.urlopen = lambda request, timeout: FakeResponse(MOD.MAX_RESPONSE_BYTES + 1)
            with self.assertRaises(ValueError):
                MOD.urllib_fetcher("https://example.invalid/record", {}, 1.0)
            MOD.urllib.request.urlopen = lambda request, timeout: FakeResponse(1024)
            status, _headers, body, final_url = MOD.urllib_fetcher("https://example.invalid/record", {}, 1.0)
            self.assertEqual((status, len(body), final_url), (200, 1024, "https://example.invalid/record?served=1"))
        finally:
            MOD.urllib.request.urlopen = original

    def test_fetcher_value_error_is_recorded_as_fetch_failure(self):
        class OversizeFetcher(FakeFetcher):
            def __call__(self, url, headers, timeout):
                if "api.crossref.org" in url:
                    raise ValueError("response exceeds limit")
                return super().__call__(url, headers, timeout)

        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], OversizeFetcher())
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "fetch_failed")
        self.assertEqual(log["admitted_providers"], ["openalex"])

    def test_http_protocol_exception_is_a_fetch_failure_not_a_crash(self):
        class ProtocolFailingFetcher(FakeFetcher):
            def __call__(self, url, headers, timeout):
                if "api.openalex.org" in url:
                    raise __import__("http.client").client.IncompleteRead(b"partial")
                return super().__call__(url, headers, timeout)

        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--no-derived"], ProtocolFailingFetcher())
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["openalex"]["status"], "fetch_failed")
        self.assertIn("IncompleteRead", log["providers"]["openalex"]["notes"][0])

    def test_inspire_record_with_several_publication_dois_nulls_doi(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["dois"] = [{"value": "10.1000/erratum.1", "material": "erratum"}, {"value": DOI}, {"value": "10.1000/second"}]
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "inspire"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["doi"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("2 distinct publication DOIs" in n for n in log["providers"]["inspire"]["notes"]))
        self.assertEqual(log["derived_identifiers"]["doi"].keys() & {"10.1000/erratum.1"}, set())

    def test_rerun_command_is_shell_quoted_and_absolute(self):
        out = os.path.join(self.tmp.name, "out dir with spaces")
        _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref,openalex"], FakeFetcher())
        log = _read_json(os.path.join(out, "fetch_log.json"))
        import shlex
        parts = shlex.split(log["comparator"]["rerun_command"])
        self.assertEqual(parts[0], "python3")
        self.assertTrue(os.path.isabs(parts[1]) and parts[1].endswith("triangulate_citation.py"))
        self.assertEqual(parts[2], os.path.join(os.path.realpath(out), "blocks.json"))  # the resolved destination

    def test_openlibrary_author_record_without_name_is_recorded_and_nulls_authors(self):
        fetcher = FakeFetcher(overrides={"openlibrary.org/authors/": (200, {}, b'{"key": "/authors/OL1000001A"}')})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        details = log["providers"]["openlibrary"]["details"]
        self.assertEqual(details["author_fetches"][0]["status"], "no_name")
        self.assertEqual(details["author_keys"], ["/authors/OL1000001A"])

    def test_supplied_record_number_contradicted_by_record_withdraws_it_and_forces_conflicted(self):
        fetcher = FakeFetcher()
        rc = _run(["--id", f"doi:{DOI}", "--id", "inspire:2000002", "--out-dir", self.out, "--no-derived"], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        self.assertTrue(any("inspirehep.net/api/literature/2000002" in u for u in fetcher.urls))  # record number preferred
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "identifier_contradicted")
        self.assertNotIn("inspire", log["admitted_providers"])
        checks = {(c["kind"], c["provider"]): c["status"] for c in log["supplied_identifier_checks"]}
        self.assertEqual(checks[("inspire", "inspire")], "contradicted")
        self.assertEqual(checks[("doi", "crossref")], "matched")
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertEqual(report["verdict"], "conflicted")
        self.assertTrue(any("supplied inspire '2000002' contradicted" in r for r in report["verdict_reasons"]))
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertEqual({b["provider"] for b in blocks["providers"]}, {"crossref", "openalex"})

    def test_matching_supplied_identifiers_are_recorded_as_matched(self):
        _run(["--id", f"doi:{DOI}", "--id", f"arxiv:{ARXIV}", "--id", "inspire:1000001", "--out-dir", self.out], FakeFetcher())
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        statuses = {c["status"] for c in log["supplied_identifier_checks"]}
        self.assertEqual(statuses - {"not_checkable"}, {"matched"})
        self.assertEqual(log["comparator"]["verdict"], "conflicted")  # the title discrepancy, as before

    def test_explicit_truncation_marker_nulls_the_author_list(self):
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["author"].append({"name": "et al.", "sequence": "additional"})
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        crossref = next(b for b in blocks["providers"] if b["provider"] == "crossref")
        self.assertIsNone(crossref["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("truncation marker" in n for n in log["providers"]["crossref"]["notes"]))

    def test_reusing_an_output_directory_is_refused_unless_overwrite(self):
        fetcher = FakeFetcher()
        self.assertEqual(_run(["--id", f"doi:{DOI}", "--out-dir", self.out], fetcher), MOD.EXIT_CONFLICTED)
        self.assertTrue(os.path.exists(os.path.join(self.out, "raw", "arxiv.xml")))
        before = len(fetcher.urls)
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        self.assertEqual(len(fetcher.urls), before)  # refused before any fetch
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref", "--overwrite"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        self.assertFalse(os.path.exists(os.path.join(self.out, "raw", "arxiv.xml")))  # no stale generation
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertEqual([b["provider"] for b in blocks["providers"]], ["crossref"])

    def test_search_total_disagreeing_with_hits_is_refused(self):
        doc = json.loads(_fixture("inspire_search_one_hit.json"))
        doc["hits"]["hits"].append(dict(doc["hits"]["hits"][0], id="1000002"))  # total stays 1, two hits
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/literature?q=": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", self.out], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "ambiguous")
        self.assertIn("total=1", log["providers"]["inspire"]["notes"][0])

    def test_crossref_deposit_timestamp_never_stands_in_for_the_year(self):
        doc = json.loads(_fixture("crossref_work.json"))
        for key in ("issued", "published-online", "published-print", "published"):
            doc["message"].pop(key, None)
        doc["message"]["created"] = {"date-parts": [[2024, 1, 1]]}
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["year"])

    def test_malformed_provider_structures_degrade_locally(self):
        crossref = json.loads(_fixture("crossref_work.json"))
        crossref["message"]["title"] = "A String Title"          # not the documented array
        crossref["message"]["issued"] = "2001"                    # malformed date object
        crossref["message"]["container-title"] = {"bad": 1}      # malformed
        openalex = json.loads(_fixture("openalex_work.json"))
        openalex["primary_location"] = "not-an-object"           # raises inside the parser
        fetcher = FakeFetcher(overrides={
            "api.crossref.org/works/": (200, {}, json.dumps(crossref).encode()),
            "api.openalex.org/works/": (200, {}, json.dumps(openalex).encode()),
        })
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex,inspire", "--no-derived"], fetcher)
        self.assertIn(rc, (MOD.EXIT_CONFLICTED, MOD.EXIT_CONSISTENT, MOD.EXIT_INSUFFICIENT))  # a verdict, never a crash
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["openalex"]["status"], "parse_failed")
        self.assertTrue(any("could not be interpreted" in n for n in log["providers"]["openalex"]["notes"]))
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        crossref_block = next(b for b in blocks["providers"] if b["provider"] == "crossref")
        self.assertEqual(crossref_block["title"], "A String Title")
        self.assertEqual(crossref_block["year"], 2001)  # malformed `issued` skipped; `published-online` still usable
        self.assertIsNone(crossref_block["venue"])

    def test_openlibrary_multi_year_publish_date_yields_null_year(self):
        edition = json.loads(_fixture("openlibrary_edition.json"))
        edition["publish_date"] = "1995 (reprinted 2001)"
        fetcher = FakeFetcher(overrides={f"openlibrary.org/isbn/{ISBN}.json": (200, {}, json.dumps(edition).encode())})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["year"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("several years" in n for n in log["providers"]["openlibrary"]["notes"]))
        self.assertEqual(log["providers"]["openlibrary"]["details"]["publish_date"], "1995 (reprinted 2001)")

    def test_supplied_doi_is_checked_against_every_retained_doi_of_a_multi_doi_record(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["dois"] = [{"value": "10.1000/first"}, {"value": "10.1000/second"}]  # neither is the supplied DOI
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex,inspire", "--no-derived"], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "identifier_contradicted")
        check = next(c for c in log["supplied_identifier_checks"] if c["provider"] == "inspire" and c["kind"] == "doi")
        self.assertEqual(check["status"], "contradicted")
        self.assertEqual(sorted(check["observed"]), ["10.1000/first", "10.1000/second"])

    def test_search_total_of_unsupported_shape_is_refused(self):
        for total in ("1", True, {"value": 1}, 1.0):
            doc = json.loads(_fixture("inspire_search_one_hit.json"))
            doc["hits"]["total"] = total
            fetcher = FakeFetcher(overrides={"inspirehep.net/api/literature?q=": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, repr(total).replace("'", "").replace(" ", "")[:12])
            _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", out, "--providers", "inspire"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            self.assertEqual(log["providers"]["inspire"]["status"], "ambiguous", repr(total))
        for total in (None, 1):
            doc = json.loads(_fixture("inspire_search_one_hit.json"))
            if total is None:
                del doc["hits"]["total"]  # a genuine response always carries total; a missing one is refused too
            fetcher = FakeFetcher(overrides={"inspirehep.net/api/literature?q=": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, "missing" if total is None else "one")
            _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", out, "--providers", "inspire"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            self.assertEqual(log["providers"]["inspire"]["status"], "ambiguous" if total is None else "ok")

    def test_offline_rerun_targets_the_cross_index_report_and_preserves_the_forced_verdict(self):
        import shlex, subprocess, sys
        rc = _run(["--id", f"doi:{DOI}", "--id", "inspire:2000002", "--out-dir", self.out, "--no-derived"], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        parts = shlex.split(log["comparator"]["rerun_command"])
        self.assertIn("report.cross_index.json", parts[parts.index("--out-json") + 1])
        self.assertIn("report.cross_index.md", parts[parts.index("--out-md") + 1])
        before = Path(self.out, "report.json").read_bytes()
        completed = subprocess.run([sys.executable] + parts[1:], check=False, capture_output=True)
        self.assertEqual(completed.returncode, MOD.EXIT_CONSISTENT, completed.stderr)  # cross-index: crossref and openalex agree
        self.assertEqual(Path(self.out, "report.json").read_bytes(), before)  # the re-run rebuilt only report.cross_index.*
        self.assertEqual(_read_json(os.path.join(self.out, "report.json"))["verdict"], "conflicted")
        cross = _read_json(os.path.join(self.out, "report.cross_index.json"))
        self.assertEqual(cross["verdict"], "consistent")  # crossref and openalex agree; the forced verdict lives in report.json
        self.assertNotIn("supplied_identifier_checks", cross)
        md = Path(self.out, "report.md").read_text()
        self.assertIn("Identifier checks (withdrawn records included)", md)
        self.assertIn("| inspire | 2000002 | supplied | inspire | contradicted | withdrawn |", md)

    def test_openlibrary_fetched_author_name_with_marker_or_ellipsis_nulls_authors(self):
        fetcher = FakeFetcher(overrides={"openlibrary.org/authors/": (200, {}, b'{"key": "/authors/OL1000001A", "name": "Alice Example et al."}')})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", os.path.join(self.out, "a")], fetcher)
        blocks = _read_json(os.path.join(self.out, "a", "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["authors"])
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["author"][-1]["family"] = "Fixture \u2026"
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--out-dir", os.path.join(self.out, "b"), "--providers", "crossref,openalex"], fetcher)
        blocks = _read_json(os.path.join(self.out, "b", "blocks.json"))
        crossref = next(b for b in blocks["providers"] if b["provider"] == "crossref")
        self.assertIsNone(crossref["authors"])

    def test_isbn10_and_isbn13_of_one_edition_compare_equal(self):
        self.assertEqual(MOD._normalize_isbn("0-306-40615-2"), "9780306406157")
        self.assertEqual(MOD._normalize_isbn("9780306406157"), "9780306406157")
        edition = json.loads(_fixture("openlibrary_edition.json"))
        edition["isbn_10"] = ["0306406152"]
        edition["isbn_13"] = []
        fetcher = FakeFetcher(overrides={f"openlibrary.org/isbn/9780306406157.json": (200, {}, json.dumps(edition).encode()),
                                         "openlibrary.org/authors/": (200, {}, _fixture("openlibrary_author.json"))})
        _run(["--id", "isbn:9780306406157", "--out-dir", self.out], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "isbn")
        self.assertEqual(check["status"], "matched")

    def test_identifier_check_survives_malformed_identity_details(self):
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["ISBN"] = "9780306406157"  # a string where a list is documented
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", f"doi:{DOI}", "--id", "isbn:9780306406157", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        self.assertNotEqual(rc, MOD.EXIT_UNEXPECTED_FAILURE)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "isbn" and c["provider"] == "crossref")
        self.assertEqual(check["status"], "matched")

    def test_raw_write_failure_is_an_execution_failure_not_a_provider_verdict(self):
        original = MOD._save_raw
        try:
            def failing(*args, **kwargs):
                raise OSError("disk full")
            MOD._save_raw = failing
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], FakeFetcher())
        finally:
            MOD._save_raw = original
        self.assertEqual(rc, MOD.EXIT_WRITE_FAILURE)

    def test_journal_reference_is_checked_against_crossref_and_openalex_volume_and_page(self):
        _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", os.path.join(self.out, "ok")], FakeFetcher())
        log = _read_json(os.path.join(self.out, "ok", "fetch_log.json"))
        statuses = {c["provider"]: c["status"] for c in log["supplied_identifier_checks"] if c["kind"] == "jref"}
        self.assertEqual(statuses["crossref"], "partial")   # volume and page agree; journal name not compared
        self.assertEqual(statuses["openalex"], "partial")
        self.assertEqual(statuses["inspire"], "matched")    # the full three-part reference
        self.assertEqual(log["unverified_supplied_identifiers"], [])
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["volume"] = "99"
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", os.path.join(self.out, "bad")], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "bad", "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "identifier_contradicted")

    def test_erratum_doi_does_not_satisfy_the_publication_identity(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["dois"] = [{"value": DOI}, {"value": "10.1000/erratum.1", "material": "erratum"}]
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", "doi:10.1000/erratum.1", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "identifier_contradicted")
        check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "doi" and c["source"] == "supplied")
        self.assertEqual(check["status"], "contradicted")
        self.assertEqual(check["observed"]["associated"][0]["material"], "erratum")

    def test_derived_lookup_identifier_is_checked_against_its_own_record(self):
        other = _fixture("arxiv_query.xml").decode().replace(f"{ARXIV}v2", "example-ph/0009999v1").encode()
        fetcher = FakeFetcher(overrides={"export.arxiv.org/api/query": (200, {}, other)})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out], fetcher)  # arXiv is reached through the derived identifier
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["arxiv"]["lookup"]["derived_from"], ["inspire"])
        self.assertEqual(log["providers"]["arxiv"]["status"], "identifier_contradicted")
        check = next(c for c in log["supplied_identifier_checks"] if c["provider"] == "arxiv" and c["source"] == "lookup")
        self.assertEqual((check["kind"], check["value"], check["status"]), ("arxiv", ARXIV, "contradicted"))

    def test_identity_check_exception_withdraws_the_record_and_blocks_a_pass(self):
        original = MOD._check_one_identifier
        try:
            def exploding(kind, value, name, block, details):
                if name == "inspire":
                    raise KeyError("synthetic identity-detail failure")
                return original(kind, value, name, block, details)
            MOD._check_one_identifier = exploding
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex,inspire", "--no-derived"], FakeFetcher())
        finally:
            MOD._check_one_identifier = original
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)  # crossref and openalex agree, yet no pass without a completed check
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "identifier_check_failed")
        self.assertEqual(log["admitted_providers"], ["crossref", "openalex"])
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertEqual(report["verdict"], "insufficient_sources")
        cross = _read_json(os.path.join(self.out, "report.cross_index.json"))
        self.assertEqual(cross["verdict"], "consistent")  # the override is what blocked the pass
        self.assertTrue(any("no pass without a completed check" in r for r in report["verdict_reasons"]))

    def test_record_not_showing_its_own_lookup_identifier_is_withdrawn(self):
        crossref = json.loads(_fixture("crossref_work.json")); del crossref["message"]["DOI"]
        openalex = json.loads(_fixture("openalex_work.json")); openalex["doi"] = None; openalex["ids"].pop("doi", None)
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(crossref).encode()),
                                         "api.openalex.org/works/": (200, {}, json.dumps(openalex).encode())})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "identifier_unverified")
        self.assertEqual(log["providers"]["openalex"]["status"], "identifier_unverified")
        self.assertEqual(log["admitted_providers"], [])
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertTrue(any("does not show the doi" in r for r in report["verdict_reasons"]))

    def test_supplied_identifier_matched_by_no_record_blocks_a_pass(self):
        rc = _run(["--id", f"doi:{DOI}", "--id", f"arxiv:{ARXIV}", "--out-dir", self.out, "--providers", "crossref,openalex"], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)  # the two records agree but neither can show the supplied arXiv id
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertEqual(report["unverified_supplied_identifiers"], [{"kind": "arxiv", "value": ARXIV}])
        self.assertTrue(any("not positively matched by any admitted record" in r for r in report["verdict_reasons"]))
        self.assertIn("not positively matched", Path(self.out, "report.md").read_text())

    def test_journal_reference_with_only_volume_page_providers_cannot_pass(self):
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", self.out, "--providers", "crossref,openalex,inspire"], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)  # title discrepancy, as always with this fixture set
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["unverified_supplied_identifiers"], [])  # inspire matched the full reference
        doc = json.loads(_fixture("inspire_search_one_hit.json"))
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/literature?q=": (200, {}, json.dumps(doc).encode())})
        # Without the domain index the two remaining providers only reach "partial": no pass.
        rc = _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--id", f"doi:{DOI}", "--out-dir", os.path.join(self.out, "two"),
                   "--providers", "crossref,openalex"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
        log = _read_json(os.path.join(self.out, "two", "fetch_log.json"))
        self.assertEqual(log["unverified_supplied_identifiers"], [{"kind": "jref", "value": "Ex.Rev.Lett.,12,012345"}])

    def test_journal_spelled_differently_from_the_index_is_partial_not_contradicted(self):
        rc = _run(["--id", "jref:Example Review Letters,12,012345", "--id", f"doi:{DOI}", "--out-dir", self.out,
                   "--providers", "crossref,openalex,inspire", "--no-derived"], FakeFetcher())
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        inspire_jref = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref" and c["provider"] == "inspire")
        self.assertEqual(inspire_jref["status"], "partial")
        self.assertIn("inspire", log["admitted_providers"])  # the record stands; it just cannot verify this spelling
        report = _read_json(os.path.join(self.out, "report.json"))
        self.assertFalse(any("contradicted" in r for r in report["verdict_reasons"]))
        self.assertEqual(report["unverified_supplied_identifiers"], [{"kind": "jref", "value": "Example Review Letters,12,012345"}])
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)  # still the title discrepancy of this fixture set, not the journal spelling

    def test_record_carrying_only_an_erratum_doi_contradicts_that_supplied_doi(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["dois"] = [{"value": "10.1000/erratum.1", "material": "erratum"}]
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        rc = _run(["--id", "doi:10.1000/erratum.1", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        self.assertEqual(rc, MOD.EXIT_CONFLICTED)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["inspire"]["status"], "identifier_contradicted")

    def test_openlibrary_author_response_for_a_different_key_is_not_admitted(self):
        fetcher = FakeFetcher(overrides={"openlibrary.org/authors/": (200, {}, b'{"key": "/authors/OL9999999A", "name": "Somebody Else"}')})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["openlibrary"]["details"]["author_fetches"][0]["status"], "key_mismatch")

    def test_arxiv_identifier_comparison_folds_case(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["arxiv_eprints"][0]["value"] = ARXIV.upper()  # the record spells the archive in capitals
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/arxiv/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"arxiv:{ARXIV}", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual({c["status"] for c in log["supplied_identifier_checks"] if c["kind"] == "arxiv"}, {"matched"})
        self.assertEqual(log["admitted_providers"], ["inspire"])

    def test_openlibrary_publishers_string_is_not_split_into_characters(self):
        edition = json.loads(_fixture("openlibrary_edition.json")); edition["publishers"] = "Example University Press"
        fetcher = FakeFetcher(overrides={f"openlibrary.org/isbn/{ISBN}.json": (200, {}, json.dumps(edition).encode())})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertEqual(blocks["providers"][0]["venue"], "Example University Press")

    def test_incomplete_crossref_or_openalex_paging_is_evaluated_field_wise(self):
        cases = (
            ("crossref", {"volume": "99", "page": None, "article-number": None}, "contradicted"),   # volume disagrees, no page
            ("crossref", {"volume": None, "page": "777", "article-number": None}, "contradicted"),  # page disagrees, no volume
            ("crossref", {"volume": "12", "page": None, "article-number": None}, "not_checkable"),  # volume agrees, no page
            ("openalex", {"volume": "99", "first_page": None}, "contradicted"),
            ("openalex", {"volume": None, "first_page": "012345"}, "not_checkable"),
            ("openalex", {"volume": None, "first_page": "777"}, "contradicted"),                   # page disagrees, no volume
            ("crossref", {"volume": "12", "page": "A-123-A-130", "article-number": "777"}, "contradicted"),  # explicit article id disagrees; page ambiguity is local
            ("crossref", {"volume": "12", "page": "A-123-A-130", "article-number": "012345"}, "partial"),    # explicit article id agrees
        )
        for provider, fields, expected in cases:
            if provider == "crossref":
                doc = json.loads(_fixture("crossref_work.json"))
                for k, val in fields.items():
                    doc["message"][k] = val
                override = {"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())}
            else:
                doc = json.loads(_fixture("openalex_work.json"))
                doc["biblio"] = {"volume": fields["volume"], "issue": None, "first_page": fields["first_page"], "last_page": None}
                override = {"api.openalex.org/works/": (200, {}, json.dumps(doc).encode())}
            out = os.path.join(self.out, f"{provider}_{expected}_{abs(hash(json.dumps(fields, sort_keys=True))) % 1000}")
            _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--id", f"doi:{DOI}", "--out-dir", out, "--providers", provider],
                 FakeFetcher(overrides=override))
            log = _read_json(os.path.join(out, "fetch_log.json"))
            status = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"]
            self.assertEqual(status, expected, (provider, fields))
            self.assertEqual(log["providers"][provider]["status"], "identifier_contradicted" if expected == "contradicted" else "ok", (provider, fields))

    def test_supplied_hyphenated_range_never_contradicts_on_the_page(self):
        for provider, record_page in (("crossref", "A-123"), ("crossref", "777"), ("inspire", "A-123")):
            if provider == "crossref":
                doc = json.loads(_fixture("crossref_work.json")); doc["message"]["article-number"] = None; doc["message"]["page"] = record_page
                override = {"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())}
            else:
                doc = json.loads(_fixture("inspire_record.json")); doc["metadata"]["publication_info"][0]["artid"] = record_page
                override = {"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())}
            out = os.path.join(self.out, f"{provider}_{record_page}".replace("-", "_"))
            _run(["--id", "jref:Ex.Rev.Lett.,12,A-123-A-130", "--id", f"doi:{DOI}", "--out-dir", out, "--providers", provider, "--no-derived"],
                 FakeFetcher(overrides=override))
            log = _read_json(os.path.join(out, "fetch_log.json"))
            check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")
            self.assertEqual(check["status"], "not_checkable", (provider, record_page))
            self.assertEqual(log["providers"][provider]["status"], "ok", (provider, record_page))
        # the volume can still contradict even when the supplied page is ambiguous
        doc = json.loads(_fixture("crossref_work.json")); doc["message"]["volume"] = "99"
        _run(["--id", "jref:Ex.Rev.Lett.,12,A-123-A-130", "--id", f"doi:{DOI}", "--out-dir", os.path.join(self.out, "vol"), "--providers", "crossref"],
             FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())}))
        log = _read_json(os.path.join(self.out, "vol", "fetch_log.json"))
        self.assertEqual(next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"], "contradicted")

    def test_inspire_hyphenated_article_id_on_the_record_side_is_ambiguous(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["publication_info"][0]["artid"] = "A-123-A-130"  # record side: hyphenated, non-numeric
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", "jref:Ex.Rev.Lett.,12,123", "--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"], "not_checkable")
        self.assertEqual(log["providers"]["inspire"]["status"], "ok")
        self.assertEqual(MOD.resolve_destination("/."), os.path.realpath("/"))  # pathological spelling names the root

    def test_hyphenated_article_identifier_is_compared_whole(self):
        doc = json.loads(_fixture("crossref_work.json"))
        doc["message"]["article-number"] = "A-123"
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", "jref:Ex.Rev.Lett.,12,A-123", "--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")
        self.assertEqual(check["status"], "partial")  # volume and the whole article id agree
        self.assertEqual(check["observed"]["article_number"], "A-123")  # the deciding field is kept in the evidence
        self.assertEqual(log["providers"]["crossref"]["status"], "ok")
        doc["message"]["article-number"] = None
        for page_value, supplied, expected in (
            ("123-130", "123", "partial"),          # a purely numeric range yields its first page
            ("123-130", "123-130", "partial"),      # or matches as a whole
            ("A-123-A-130", "A-123", "not_checkable"),  # a hyphenated string is ambiguous: never reduced to "A"
            ("A-123-A-130", "A-123-A-130", "partial"),
            ("123-130", "777", "contradicted"),
            ("123\u2014130", "123", "partial"),  # em dash range on the record side
        ):
            doc["message"]["page"] = page_value
            fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, f"{page_value}_{supplied}".replace("-", "_"))
            _run(["--id", f"jref:Ex.Rev.Lett.,12,{supplied}", "--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            status = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"]
            self.assertEqual(status, expected, (page_value, supplied))

    def test_duplicate_provider_names_are_rejected_before_any_fetch(self):
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], FakeFetcher())
        before = _snapshot(self.out)
        fetcher = FakeFetcher()
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--overwrite", "--providers", "crossref,crossref,openalex"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        self.assertEqual(fetcher.urls, [])
        self.assertEqual(_snapshot(self.out), before)  # every file, including raw/, byte-for-byte

    def test_openlibrary_author_keys_must_be_well_formed_record_paths(self):
        for bad_key in ("@evil.example/authors/A", "/authors/OL1000001A?x=1", "/works/OL1000001W", 12345, "/authors/OL1000001A/../x"):
            edition = json.loads(_fixture("openlibrary_edition.json"))
            edition["authors"] = [{"key": bad_key}]
            fetcher = FakeFetcher(overrides={f"openlibrary.org/isbn/{ISBN}.json": (200, {}, json.dumps(edition).encode())})
            out = os.path.join(self.out, str(bad_key).replace("/", "_").replace("@", "_").replace("?", "_")[:30])
            _run(["--id", f"isbn:{ISBN}", "--out-dir", out], fetcher)
            self.assertFalse(any("authors/" in u and "isbn" not in u for u in fetcher.urls), bad_key)  # no author request was made
            blocks = _read_json(os.path.join(out, "blocks.json"))
            self.assertIsNone(blocks["providers"][0]["authors"], bad_key)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            self.assertTrue(any("well-formed record key" in n for n in log["providers"]["openlibrary"]["notes"]), bad_key)

    def test_retryable_status_is_retried_once_and_both_attempts_are_logged(self):
        class FlakyFetcher(FakeFetcher):
            def __init__(self):
                super().__init__(); self.crossref_calls = 0
            def __call__(self, url, headers, timeout):
                if "api.crossref.org" in url:
                    self.crossref_calls += 1
                    if self.crossref_calls == 1:
                        return 429, {"retry-after": "1"}, b'{"status": "rate limited"}', url
                return super().__call__(url, headers, timeout)

        fetcher = FlakyFetcher()
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        self.assertEqual(fetcher.crossref_calls, 2)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "ok")
        attempts = [r for r in log["requests"] if "api.crossref.org" in r["url"]]
        self.assertEqual([a["status"] for a in attempts], [429, 200])
        self.assertNotEqual(attempts[0]["sha256"], attempts[1]["sha256"])
        self.assertNotEqual(attempts[0]["bytes"], attempts[1]["bytes"])
        self.assertEqual(attempts[0]["bytes"], len(b'{"status": "rate limited"}'))
        raw = Path(self.out) / log["providers"]["crossref"]["raw_path"]
        self.assertEqual(raw.read_bytes(), _fixture("crossref_work.json"))  # the final response is the saved one

    def test_persistent_retryable_status_is_retried_once_then_fetch_failed(self):
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (429, {"retry-after": "0"}, b'{"status": "rate limited"}')})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "fetch_failed")
        attempts = [r for r in log["requests"] if "api.crossref.org" in r["url"]]
        self.assertEqual([a["status"] for a in attempts], [429, 429])  # exactly one retry, then give up
        self.assertTrue(any("HTTP 429" in n for n in log["providers"]["crossref"]["notes"]))
        self.assertEqual(log["admitted_providers"], [])

    def test_non_retryable_http_error_is_a_single_fetch_failure(self):
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (403, {}, b"{}")})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "fetch_failed")
        self.assertEqual([r["status"] for r in log["requests"] if "api.crossref.org" in r["url"]], [403])
        self.assertTrue(any("HTTP 403" in n for n in log["providers"]["crossref"]["notes"]))

    def test_arxiv_response_with_several_entries_is_ambiguous(self):
        xml = _fixture("arxiv_query.xml").decode()
        entry = xml[xml.index("<entry>"):xml.index("</entry>") + len("</entry>")]
        doubled = xml.replace(entry, entry + entry.replace(f"{ARXIV}v2", "example-ph/0009999v1")).encode()
        fetcher = FakeFetcher(overrides={"export.arxiv.org/api/query": (200, {}, doubled)})
        _run(["--id", f"arxiv:{ARXIV}", "--out-dir", self.out, "--providers", "arxiv"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["arxiv"]["status"], "ambiguous")
        # one entry but a feed that reports two results, or no usable total, is refused as well
        for total, label in (("2", "two"), ("", "empty"), ("many", "text")):
            feed = xml.replace("<opensearch:totalResults>1</opensearch:totalResults>", f"<opensearch:totalResults>{total}</opensearch:totalResults>").encode()
            fetcher = FakeFetcher(overrides={"export.arxiv.org/api/query": (200, {}, feed)})
            out = os.path.join(self.out, label)
            _run(["--id", f"arxiv:{ARXIV}", "--out-dir", out, "--providers", "arxiv"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            self.assertEqual(log["providers"]["arxiv"]["status"], "ambiguous", total)
            self.assertIn("totalResults", log["providers"]["arxiv"]["notes"][0])

    def test_openlibrary_author_fetch_cap_nulls_authors(self):
        edition = json.loads(_fixture("openlibrary_edition.json"))
        edition["authors"] = [{"key": f"/authors/OL{1000000 + i}A"} for i in range(MOD.MAX_OPENLIBRARY_AUTHOR_FETCHES + 1)]
        fetcher = FakeFetcher(overrides={f"openlibrary.org/isbn/{ISBN}.json": (200, {}, json.dumps(edition).encode())})
        _run(["--id", f"isbn:{ISBN}", "--out-dir", self.out], fetcher)
        self.assertFalse(any("openlibrary.org/authors/" in u for u in fetcher.urls))
        blocks = _read_json(os.path.join(self.out, "blocks.json"))
        self.assertIsNone(blocks["providers"][0]["authors"])
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertTrue(any("exceed the fetch cap" in n for n in log["providers"]["openlibrary"]["notes"]))

    def test_other_truncation_marker_forms_null_the_author_list(self):
        for marker in ("Smith and others", "Smith +3 more"):
            doc = json.loads(_fixture("crossref_work.json"))
            doc["message"]["author"].append({"name": marker, "sequence": "additional"})
            fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, marker.replace(" ", "_").replace("+", "p"))
            _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref"], fetcher)
            blocks = _read_json(os.path.join(out, "blocks.json"))
            self.assertIsNone(blocks["providers"][0]["authors"], marker)

    def test_pacing_arguments_must_be_finite(self):
        for args in (["--delay", "nan"], ["--delay", "-1"], ["--delay", "inf"], ["--timeout", "0"], ["--timeout", "nan"]):
            fetcher = FakeFetcher()
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out] + args, fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, args)
            self.assertEqual(fetcher.urls, [])

    def test_invalid_single_citation_input_never_cleans_an_existing_generation(self):
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], FakeFetcher())
        before = _snapshot(self.out)
        rc = _run(["--id", "not an identifier", "--out-dir", self.out, "--overwrite"], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        self.assertEqual(_snapshot(self.out), before)

    def test_inspire_record_without_paging_fields_cannot_check_a_journal_reference(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["publication_info"] = [{"journal_title": "Ex.Rev.Lett.", "year": 2001}]  # journal named, no volume or page
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", f"doi:{DOI}", "--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        check = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")
        self.assertEqual(check["status"], "not_checkable")
        self.assertEqual(log["providers"]["inspire"]["status"], "ok")  # not withdrawn: nothing contradicted
        # a single present field that agrees is absent evidence for the rest, not a match and not a mismatch
        for pubinfo, expected in (
            ([{"journal_title": "Ex.Rev.Lett.", "journal_volume": "12", "year": 2001}], "not_checkable"),   # volume only, agrees
            ([{"journal_title": "Ex.Rev.Lett.", "artid": "012345", "year": 2001}], "not_checkable"),         # page only, agrees
            ([{"journal_title": "Ex.Rev.Lett.", "journal_volume": "99", "year": 2001}], "contradicted"),    # volume only, disagrees
        ):
            doc["metadata"]["publication_info"] = pubinfo
            fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, expected + str(len(pubinfo[0])))
            _run(["--id", f"doi:{DOI}", "--id", "jref:Ex.Rev.Lett.,12,012345", "--out-dir", out, "--providers", "inspire", "--no-derived"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            self.assertEqual(next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"], expected, pubinfo)

    def test_symlinked_output_directory_is_refused_before_any_cleanup(self):
        target = os.path.join(self.tmp.name, "real_run")
        _run(["--id", f"doi:{DOI}", "--out-dir", target, "--providers", "crossref"], FakeFetcher())
        before = _snapshot(target)
        link = os.path.join(self.tmp.name, "link_dir"); os.symlink(target, link)
        manifest = os.path.join(self.tmp.name, "refs.jsonl")
        Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
        for spelling in (link, link + "/", link + "/."):  # trailing separator and "/." must not bypass the guard
            fetcher = FakeFetcher()
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", spelling, "--overwrite", "--providers", "crossref,openalex"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, spelling)
            self.assertEqual(fetcher.urls, [], spelling)
            self.assertEqual(_snapshot(target), before, spelling)  # nothing behind the link was cleaned or rewritten
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", spelling, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, spelling)
            self.assertEqual(fetcher.urls, [], spelling)
            self.assertEqual(_snapshot(target), before, spelling)

    def test_symlink_followed_by_dotdot_resolves_in_filesystem_order_and_is_refused(self):
        base = os.path.join(self.tmp.name, "base"); remote = os.path.join(self.tmp.name, "remote"); victim = os.path.join(self.tmp.name, "victim")
        os.makedirs(os.path.join(remote, "child")); os.makedirs(os.path.join(base, "run")); os.makedirs(base, exist_ok=True)
        _run(["--id", f"doi:{DOI}", "--out-dir", victim, "--providers", "crossref"], FakeFetcher())
        os.symlink(os.path.join(remote, "child"), os.path.join(base, "link"))  # /base/link -> /remote/child
        os.symlink(victim, os.path.join(remote, "run"))                         # /remote/run -> /victim
        victim_before, base_run_before = _snapshot(victim), _snapshot(os.path.join(base, "run"))
        spelling = os.path.join(base, "link", "..", "run")  # the filesystem reads this as /remote/run, a symlink to the victim
        manifest = os.path.join(self.tmp.name, "refs.jsonl")
        Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
        for args in (["--id", f"doi:{DOI}", "--providers", "crossref,openalex"], ["--manifest", manifest]):
            fetcher = FakeFetcher()
            rc = _run(args + ["--out-dir", spelling, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, args)
            self.assertEqual(fetcher.urls, [], args)
            self.assertEqual(_snapshot(victim), victim_before, args)
            self.assertEqual(_snapshot(os.path.join(base, "run")), base_run_before, args)

    def test_logged_raw_paths_resolve_next_to_the_run_and_match_their_hashes(self):
        import hashlib
        _run(["--id", f"doi:{DOI}", "--out-dir", os.path.join(self.out, "run", ".") + "/", "--providers", "crossref,openalex"], FakeFetcher())
        run_dir = os.path.join(self.out, "run")
        log = _read_json(os.path.join(run_dir, "fetch_log.json"))
        for outcome in log["providers"].values():
            if outcome["raw_path"]:
                raw = Path(run_dir, outcome["raw_path"])
                self.assertTrue(raw.exists(), outcome["raw_path"])
                self.assertEqual("sha256:" + hashlib.sha256(raw.read_bytes()).hexdigest(), outcome["raw_sha256"])

    def test_provider_text_that_is_not_valid_unicode_is_dropped_with_a_note(self):
        body = ('{"status":"ok","message":{"DOI":"' + DOI + '","title":["Direct Proof of the Example Relation in a Model Theory"],'
                '"author":[{"given":"Alice","family":"Example"}],"issued":{"date-parts":[[2001,5,10]]},'
                '"container-title":["Example Review Letters"],"type":"journal-article","publisher":"\\ud800"}}').encode()
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, body)})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        self.assertIn(rc, (MOD.EXIT_CONSISTENT, MOD.EXIT_CONFLICTED, MOD.EXIT_INSUFFICIENT))  # a verdict, never 4 or 5
        log = _read_json(os.path.join(self.out, "fetch_log.json"))  # the log was written and is valid JSON
        self.assertIsNone(log["providers"]["crossref"]["details"]["publisher"])
        self.assertTrue(any("not valid Unicode" in n for n in log["providers"]["crossref"]["notes"]))
        self.assertEqual(_run(["--id", f"doi:{DOI}", "--citation-key", "k\ud800", "--out-dir", os.path.join(self.out, "k")], FakeFetcher()), MOD.EXIT_INVALID_INPUT)

    def test_invalid_single_citation_label_or_identifier_never_cleans_an_existing_generation(self):
        manifest = os.path.join(self.tmp.name, "refs.jsonl")
        Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
        _run(["--manifest", manifest, "--out-dir", self.out, "--quiet", "--providers", "crossref"], FakeFetcher())  # an existing manifest generation
        before = _snapshot(self.out)
        for args in (["--id", f"doi:{DOI}", "--citation-key", "k\ud800"], ["--id", "doi:10.1000/x\ud800"]):
            fetcher = FakeFetcher()
            rc = _run(args + ["--out-dir", self.out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, args)
            self.assertEqual(fetcher.urls, [], args)
            self.assertEqual(_snapshot(self.out), before, args)

    def test_provider_surrogates_in_keys_and_quoted_notes_still_serialize(self):
        crossref = json.dumps({"status": "ok", "message": {
            "DOI": DOI, "title": ["Direct Proof of the Example Relation in a Model Theory"],
            "author": [{"given": "Alice", "family": "Example"}], "issued": {"date-parts": [[2001, 5, 10]]},
            "container-title": ["Example Review Letters"], "type": "journal-article",
            "publisher": {"\ud800": "x", "name": "P"},   # a key that is not valid Unicode
        }}, ensure_ascii=True).encode()
        inspire = json.loads(_fixture("inspire_record.json"))
        inspire["metadata"]["dois"] = [{"value": DOI}, {"value": "10.1000/other\ud800"}]  # two publication DOIs, one not valid Unicode
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, crossref),
                                         "inspirehep.net/api/doi/": (200, {}, json.dumps(inspire, ensure_ascii=True).encode())})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,inspire", "--no-derived"], fetcher)
        self.assertIn(rc, (MOD.EXIT_CONSISTENT, MOD.EXIT_CONFLICTED, MOD.EXIT_INSUFFICIENT))
        log = _read_json(os.path.join(self.out, "fetch_log.json"))  # written and readable
        self.assertEqual(log["providers"]["crossref"]["details"]["publisher"], {"name": "P"})
        self.assertTrue(any("key is not valid Unicode" in n for n in log["providers"]["crossref"]["notes"]))
        for note in log["providers"]["inspire"]["notes"]:
            note.encode("utf-8")  # every note is writable

    def test_non_finite_json_constants_in_a_provider_response_are_a_parse_failure(self):
        body = (_fixture("crossref_work.json").decode().replace('"publisher": "Example Physical Society"', '"publisher": NaN')).encode()
        self.assertIn(b"NaN", body)
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, body)})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex"], fetcher)
        log_text = Path(self.out, "fetch_log.json").read_text()
        json.loads(log_text, parse_constant=lambda t: (_ for _ in ()).throw(ValueError(t)))  # strictly standard JSON
        log = json.loads(log_text)
        self.assertEqual(log["providers"]["crossref"]["status"], "parse_failed")
        self.assertTrue(any("non-finite" in n for n in log["providers"]["crossref"]["notes"]))

    def test_numeric_overflow_in_a_provider_response_is_a_parse_failure(self):
        # An ordinary JSON number can overflow to infinity without any named constant
        # appearing; it must degrade the provider locally, never abort the run after
        # the reports are written and leave them without their fetch log.
        body = (_fixture("crossref_work.json").decode().replace('"publisher": "Example Physical Society"', '"publisher": 1e400')).encode()
        self.assertIn(b"1e400", body)
        fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, body)})
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref,openalex", "--no-derived"], fetcher)
        self.assertNotEqual(rc, MOD.EXIT_UNEXPECTED_FAILURE)
        strict = lambda t: (_ for _ in ()).throw(ValueError(t))
        for name in ("fetch_log.json", "report.json", "report.cross_index.json", "blocks.json"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)), name)
            json.loads(Path(self.out, name).read_text(), parse_constant=strict)  # strictly standard JSON
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(log["providers"]["crossref"]["status"], "parse_failed")
        self.assertTrue(any("non-finite" in n for n in log["providers"]["crossref"]["notes"]))
        self.assertEqual(log["providers"]["openalex"]["status"], "ok")

    def test_inspire_numeric_page_range_is_reduced_to_its_start_page(self):
        for field, record_value, supplied, expected in (
            ("page_start", "123-130", "123", "matched"),          # a purely numeric range yields its first page
            ("page_start", "123-130", "123-130", "matched"),      # or matches as a whole
            ("page_start", "123-130", "777", "contradicted"),
            ("page_start", "123\u2013130", "123", "matched"),     # en dash range on the record side
            ("artid", "123-130", "123", "matched"),
        ):
            doc = json.loads(_fixture("inspire_record.json"))
            entry = doc["metadata"]["publication_info"][0]
            entry.pop("artid", None)
            entry[field] = record_value
            fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, f"{field}_{record_value}_{supplied}".replace("-", "_"))
            _run(["--id", f"jref:Ex.Rev.Lett.,12,{supplied}", "--id", f"doi:{DOI}", "--out-dir", out, "--providers", "inspire", "--no-derived"], fetcher)
            log = _read_json(os.path.join(out, "fetch_log.json"))
            status = next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"]
            self.assertEqual(status, expected, (field, record_value, supplied))

    def test_inspire_volume_with_padding_still_matches(self):
        doc = json.loads(_fixture("inspire_record.json"))
        doc["metadata"]["publication_info"][0]["journal_volume"] = " 12 "  # padding is not a different volume
        fetcher = FakeFetcher(overrides={"inspirehep.net/api/doi/": (200, {}, json.dumps(doc).encode())})
        _run(["--id", "jref:Ex.Rev.Lett.,12,012345", "--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(next(c for c in log["supplied_identifier_checks"] if c["kind"] == "jref")["status"], "matched")

    def test_zero_padded_record_number_url_matches_the_index_rendering(self):
        # Every accepted spelling of a record number canonicalizes alike: the URL form
        # must not keep leading zeros the prefixed form drops.
        self.assertEqual(MOD.parse_identifier("https://inspirehep.net/literature/0001000001"), ("inspire", "1000001"))
        self.assertEqual(MOD.parse_identifier("inspire:0001000001"), ("inspire", "1000001"))
        fetcher = FakeFetcher()
        _run(["--id", "https://inspirehep.net/literature/0001000001", "--out-dir", self.out, "--providers", "inspire", "--no-derived"], fetcher)
        self.assertTrue(any("/api/literature/1000001" in url for url in fetcher.urls), fetcher.urls)  # the canonical number is fetched
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        self.assertEqual(next(c for c in log["supplied_identifier_checks"] if c["kind"] == "inspire")["status"], "matched")
        self.assertEqual(log["providers"]["inspire"]["status"], "ok")
        self.assertEqual([b["provider"] for b in _read_json(os.path.join(self.out, "blocks.json"))["providers"]], ["inspire"])  # the record is retained

    def test_raw_metadata_records_the_url_that_served_the_bytes(self):
        # The transport follows redirects silently; the saved bytes are anchored to the
        # URL that actually served them, next to the URL that was asked for.
        served = f"https://api.crossref.org/works/{DOI}?served=1"
        fetcher = FakeFetcher(redirects={"api.crossref.org/works/": served})
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], fetcher)
        log = _read_json(os.path.join(self.out, "fetch_log.json"))
        meta = _read_json(os.path.join(self.out, "raw", "crossref.meta.json"))
        self.assertEqual(meta["url"], fetcher.urls[0])
        self.assertEqual(meta["final_url"], served)
        self.assertEqual(log["providers"]["crossref"]["final_url"], served)
        self.assertEqual([r["final_url"] for r in log["requests"]], [served])

    def test_fields_the_comparator_rejects_are_nulled_and_the_provider_stays_admitted(self):
        # _finish_block's recovery path: a field the comparator's validator rejects is
        # nulled (with a note naming it) and the provider remains admitted on the
        # remaining fields -- pinning the message-anchored culprit detection.
        for culprit, mutate in (
            ("title", lambda msg: msg.__setitem__("title", ["$~{}$"])),  # normalizes to an empty string
            ("authors", lambda msg: msg["author"].__setitem__(0, {"family": "---", "given": "A.", "sequence": "first"})),  # no extractable family name
        ):
            doc = json.loads(_fixture("crossref_work.json")); mutate(doc["message"])
            fetcher = FakeFetcher(overrides={"api.crossref.org/works/": (200, {}, json.dumps(doc).encode())})
            out = os.path.join(self.out, culprit)
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref,openalex"], fetcher)
            self.assertIn(rc, (MOD.EXIT_CONSISTENT, MOD.EXIT_CONFLICTED, MOD.EXIT_INSUFFICIENT), culprit)  # a verdict, never an internal failure
            outcome = _read_json(os.path.join(out, "fetch_log.json"))["providers"]["crossref"]
            self.assertEqual(outcome["status"], "ok", culprit)
            self.assertTrue(any(n.startswith(f"field {culprit!r} set to null: ") for n in outcome["notes"]), outcome["notes"])
            block = next(b for b in _read_json(os.path.join(out, "blocks.json"))["providers"] if b["provider"] == "crossref")  # still admitted
            self.assertIsNone(block[culprit], culprit)

    def test_output_destination_that_is_a_regular_file_is_refused_before_any_request(self):
        os.makedirs(self.out, exist_ok=True)
        target = os.path.join(self.out, "not-a-directory")
        Path(target).write_text("keep me", encoding="utf-8")
        fetcher = FakeFetcher()
        rc = _run(["--id", f"doi:{DOI}", "--out-dir", target, "--providers", "crossref"], fetcher)
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        self.assertEqual(fetcher.urls, [])
        self.assertEqual(Path(target).read_text(encoding="utf-8"), "keep me")

    def test_unexpected_internal_failure_is_exit_5_never_a_verdict(self):
        self.assertEqual(MOD.EXIT_UNEXPECTED_FAILURE, MOD.COMPARATOR.EXIT_UNEXPECTED_FAILURE)  # one meaning for code 5 across both scripts
        original = MOD.triangulate_citation
        try:
            def boom(*args, **kwargs):
                raise RuntimeError("synthetic crash")
            MOD.triangulate_citation = boom
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], FakeFetcher())
        finally:
            MOD.triangulate_citation = original
        self.assertEqual(rc, MOD.EXIT_UNEXPECTED_FAILURE)
        self.assertNotIn(rc, (MOD.EXIT_CONSISTENT, MOD.EXIT_CONFLICTED, MOD.EXIT_INSUFFICIENT, MOD.EXIT_INVALID_INPUT, MOD.EXIT_WRITE_FAILURE))
        self.assertIn("unexpected failure: RuntimeError: synthetic crash", stderr.getvalue())

    def test_missing_comparator_is_exit_5_never_a_verdict(self):
        # The third crash surface: the comparator cannot be loaded at import time.
        with tempfile.TemporaryDirectory() as tmp:
            copy = os.path.join(tmp, "fetch_citation_records.py")
            shutil.copy(SCRIPT_PATH, copy)  # no triangulate_citation.py beside it
            completed = subprocess.run([sys.executable, copy, "--id", f"doi:{DOI}", "--out-dir", os.path.join(tmp, "out")],
                                       capture_output=True, text=True)
            self.assertEqual(completed.returncode, 5)
            self.assertIn("cannot load comparator", completed.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "out")))

    def test_stdout_encoding_failure_after_the_reports_does_not_change_the_exit_code(self):
        ascii_stdout = io.TextIOWrapper(io.BytesIO(), encoding="ascii", errors="strict")
        stderr = io.StringIO()
        with contextlib.redirect_stdout(ascii_stdout), contextlib.redirect_stderr(stderr):
            rc = _run(["--id", f"doi:{DOI}", "--citation-key", "cl\u00e9", "--out-dir", self.out, "--providers", "crossref,openalex"], FakeFetcher())
        self.assertIn(rc, (MOD.EXIT_CONSISTENT, MOD.EXIT_CONFLICTED, MOD.EXIT_INSUFFICIENT))  # the verdict, not a write failure
        self.assertTrue(os.path.exists(os.path.join(self.out, "report.json")))
        self.assertIn("could not encode the summary", stderr.getvalue())

    def test_header_bound_configuration_is_validated_before_any_cleanup(self):
        _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--providers", "crossref"], FakeFetcher())
        before = _snapshot(self.out)
        for args in (["--mailto", "a\ud800@example.org"], ["--mailto", "a@example.org\r\nX-Injected: 1"], ["--user-agent", "ua\u00e9"]):
            fetcher = FakeFetcher()
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", self.out, "--overwrite", "--providers", "crossref,openalex"] + args, fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, args)
            self.assertEqual(fetcher.urls, [], args)
            self.assertEqual(_snapshot(self.out), before, args)

    def test_conflicting_identifiers_of_one_kind_are_rejected(self):
        rc = _run(["--id", f"doi:{DOI}", "--id", "doi:10.1000/other", "--out-dir", self.out], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        rc = _run(["--id", f"doi:{DOI}", "--id", f"doi:{DOI}", "--out-dir", self.out], FakeFetcher())  # the same value twice
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
        rc = _run(["--out-dir", self.out], FakeFetcher())
        self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)


class ManifestTests(unittest.TestCase):
    def test_manifest_writes_per_citation_directories_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            with open(manifest, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"citation_key": "paper/one", "identifiers": [f"doi:{DOI}"]}) + "\n\n")
                handle.write(json.dumps({"citation_key": "book two", "identifiers": [f"isbn:{ISBN}"]}) + "\n")
            out = os.path.join(tmp, "out")
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet"], FakeFetcher())
            self.assertEqual(rc, MOD.EXIT_CONFLICTED)  # conflicted outranks insufficient
            summary = _read_json(os.path.join(out, "summary.json"))
            rows = {row["citation_key"]: row for row in summary["citations"]}
            self.assertEqual(rows["paper/one"]["verdict"], "conflicted")
            self.assertEqual(rows["book two"]["verdict"], "insufficient_sources")
            self.assertTrue(os.path.exists(os.path.join(out, rows["paper/one"]["directory"], "report.md")))
            self.assertTrue(os.path.exists(os.path.join(out, rows["book two"]["report_md"])))
            self.assertIn("| book two | insufficient_sources |", Path(out, "summary.md").read_text())
            # each citation's log carries only its own requests
            second = _read_json(os.path.join(out, rows["book two"]["directory"], "fetch_log.json"))
            self.assertTrue(second["requests"] and all("openlibrary.org" in r["url"] for r in second["requests"]))

    def test_summary_table_escapes_pipes_in_citation_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "smith|2001\rx", "identifiers": [f"doi:{DOI}"]}) + "\n")
            out = os.path.join(tmp, "out")
            _run(["--manifest", manifest, "--out-dir", out, "--quiet", "--providers", "crossref,openalex"], FakeFetcher())
            self.assertIn("| smith\\|2001 x | consistent |", Path(out, "summary.md").read_text())  # crossref and openalex agree

    def test_manifest_keys_colliding_on_directory_name_are_rejected_before_any_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(
                json.dumps({"citation_key": "a/b", "identifiers": [f"doi:{DOI}"]}) + "\n"
                + json.dumps({"citation_key": "a_b", "identifiers": [f"doi:{DOI}"]}) + "\n"
            )
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", os.path.join(tmp, "out")], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])

    def test_reused_manifest_directory_is_refused_before_any_fetch_and_summaries_are_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            out = os.path.join(tmp, "out")
            _run(["--manifest", manifest, "--out-dir", out, "--quiet"], FakeFetcher())
            self.assertTrue(os.path.exists(os.path.join(out, "summary.md")))
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            Path(manifest).write_text(json.dumps({"citation_key": "two", "identifiers": [f"isbn:{ISBN}"]}) + "\n")
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet", "--overwrite"], FakeFetcher())
            self.assertEqual(rc, MOD.EXIT_INSUFFICIENT)
            summary = _read_json(os.path.join(out, "summary.json"))
            self.assertEqual([row["citation_key"] for row in summary["citations"]], ["two"])
            self.assertFalse(os.path.exists(os.path.join(out, "one")))  # the stale citation directory went with the old generation
            # a single-citation run must not share a directory that holds a manifest generation
            rc = _run(["--id", f"doi:{DOI}", "--out-dir", out], FakeFetcher())
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)

    def test_manifest_after_a_single_citation_run_in_the_same_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref,openalex"], FakeFetcher())
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet", "--overwrite", "--providers", "crossref,openalex"], FakeFetcher())
            self.assertEqual(rc, MOD.EXIT_CONSISTENT)
            self.assertFalse(os.path.exists(os.path.join(out, "report.json")))  # the root-level generation is gone
            self.assertTrue(os.path.exists(os.path.join(out, "one", "report.json")))

    def test_raw_only_stale_citation_directory_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            os.makedirs(os.path.join(out, "ghost", "raw"))
            Path(out, "ghost", "raw", "crossref.json").write_text("{}")
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--quiet"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])

    def test_reserved_output_names_are_not_valid_citation_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            for key in ("summary.json", "Summary.MD", "raw", "report.json"):
                Path(manifest).write_text(json.dumps({"citation_key": key, "identifiers": [f"doi:{DOI}"]}) + "\n")
                fetcher = FakeFetcher()
                rc = _run(["--manifest", manifest, "--out-dir", os.path.join(tmp, "out", key.lower())], fetcher)
                self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, key)
                self.assertEqual(fetcher.urls, [])

    def test_manifest_inside_the_output_tree_and_aliased_citation_directories_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out"); os.makedirs(out)
            inside = os.path.join(out, "summary.json")  # the manifest sits exactly where the summary would be written
            Path(inside).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            before = Path(inside).read_bytes()
            fetcher = FakeFetcher()
            rc = _run(["--manifest", inside, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(Path(inside).read_bytes(), before)
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "a", "identifiers": [f"doi:{DOI}"]}) + "\n"
                                      + json.dumps({"citation_key": "b", "identifiers": [f"isbn:{ISBN}"]}) + "\n")
            os.makedirs(os.path.join(out, "a")); os.symlink(os.path.join(out, "a"), os.path.join(out, "b"))  # b aliases a
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])

    def test_citation_destination_that_is_a_regular_file_is_refused_before_any_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "a", "identifiers": [f"doi:{DOI}"]}) + "\n")
            _run(["--manifest", manifest, "--out-dir", out, "--quiet"], FakeFetcher())  # a complete earlier generation
            Path(manifest).write_text(json.dumps({"citation_key": "a", "identifiers": [f"doi:{DOI}"]}) + "\n"
                                      + json.dumps({"citation_key": "b", "identifiers": [f"isbn:{ISBN}"]}) + "\n")
            Path(out, "b").write_text("keep me", encoding="utf-8")  # the second citation's destination is a regular file
            before = _snapshot(out)
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--overwrite", "--quiet"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(_snapshot(out), before)  # earlier artifacts and the file are untouched

    def test_manifest_stdout_encoding_failure_does_not_abort_the_batch_or_change_the_exit_code(self):
        for extra in ([], ["--quiet"]):
            with tempfile.TemporaryDirectory() as tmp:
                manifest = os.path.join(tmp, "refs.jsonl")
                Path(manifest).write_text(json.dumps({"citation_key": "cl\u00e9", "identifiers": [f"doi:{DOI}"]}) + "\n"
                                          + json.dumps({"citation_key": "book two", "identifiers": [f"isbn:{ISBN}"]}) + "\n", encoding="utf-8")
                out = os.path.join(tmp, "out")
                ascii_stdout = io.TextIOWrapper(io.BytesIO(), encoding="ascii", errors="strict")
                stderr = io.StringIO()
                with contextlib.redirect_stdout(ascii_stdout), contextlib.redirect_stderr(stderr):
                    rc = _run(["--manifest", manifest, "--out-dir", out] + extra, FakeFetcher())
                self.assertEqual(rc, MOD.EXIT_CONFLICTED, extra)  # the aggregate verdict, not a write failure
                summary = _read_json(os.path.join(out, "summary.json"))
                self.assertEqual(len(summary["citations"]), 2, extra)
                for row in summary["citations"]:
                    report_md = row["report_md"] if os.path.isabs(row["report_md"]) else os.path.join(out, row["report_md"])
                    self.assertTrue(os.path.exists(report_md), (extra, row))
                    self.assertTrue(os.path.exists(os.path.join(os.path.dirname(report_md), "fetch_log.json")), (extra, row))
                self.assertTrue(os.path.exists(os.path.join(out, "summary.md")), extra)
                self.assertIn("could not encode the summary", stderr.getvalue(), extra)

    def test_manifest_reached_through_a_symlink_and_dotdot_is_resolved_like_the_filesystem(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, out = os.path.join(tmp, "base"), os.path.join(tmp, "out")
            os.makedirs(os.path.join(out, "child")); os.makedirs(base)
            os.symlink(os.path.join(out, "child"), os.path.join(base, "link"))  # /base/link -> /out/child
            manifest_real = os.path.join(out, "summary.json")                    # the file really lives in the output tree
            Path(manifest_real).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            before = Path(manifest_real).read_bytes()
            spelled = os.path.join(base, "link", "..", "summary.json")           # lexically /base/summary.json, really /out/summary.json
            fetcher = FakeFetcher()
            rc = _run(["--manifest", spelled, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(Path(manifest_real).read_bytes(), before)

    def test_case_alias_of_the_output_directory_cannot_hide_a_manifest_inside_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "run"); os.makedirs(out)
            alias = os.path.join(tmp, "RUN")
            if not os.path.isdir(alias):
                self.skipTest("case-sensitive filesystem: RUN and run are different directories")
            manifest = os.path.join(alias, "summary.json")  # spelled through the case alias, really inside the output tree
            Path(manifest).write_text(json.dumps({"citation_key": "one", "identifiers": [f"doi:{DOI}"]}) + "\n")
            before = Path(manifest).read_bytes()
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(Path(manifest).read_bytes(), before)

    def test_invalid_utf8_manifest_is_invalid_input_and_touches_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref"], FakeFetcher())
            before = _snapshot(out)
            manifest = os.path.join(tmp, "refs.jsonl"); Path(manifest).write_bytes(b'{"citation_key": "\xff", "identifiers": ["x"]}\n')
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(_snapshot(out), before)

    def test_manifest_label_with_unpaired_surrogate_is_refused_before_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            _run(["--id", f"doi:{DOI}", "--out-dir", out, "--providers", "crossref"], FakeFetcher())
            before = _snapshot(out)
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text('{"citation_key": "k\\ud800", "identifiers": ["doi:' + DOI + '"]}\n')
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", out, "--overwrite"], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])
            self.assertEqual(_snapshot(out), before)

    def test_manifest_containment_is_component_aware_including_the_filesystem_root(self):
        # exercised on the helper directly: never run destructive cleanup against the real root
        with self.assertRaises(MOD.InputError):
            MOD._reject_destination_aliases("/summary.json", "/", [])
        with self.assertRaises(MOD.InputError):
            MOD._reject_destination_aliases("/tmp/x/refs.jsonl", "/tmp/x", [])
        MOD._reject_destination_aliases("/tmp/xy/refs.jsonl", "/tmp/x", [])  # a sibling whose name merely shares a prefix is fine

    def test_manifest_keys_differing_only_by_case_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(
                json.dumps({"citation_key": "Paper", "identifiers": [f"doi:{DOI}"]}) + "\n"
                + json.dumps({"citation_key": "paper", "identifiers": [f"doi:{DOI}"]}) + "\n"
            )
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", os.path.join(tmp, "out")], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])

    def test_unparsable_identifier_on_a_later_line_fails_before_any_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(
                json.dumps({"citation_key": "ok", "identifiers": [f"doi:{DOI}"]}) + "\n"
                + json.dumps({"citation_key": "bad", "identifiers": ["Some Author 2001"]}) + "\n"
            )
            fetcher = FakeFetcher()
            rc = _run(["--manifest", manifest, "--out-dir", os.path.join(tmp, "out")], fetcher)
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)
            self.assertEqual(fetcher.urls, [])

    def test_citation_key_is_rejected_in_manifest_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text(json.dumps({"citation_key": "a", "identifiers": [f"doi:{DOI}"]}) + "\n")
            for key in ("x", ""):
                fetcher = FakeFetcher()
                rc = _run(["--manifest", manifest, "--citation-key", key, "--out-dir", os.path.join(tmp, "out")], fetcher)
                self.assertEqual(rc, MOD.EXIT_INVALID_INPUT, repr(key))
                self.assertEqual(fetcher.urls, [])

    def test_malformed_manifest_is_invalid_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "refs.jsonl")
            Path(manifest).write_text('{"citation_key": "a", "identifiers": []}\n')
            rc = _run(["--manifest", manifest, "--out-dir", os.path.join(tmp, "out")], FakeFetcher())
            self.assertEqual(rc, MOD.EXIT_INVALID_INPUT)


if __name__ == "__main__":
    unittest.main()
