#!/usr/bin/env python3
"""Fetch provider records for a citation and run the triangulation comparator.

One command turns "the references were checked" from a claim into an
artifact: for each citation, the public bibliographic APIs are queried
directly, the final response of every lookup is saved byte-exact with its
SHA-256 (retry attempts are logged with status, size and hash), one
provider block (v1 schema of triangulate_citation.py) is written per
provider that returned exactly one record, every supplied identifier is
cross-checked against every admitted record (a contradicting record is
withdrawn and the verdict forced to conflicted), and the offline comparator
is run on those blocks. An output directory that already holds a run's
artifacts is refused unless --overwrite is given, so generations never mix.
The resulting report.json / report.md are what a "references verified"
sentence must point to.

Providers and the public endpoints used (all reachable directly; no proxy
is configured here -- the standard library honours the usual
HTTPS_PROXY-style environment variables if the operator sets them):

  crossref     https://api.crossref.org/works/<doi>
  openalex     https://api.openalex.org/works/https://doi.org/<doi>
  inspire      https://inspirehep.net/api/doi/<doi>, /arxiv/<id>,
               /literature/<recid>, /literature?q=j <journal ref>
  arxiv        https://export.arxiv.org/api/query?id_list=<id>  (Atom)
  openlibrary  https://openlibrary.org/isbn/<isbn>.json (+ /authors/<key>.json)

Identifier forms (one citation may carry several):
  doi:10.1000/example.123             (bare "10.…" and https://doi.org/… work)
  arxiv:2109.01038  arxiv:math-ph/0001001   (bare and https://arxiv.org/abs/… work)
  inspire:1234567                     (INSPIRE record number)
  jref:Some.Journal.,12,345           (journal,volume,page-or-article id; INSPIRE only)
  isbn:9780000000001                  (books; Open Library edition record)

Resolution is fail-closed: an identifier lookup that returns one record is
admitted; a search that returns zero or several hits contributes no block.
A record whose author list is truncated by the provider (author_count
larger than the names returned, or an explicit truncation flag) gets
authors = null -- the list is never completed from elsewhere. After the
direct lookups, a DOI or arXiv id that exactly one distinct value of was
found in the fetched records is used for one further hop to providers not
yet queried; that chain is recorded in fetch_log.json.

Outputs (per citation directory):
  raw/<provider>.<json|xml>, raw/<provider>.meta.json   exact bytes + url asked for / url that served it / status / sha256
  blocks.json      provider blocks (comparator v1), validated by the comparator loader
  fetch_log.json   what was asked, what each provider returned, report-only details
                   (book edition/series/publisher/ISBN, journal volume/pages,
                   deposit author order), derived identifiers, admitted providers
  report.json / report.md   overall verdict: the comparator's matrix plus the identifier
                            checks (may be forced to conflicted / insufficient_sources)
  report.cross_index.json / .md   the comparator's output alone; the printed offline
                            re-run command rebuilds exactly these two files

With --manifest (JSON Lines, one {"citation_key": ..., "identifiers": [...]}
per line) every citation gets its own sub-directory and summary.json /
summary.md list the verdicts.

Exit codes follow the comparator: 0 every citation consistent, 1 at least
one conflicted, 2 at least one insufficient_sources (and none conflicted),
3 invalid input / usage, 4 report write failure; 5 is an unexpected internal
failure (never confused with a verdict). A provider that could not be
reached is recorded as fetch_failed and simply contributes no block.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import http.client
import importlib.util
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

FETCH_LOG_VERSION = 1

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMPARATOR_PATH = os.path.join(_HERE, "triangulate_citation.py")


def _load_comparator():
    spec = importlib.util.spec_from_file_location("triangulate_citation", _COMPARATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load comparator module: {_COMPARATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXIT_UNEXPECTED_FAILURE = 5  # distinct from every verdict code; also the exit code when the comparator cannot load

try:
    COMPARATOR = _load_comparator()
except Exception as _exc:  # noqa: BLE001 - a missing comparator must never read as a verdict
    print(f"error: cannot load comparator {_COMPARATOR_PATH}: {_exc.__class__.__name__}: {_exc}", file=sys.stderr)
    sys.exit(EXIT_UNEXPECTED_FAILURE)
InputError = COMPARATOR.InputError

EXIT_CONSISTENT = COMPARATOR.EXIT_CONSISTENT
EXIT_CONFLICTED = COMPARATOR.EXIT_CONFLICTED
EXIT_INSUFFICIENT = COMPARATOR.EXIT_INSUFFICIENT
EXIT_INVALID_INPUT = COMPARATOR.EXIT_INVALID_INPUT
EXIT_WRITE_FAILURE = COMPARATOR.EXIT_WRITE_FAILURE

PROVIDERS = ("crossref", "openalex", "inspire", "arxiv", "openlibrary")
IDENTIFIER_KINDS = ("doi", "arxiv", "inspire", "jref", "isbn")

ENDPOINTS = {
    "crossref": "https://api.crossref.org",
    "openalex": "https://api.openalex.org",
    "inspire": "https://inspirehep.net/api",
    "arxiv": "https://export.arxiv.org/api",
    "openlibrary": "https://openlibrary.org",
}

# arXiv asks for a few seconds between API calls; the other hosts are fine
# with the general --delay spacing.
HOST_MIN_INTERVAL = {"export.arxiv.org": 3.0}
RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_OPENLIBRARY_AUTHOR_FETCHES = 25
MAX_RESPONSE_BYTES = 32 * 1024 * 1024  # a bibliographic record is kilobytes; refuse runaway bodies

_ARXIV_NEW_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")
_ARXIV_OLD_RE = re.compile(r"^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$")
_ARXIV_VERSION_RE = re.compile(r"v\d+$")
_YEAR_RE = re.compile(r"\b(1[5-9]\d\d|20\d\d)\b")

FetchResult = Tuple[int, Dict[str, str], bytes, str]  # status, headers, body, URL that finally served the body
Fetcher = Callable[[str, Dict[str, str], float], FetchResult]


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _collapse_ws(text: Any) -> Optional[str]:
    """Whitespace-collapse a string; anything that is not a string is None (never stringified)."""
    if not isinstance(text, str):
        return None
    collapsed = " ".join(text.split())
    return collapsed or None


def _first_text(value: Any) -> Optional[str]:
    """A provider field that should be a string or a list of strings; first usable string or None."""
    if isinstance(value, str):
        return _collapse_ws(value)
    if isinstance(value, list):
        for item in value:
            text = _collapse_ws(item)
            if text:
                return text
    return None


def _text_list(value: Any) -> List[str]:
    if isinstance(value, str):
        return [t for t in [_collapse_ws(value)] if t]
    if isinstance(value, list):
        return [t for t in (_collapse_ws(item) for item in value) if t]
    return []


def _date_parts_year(value: Any) -> Optional[int]:
    """Year from a Crossref date object {"date-parts": [[Y, M, D]]}; None for anything malformed."""
    if not isinstance(value, dict):
        return None
    parts = value.get("date-parts")
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
        year = parts[0][0]
        if isinstance(year, int) and not isinstance(year, bool):
            return year
    return None


_OPENLIBRARY_AUTHOR_KEY_RE = re.compile(r"/authors/OL\d+A")

_TRUNCATION_MARKER_RE = re.compile(
    r"(?i)(?:^|[^a-z])(?:et\s+al\.?|and\s+others|\+\s*\d+\s*more)(?:[^a-z]|$)|\.\.\.|\u2026"
)


# ---------------------------------------------------------------------------
# Identifiers
# ---------------------------------------------------------------------------

def _require_encodable(value: str, what: str) -> None:
    """Caller-controlled text that will be written to reports and logs must be valid UTF-8 text."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise InputError(f"{what} contains a code point that cannot be written as UTF-8: {exc}") from exc


def parse_identifier(raw: str) -> Tuple[str, str]:
    """Classify one identifier string into (kind, canonical value)."""
    _require_encodable(raw, "identifier")  # written to logs and URLs later; must be valid UTF-8 text
    text = raw.strip()
    if not text:
        raise InputError("empty identifier")
    lowered = text.casefold()
    for kind in IDENTIFIER_KINDS:
        prefix = kind + ":"
        if lowered.startswith(prefix):
            return kind, canonical_identifier(kind, text[len(prefix):])
    if re.match(r"^https?://(?:dx\.)?doi\.org/.+$", text, re.I):
        # Hand the whole URL to the comparator's normalizer: it strips the URL
        # form including query/fragment tails and percent-encoding.
        return "doi", canonical_identifier("doi", text)
    match = re.match(r"^https?://arxiv\.org/abs/(.+)$", text, re.I)
    if match:
        return "arxiv", canonical_identifier("arxiv", match.group(1))
    match = re.match(r"^https?://inspirehep\.net/literature/(\d+)(?:[/?#].*)?$", text, re.I)
    if match:
        return "inspire", canonical_identifier("inspire", match.group(1))
    if text.startswith("10."):
        return "doi", canonical_identifier("doi", text)
    bare_arxiv = re.sub(r"^arxiv:", "", text, flags=re.I)
    if _ARXIV_NEW_RE.match(bare_arxiv) or _ARXIV_OLD_RE.match(bare_arxiv):
        return "arxiv", canonical_identifier("arxiv", bare_arxiv)
    raise InputError(
        f"cannot classify identifier {raw!r}; use an explicit prefix "
        f"({', '.join(kind + ':' for kind in IDENTIFIER_KINDS)})"
    )


def _isbn_checksum_ok(isbn: str) -> bool:
    if len(isbn) == 10:
        total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(isbn))
        return total % 11 == 0
    if len(isbn) == 13:
        return sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(isbn)) % 10 == 0
    return False


def canonical_identifier(kind: str, value: str) -> str:
    text = value.strip()
    if not text:
        raise InputError(f"empty {kind} identifier")
    if kind == "doi":
        doi = COMPARATOR.normalize_doi(text)
        if not doi.startswith("10."):
            raise InputError(f"not a DOI: {value!r}")
        return doi
    if kind == "arxiv":
        text = re.sub(r"^arxiv:", "", text, flags=re.I)
        text = _ARXIV_VERSION_RE.sub("", text)
        if not (_ARXIV_NEW_RE.match(text) or _ARXIV_OLD_RE.match(text)):
            raise InputError(f"not an arXiv identifier: {value!r}")
        return text
    if kind == "inspire":
        if not re.fullmatch(r"\d+", text):
            raise InputError(f"INSPIRE record number must be digits: {value!r}")
        return text.lstrip("0") or "0"  # the index renders control numbers without leading zeros
    if kind == "isbn":
        isbn = re.sub(r"[\s\-]", "", text).upper()
        if not re.fullmatch(r"\d{9}[\dX]|\d{13}", isbn):
            raise InputError(f"not an ISBN-10/13: {value!r}")
        if not _isbn_checksum_ok(isbn):
            raise InputError(f"ISBN check digit is wrong: {value!r}")
        return isbn
    if kind == "jref":
        # The documented form is journal,volume,page-or-article-id: exactly three
        # non-empty parts, so a malformed reference cannot slip through as "not checkable".
        parts = [p.strip() for p in text.split(",")]
        if len(parts) != 3 or not all(parts):
            raise InputError(f"journal reference must be <journal>,<volume>,<page or article id>: {value!r}")
        numeric_range = re.fullmatch(r"(\d+)\s*[-\u2012\u2013\u2014\u2015]\s*\d+", parts[2])
        if numeric_range:
            parts[2] = numeric_range.group(1)  # a page range denotes its start page; article ids are kept whole
        return ",".join(parts)
    raise InputError(f"unknown identifier kind {kind!r}")


# ---------------------------------------------------------------------------
# HTTP session (injectable fetcher for tests)
# ---------------------------------------------------------------------------

def urllib_fetcher(url: str, headers: Dict[str, str], timeout: float) -> FetchResult:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError(f"response exceeds {MAX_RESPONSE_BYTES} bytes")
            return response.status, {k.lower(): v for k, v in response.headers.items()}, body, response.geturl()
    except urllib.error.HTTPError as exc:
        body = exc.read(MAX_RESPONSE_BYTES + 1) if exc.fp is not None else b""
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError(f"error response exceeds {MAX_RESPONSE_BYTES} bytes") from exc
        hdrs = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
        return exc.code, hdrs, body, getattr(exc, "url", None) or url


class Session:
    def __init__(
        self,
        fetcher: Fetcher,
        timeout: float,
        delay: float,
        user_agent: str,
        mailto: Optional[str],
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.fetcher = fetcher
        self.timeout = timeout
        self.delay = delay
        self.user_agent = user_agent + (f" (mailto:{mailto})" if mailto else "")
        self.mailto = mailto
        self._sleep = sleep
        self._last_request_at: Dict[str, float] = {}
        self.requests: List[Dict[str, Any]] = []

    def _pace(self, url: str) -> None:
        host = urllib.parse.urlsplit(url).hostname or ""
        minimum = max(self.delay, HOST_MIN_INTERVAL.get(host, 0.0))
        last = self._last_request_at.get(host)
        if last is not None and minimum > 0:
            wait = minimum - (time.monotonic() - last)
            if wait > 0:
                self._sleep(wait)
        self._last_request_at[host] = time.monotonic()

    def get(self, url: str) -> FetchResult:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json, application/atom+xml;q=0.9, */*;q=0.1",
        }
        for attempt in range(2):
            self._pace(url)
            status, hdrs, body, final_url = self.fetcher(url, headers, self.timeout)
            self.requests.append({"url": url, "final_url": final_url, "status": status, "at": _now(), "bytes": len(body), "sha256": _sha256(body)})
            if status in RETRY_STATUSES and attempt == 0:
                retry_after = hdrs.get("retry-after", "")
                try:
                    pause = max(0.0, min(float(retry_after), 10.0)) if retry_after else 2.0
                except ValueError:
                    pause = 2.0
                self._sleep(pause)
                continue
            return status, hdrs, body, final_url
        return status, hdrs, body, final_url  # pragma: no cover - loop always returns


# ---------------------------------------------------------------------------
# Provider outcomes
# ---------------------------------------------------------------------------

def _outcome(provider: str, status: str, **extra: Any) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "provider": provider,
        "status": status,
        "lookup": None,
        "url": None,
        "final_url": None,
        "http_status": None,
        "raw_path": None,
        "raw_sha256": None,
        "fetched_at": None,
        "notes": [],
        "details": {},
        "derived": {"doi": [], "arxiv": []},
        "block": None,
    }
    record.update(extra)
    return record


def _save_raw(raw_dir: str, name: str, body: bytes, url: str, final_url: str, status: int, content_type: str) -> Tuple[str, str]:
    ext = ".xml" if "xml" in content_type or body.lstrip().startswith(b"<?xml") else ".json"
    path = os.path.join(raw_dir, name + ext)
    os.makedirs(raw_dir, exist_ok=True)
    digest = _sha256(body)
    descriptor, temp_path = tempfile.mkstemp(dir=raw_dir, prefix=".tmp-" + name + "-")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(body)
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    COMPARATOR.write_atomic(
        os.path.join(raw_dir, name + ".meta.json"),
        json.dumps(
            # url = what was requested; final_url = what served the bytes after any redirect (the evidence anchor)
            {"url": url, "final_url": final_url, "http_status": status, "content_type": content_type, "sha256": digest, "bytes": len(body), "fetched_at": _now()},
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n",
    )
    return path, digest


def _fetch_into(outcome: Dict[str, Any], session: Session, url: str, raw_dir: str, raw_name: str) -> Optional[bytes]:
    """Fetch url, save the raw body, and return it (None on transport failure)."""
    outcome["url"] = url
    try:
        status, hdrs, body, final_url = session.get(url)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
        outcome["status"] = "fetch_failed"
        outcome["notes"].append(f"transport error: {exc.__class__.__name__}: {exc}")
        return None
    outcome["final_url"] = final_url
    outcome["http_status"] = status
    outcome["fetched_at"] = _now()
    path, digest = _save_raw(raw_dir, raw_name, body, url, final_url, status, hdrs.get("content-type", ""))
    outcome["raw_path"] = os.path.relpath(path, os.path.dirname(raw_dir))
    outcome["raw_sha256"] = digest
    if status == 404:
        outcome["status"] = "no_record"
        return None
    if status != 200:
        outcome["status"] = "fetch_failed"
        outcome["notes"].append(f"HTTP {status}")
        return None
    return body


def _reject_non_finite(token: str) -> Any:
    raise ValueError(f"non-finite JSON constant {token!r} is not valid JSON")


def _finite_float(token: str) -> float:
    # An ordinary number such as 1e400 overflows to infinity without any named
    # constant appearing; it would later fail strict serialization of the log,
    # so it is refused at parse time and degrades the provider locally instead.
    value = float(token)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"JSON number {token!r} overflows to a non-finite value")
    return value


def _json(body: bytes, outcome: Dict[str, Any]) -> Optional[Any]:
    try:
        return json.loads(body.decode("utf-8"), parse_constant=_reject_non_finite, parse_float=_finite_float)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        outcome["status"] = "parse_failed"
        outcome["notes"].append(f"response is not JSON: {exc}")
        return None


def _finish_block(outcome: Dict[str, Any], fields: Dict[str, Any]) -> None:
    """Attach a comparator-valid block, nulling fields the comparator rejects."""
    block = {"provider": outcome["provider"]}
    for key in COMPARATOR.METADATA_FIELDS:
        block[key] = fields.get(key)
    for _ in range(len(COMPARATOR.METADATA_FIELDS) + 1):
        try:
            COMPARATOR._validate_block(block, outcome["provider"])
            outcome["block"] = block
            outcome["status"] = "ok"
            return
        except InputError as exc:
            message = str(exc)
            # The validator's messages read "<origin>: '<field>...' ..."; anchor on
            # that shape so a provider value containing a quote cannot shadow it.
            anchored = re.search(r": '([a-z_]+)", message)
            culprit = anchored.group(1) if anchored and anchored.group(1) in COMPARATOR.METADATA_FIELDS else None
            if culprit is None or block.get(culprit) is None:
                outcome["status"] = "parse_failed"
                outcome["notes"].append(f"block rejected by comparator: {message}")
                return
            outcome["notes"].append(f"field {culprit!r} set to null: {message}")
            block[culprit] = None
    outcome["status"] = "parse_failed"  # pragma: no cover - loop bound exceeds field count


def _scrub_unencodable(value: Any, where: str, notes: List[str]) -> Any:
    """Provider text that is not valid Unicode (an unpaired surrogate decoded from JSON) is dropped
    with a note rather than letting the log or report write fail later."""
    if isinstance(value, str):
        try:
            value.encode("utf-8")
            return value
        except UnicodeEncodeError:
            notes.append(f"{where}: provider text is not valid Unicode; value dropped")
            return None
    if isinstance(value, list):
        return [_scrub_unencodable(v, f"{where}[{i}]", notes) for i, v in enumerate(value)]
    if isinstance(value, dict):
        cleaned = {}
        for k, v in value.items():
            try:
                str(k).encode("utf-8")
            except UnicodeEncodeError:
                notes.append(f"{where}: an entry whose key is not valid Unicode was dropped")
                continue
            cleaned[k] = _scrub_unencodable(v, f"{where}.{k}", notes)
        return cleaned
    return value


def _scrub_notes(notes: List[str]) -> List[str]:
    """Notes may quote provider text; a note that cannot be written is replaced by a fixed diagnostic."""
    cleaned = []
    for note in notes:
        try:
            note.encode("utf-8")
            cleaned.append(note)
        except UnicodeEncodeError:
            cleaned.append("a note quoting provider text could not be written as UTF-8 and was replaced")
    return cleaned


def _complete_author_list(names: Sequence[Optional[str]], outcome: Dict[str, Any]) -> Optional[List[str]]:
    """Return the author list only when every entry carries a name.

    An entry without a name would otherwise vanish and the block would carry a
    shorter list that still looks complete. That is the same silent shortening
    the no-completion rule forbids, so the whole field becomes null instead.
    """
    if not names:
        return None
    if any(not n for n in names):
        outcome["notes"].append(
            f"{sum(1 for n in names if not n)} of {len(names)} author entries carry no name; "
            "authors set to null (never shortened or completed)"
        )
        return None
    markers = [n for n in names if n and _TRUNCATION_MARKER_RE.search(n)]
    if markers:
        outcome["notes"].append(
            f"author list carries an explicit truncation marker ({', '.join(repr(m) for m in markers)}); "
            "authors set to null (never completed)"
        )
        return None
    return [str(n) for n in names]


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

def _mailto_query(session: Session) -> str:
    return "?mailto=" + urllib.parse.quote(session.mailto, safe="@") if session.mailto else ""


def _lookup_crossref(outcome: Dict[str, Any], session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
    if kind != "doi":
        outcome["notes"].append("crossref resolves DOIs only")
        return outcome
    url = f"{ENDPOINTS['crossref']}/works/{urllib.parse.quote(value, safe='')}{_mailto_query(session)}"
    body = _fetch_into(outcome, session, url, raw_dir, "crossref")
    if body is None:
        return outcome
    doc = _json(body, outcome)
    if doc is None:
        return outcome
    msg = doc.get("message") if isinstance(doc, dict) else None
    if not isinstance(msg, dict):
        outcome["status"] = "parse_failed"
        outcome["notes"].append("no 'message' object in response")
        return outcome

    names: List[Optional[str]] = []
    author_order: List[Dict[str, Any]] = []
    for entry in msg.get("author") or []:
        entry = entry if isinstance(entry, dict) else {}
        family = _collapse_ws(entry.get("family"))
        given = _collapse_ws(entry.get("given"))
        name = _collapse_ws(entry.get("name"))
        if family:
            full: Optional[str] = f"{family}, {given}" if given else family
        elif name:
            full = name
        else:
            full = None
        names.append(full)
        author_order.append({"name": full, "sequence": entry.get("sequence")})
    authors = _complete_author_list(names, outcome)

    # Publication dates only: Crossref's `created` is the deposit timestamp,
    # not a bibliographic date, so it never stands in for the year.
    year: Optional[int] = None
    for key in ("issued", "published-print", "published-online", "published"):
        year = _date_parts_year(msg.get(key))
        if year is not None:
            break

    title = _first_text(msg.get("title"))
    container = _text_list(msg.get("container-title"))
    record_type = msg.get("type") if isinstance(msg.get("type"), str) else None
    venue = container[0] if container else None
    if venue is None and record_type in {"book", "monograph", "edited-book", "reference-book"}:
        venue = _collapse_ws(msg.get("publisher"))

    outcome["details"] = {
        "type": record_type,
        "subtitle": _text_list(msg.get("subtitle")),
        "container_title": container,
        "publisher": msg.get("publisher"),
        "volume": msg.get("volume"),
        "issue": msg.get("issue"),
        "page": msg.get("page"),
        "article_number": msg.get("article-number"),
        "isbn": msg.get("ISBN"),
        "edition_number": msg.get("edition-number"),
        "deposit_author_order": author_order,
        "editors": [
            " ".join(x for x in (_collapse_ws(e.get("given")), _collapse_ws(e.get("family"))) if x)
            for e in (msg.get("editor") if isinstance(msg.get("editor"), list) else [])
            if isinstance(e, dict)
        ],
    }
    _finish_block(
        outcome,
        {
            "title": title,
            "authors": authors,
            "year": year,
            "doi": _first_text(msg.get("DOI")),
            "venue": venue,
            "identifier": _first_text(msg.get("DOI")),
        },
    )
    if outcome["block"] and outcome["block"]["doi"]:
        outcome["derived"]["doi"].append(outcome["block"]["doi"])
    return outcome


def _lookup_openalex(outcome: Dict[str, Any], session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
    if kind != "doi":
        outcome["notes"].append("openalex is queried by DOI only here")
        return outcome
    url = f"{ENDPOINTS['openalex']}/works/https://doi.org/{urllib.parse.quote(value, safe='/()')}{_mailto_query(session)}"
    body = _fetch_into(outcome, session, url, raw_dir, "openalex")
    if body is None:
        return outcome
    doc = _json(body, outcome)
    if not isinstance(doc, dict):
        if doc is not None:
            outcome["status"] = "parse_failed"
        return outcome

    authorships = doc.get("authorships") or []
    names = [
        _collapse_ws(a.get("raw_author_name") or (a.get("author") or {}).get("display_name")) if isinstance(a, dict) else None
        for a in authorships
    ]
    authors = _complete_author_list(names, outcome)
    # Defensive guard. OpenAlex once capped authorships at 100 and flagged the
    # cap with the boolean `is_authors_truncated`; a live check on 2026-10-06
    # returned all 2932 authorships of a large-collaboration record with no such
    # field, so the current API does not appear to truncate. The guard stays in
    # case the field reappears; it is exercised by
    # tests/fixtures/openalex_work_truncated.json. OpenAlex exposes no author
    # count, so a silent truncation would surface only as a cross-provider
    # author-count disagreement in the comparator.
    if doc.get("is_authors_truncated"):
        outcome["notes"].append("provider flags the author list as truncated; authors set to null (never completed)")
        authors = None

    source = (doc.get("primary_location") or {}).get("source") or {}
    outcome["details"] = {
        "type": doc.get("type"),
        "biblio": doc.get("biblio"),
        "ids": doc.get("ids"),
        "publication_date": doc.get("publication_date"),
        "is_retracted": doc.get("is_retracted"),
        "author_positions": [
            {"name": _collapse_ws(a.get("raw_author_name")), "position": a.get("author_position")}
            for a in authorships
            if isinstance(a, dict)
        ],
    }
    _finish_block(
        outcome,
        {
            "title": _collapse_ws(doc.get("display_name") or doc.get("title")),
            "authors": authors,
            "year": doc.get("publication_year") if isinstance(doc.get("publication_year"), int) else None,
            "doi": doc.get("doi"),
            "venue": _collapse_ws(source.get("display_name")),
            "identifier": doc.get("id"),
        },
    )
    if outcome["block"] and outcome["block"]["doi"]:
        outcome["derived"]["doi"].append(outcome["block"]["doi"])
    return outcome


def _lookup_inspire(outcome: Dict[str, Any], session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
    base = ENDPOINTS["inspire"]
    if kind == "doi":
        url = f"{base}/doi/{urllib.parse.quote(value, safe='')}"
    elif kind == "arxiv":
        url = f"{base}/arxiv/{urllib.parse.quote(value, safe='/')}"
    elif kind == "inspire":
        url = f"{base}/literature/{value}"
    elif kind == "jref":
        url = f"{base}/literature?q={urllib.parse.quote('j ' + value)}&size=2"
    else:
        outcome["notes"].append("inspire is not queried by ISBN")
        return outcome
    body = _fetch_into(outcome, session, url, raw_dir, "inspire")
    if body is None:
        return outcome
    doc = _json(body, outcome)
    if not isinstance(doc, dict):
        if doc is not None:
            outcome["status"] = "parse_failed"
        return outcome

    if "hits" in doc:
        hits_obj = doc.get("hits") if isinstance(doc.get("hits"), dict) else {}
        hits = hits_obj.get("hits") if isinstance(hits_obj.get("hits"), list) else []
        total = hits_obj.get("total")
        outcome["details"]["search_hits_total"] = total
        outcome["details"]["search_hits_returned"] = len(hits)
        if not hits or total == 0:
            outcome["status"] = "no_record"
            outcome["notes"].append("journal-reference search returned no record")
            return outcome
        # Exactly one hit object AND a total that agrees with it; a response
        # that contradicts itself is refused rather than resolved by picking.
        total_ok = isinstance(total, int) and not isinstance(total, bool) and total == 1
        if len(hits) != 1 or not total_ok:
            outcome["status"] = "ambiguous"
            outcome["notes"].append(
                f"journal-reference search returned {len(hits)} record object(s) with total={total!r}; "
                "exactly one hit and a total equal to the integer 1 are required, refusing to pick one "
                "(records: " + ", ".join(str(h.get("id")) for h in hits if isinstance(h, dict)) + ")"
            )
            return outcome
        meta = hits[0].get("metadata") if isinstance(hits[0], dict) else None
        meta = meta or {}
    else:
        meta = doc.get("metadata") or {}
    if not isinstance(meta, dict) or not meta:
        outcome["status"] = "parse_failed"
        outcome["notes"].append("no 'metadata' object in response")
        return outcome

    names = [
        _collapse_ws(a.get("full_name")) if isinstance(a, dict) else None
        for a in meta.get("authors") or []
    ]
    author_count = meta.get("author_count")
    authors = _complete_author_list(names, outcome)
    if isinstance(author_count, int) and author_count > len(names):
        outcome["notes"].append(
            f"provider returned {len(names)} of {author_count} authors; authors set to null (never completed)"
        )
        authors = None

    pubinfo = [p for p in meta.get("publication_info") or [] if isinstance(p, dict)]
    journal_entries = [p for p in pubinfo if p.get("journal_title")]
    # Publication year first (journal entry, then any publication_info entry,
    # as book records carry only a bare year), preprint date last.
    published_year = next(
        (p.get("year") for p in journal_entries + pubinfo
         if isinstance(p.get("year"), int) and not isinstance(p.get("year"), bool)), None
    )
    earliest = meta.get("earliest_date") or ""
    earliest_year = int(earliest[:4]) if re.match(r"^\d{4}", earliest) else None
    year = published_year if published_year is not None else earliest_year
    if published_year is not None and earliest_year is not None and published_year != earliest_year:
        outcome["notes"].append(
            f"publication year {published_year} used; earliest (preprint) date is {earliest} -- see details"
        )

    titles = [t.get("title") for t in meta.get("titles") or [] if isinstance(t, dict) and t.get("title")]
    doi_entries = [d for d in meta.get("dois") or [] if isinstance(d, dict) and d.get("value")]
    dois = [d["value"] for d in doi_entries]
    # Erratum / addendum DOIs are tagged by `material`; only publication DOIs
    # denote the work. Several distinct publication DOIs cannot be resolved here.
    publication_dois: List[str] = []
    for entry in doi_entries:
        if entry.get("material") in (None, "publication"):
            value = entry["value"]
            if COMPARATOR.normalize_doi(value) not in {COMPARATOR.normalize_doi(v) for v in publication_dois}:
                publication_dois.append(value)
    if len(publication_dois) > 1:
        outcome["notes"].append(
            f"record carries {len(publication_dois)} distinct publication DOIs ({', '.join(publication_dois)}); doi set to null"
        )
    elif not publication_dois and dois:
        outcome["notes"].append(f"record carries only non-publication DOIs ({', '.join(dois)}); doi set to null")
    eprints = [e.get("value") for e in meta.get("arxiv_eprints") or [] if isinstance(e, dict) and e.get("value")]
    recid = meta.get("control_number")

    outcome["details"] = {
        **outcome["details"],
        "control_number": recid,
        "earliest_date": meta.get("earliest_date"),
        "publication_info": pubinfo,
        "arxiv_eprints": eprints,
        "document_type": meta.get("document_type"),
        "author_count": author_count,
        "authors_returned": len(names),
        "all_titles": titles,
        "all_dois": dois,
        "dois_by_material": [{"value": d["value"], "material": d.get("material")} for d in doi_entries],
        "publication_dois": publication_dois,
        "texkeys": meta.get("texkeys"),
    }
    _finish_block(
        outcome,
        {
            "title": _collapse_ws(titles[0]) if titles else None,
            "authors": authors,
            "year": year,
            "doi": publication_dois[0] if len(publication_dois) == 1 else None,
            "venue": _collapse_ws(journal_entries[0].get("journal_title")) if journal_entries else None,
            "identifier": str(recid) if recid is not None else None,
        },
    )
    outcome["derived"]["doi"].extend(publication_dois)
    outcome["derived"]["arxiv"].extend(eprints)
    return outcome


_ATOM_NS = {
    "a": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "os": "http://a9.com/-/spec/opensearch/1.1/",
}


def _lookup_arxiv(outcome: Dict[str, Any], session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
    if kind != "arxiv":
        outcome["notes"].append("arxiv is queried by arXiv identifier only")
        return outcome
    url = f"{ENDPOINTS['arxiv']}/query?id_list={urllib.parse.quote(value, safe='/')}"
    body = _fetch_into(outcome, session, url, raw_dir, "arxiv")
    if body is None:
        return outcome
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        outcome["status"] = "parse_failed"
        outcome["notes"].append(f"response is not Atom XML: {exc}")
        return outcome
    entries = [
        e for e in root.findall("a:entry", _ATOM_NS)
        if "/api/errors" not in (e.findtext("a:id", default="", namespaces=_ATOM_NS) or "")
    ]
    if not entries:
        outcome["status"] = "no_record"
        outcome["notes"].append("arXiv returned no entry for this identifier")
        return outcome
    # Same cardinality rule as the domain index: exactly one entry AND a reported
    # total equal to the integer 1; a feed that contradicts itself is refused.
    total_text = (root.findtext("os:totalResults", default="", namespaces=_ATOM_NS) or "").strip()
    total_ok = re.fullmatch(r"\d+", total_text) is not None and int(total_text) == 1
    outcome["details"]["search_hits_total"] = int(total_text) if re.fullmatch(r"\d+", total_text) else total_text or None
    outcome["details"]["search_hits_returned"] = len(entries)
    if len(entries) != 1 or not total_ok:
        outcome["status"] = "ambiguous"
        outcome["notes"].append(
            f"arXiv returned {len(entries)} entries with totalResults={total_text!r}; exactly one entry and a "
            "total equal to 1 are required, refusing to pick one"
        )
        return outcome
    entry = entries[0]
    entry_id = entry.findtext("a:id", default="", namespaces=_ATOM_NS) or ""
    versioned = entry_id.rsplit("/abs/", 1)[-1] if "/abs/" in entry_id else None
    published = entry.findtext("a:published", default="", namespaces=_ATOM_NS) or ""
    journal_ref = _collapse_ws(entry.findtext("arxiv:journal_ref", default=None, namespaces=_ATOM_NS))
    authors = _complete_author_list(
        [_collapse_ws(a.findtext("a:name", default=None, namespaces=_ATOM_NS)) for a in entry.findall("a:author", _ATOM_NS)],
        outcome,
    )
    outcome["details"] = {
        **outcome["details"],
        "abs_url": entry_id,
        "version": (_ARXIV_VERSION_RE.search(versioned).group(0) if versioned and _ARXIV_VERSION_RE.search(versioned) else None),
        "published": published or None,
        "updated": entry.findtext("a:updated", default=None, namespaces=_ATOM_NS),
        "journal_ref": journal_ref,
        "comment": _collapse_ws(entry.findtext("arxiv:comment", default=None, namespaces=_ATOM_NS)),
        "primary_category": (entry.find("arxiv:primary_category", _ATOM_NS).get("term") if entry.find("arxiv:primary_category", _ATOM_NS) is not None else None),
    }
    doi = _collapse_ws(entry.findtext("arxiv:doi", default=None, namespaces=_ATOM_NS))
    _finish_block(
        outcome,
        {
            "title": _collapse_ws(entry.findtext("a:title", default=None, namespaces=_ATOM_NS)),
            "authors": authors,
            "year": int(published[:4]) if re.match(r"^\d{4}", published) else None,
            "doi": doi,
            "venue": journal_ref,
            "identifier": versioned,
        },
    )
    if doi:
        outcome["derived"]["doi"].append(doi)
    return outcome


def _lookup_openlibrary(outcome: Dict[str, Any], session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
    if kind != "isbn":
        outcome["notes"].append("openlibrary is queried by ISBN only")
        return outcome
    url = f"{ENDPOINTS['openlibrary']}/isbn/{value}.json"
    body = _fetch_into(outcome, session, url, raw_dir, "openlibrary")
    if body is None:
        return outcome
    doc = _json(body, outcome)
    if not isinstance(doc, dict):
        if doc is not None:
            outcome["status"] = "parse_failed"
        return outcome

    author_entries = doc.get("authors") if isinstance(doc.get("authors"), list) else []
    author_keys = [a.get("key") if isinstance(a, dict) else None for a in author_entries]
    authors: Optional[List[str]] = []
    # Only a well-formed author record path may be turned into a URL on the
    # provider's host; anything else (userinfo tricks, query tails, foreign
    # paths, non-strings) is not an Open Library author key.
    malformed = [k for k in author_keys if not (isinstance(k, str) and _OPENLIBRARY_AUTHOR_KEY_RE.fullmatch(k))]
    if malformed:
        outcome["notes"].append(
            f"{len(malformed)} of {len(author_keys)} author entries carry no well-formed record key "
            f"({', '.join(repr(k)[:60] for k in malformed[:3])}); authors set to null (never shortened or completed)"
        )
        authors = None
    elif len(author_keys) > MAX_OPENLIBRARY_AUTHOR_FETCHES:
        outcome["notes"].append(f"{len(author_keys)} author records exceed the fetch cap; authors set to null")
        authors = None
    else:
        for index, key in enumerate(author_keys):
            sub = _outcome("openlibrary", "not_queried")
            author_body = _fetch_into(sub, session, f"{ENDPOINTS['openlibrary']}{key}.json", raw_dir, f"openlibrary_author_{index}")  # key is a non-empty str here
            author_doc = _json(author_body, sub) if author_body is not None else None
            name = _collapse_ws(author_doc.get("name")) if isinstance(author_doc, dict) else None
            returned_key = author_doc.get("key") if isinstance(author_doc, dict) else None
            if name and returned_key != key:
                # The response must identify the author record that was asked for;
                # a name from some other record is not this edition's author.
                sub["status"] = "key_mismatch"
                sub["notes"].append(f"author record answered with key {returned_key!r} for requested {key!r}")
                name = None
            elif name:
                sub["status"] = "ok"
            elif author_body is not None and sub["status"] == "not_queried":
                sub["status"] = "no_name"  # fetched and parsed, but the record carries no name
            outcome["details"].setdefault("author_fetches", []).append({
                "key": key, "url": sub["url"], "http_status": sub["http_status"], "status": sub["status"],
                "raw_path": sub["raw_path"], "raw_sha256": sub["raw_sha256"], "name": name,
            })
            if not name:
                outcome["notes"].append(f"author record {key} unavailable ({sub['status']}); authors set to null")
                authors = None
                break
            authors.append(name)
        if authors:
            authors = _complete_author_list(authors, outcome)  # fetched names may themselves carry a truncation marker

    publish_date = doc.get("publish_date") if isinstance(doc.get("publish_date"), str) else ""
    years = sorted({int(y) for y in _YEAR_RE.findall(publish_date)})
    if len(years) > 1:
        outcome["notes"].append(
            f"publish_date {publish_date!r} names several years {years}; year set to null (string kept in details)"
        )
    publishers = _text_list(doc.get("publishers"))
    outcome["details"] = {
        **outcome["details"],
        "subtitle": _collapse_ws(doc.get("subtitle")),
        "publishers": publishers,
        "publish_date": publish_date or None,
        "edition_name": doc.get("edition_name"),
        "series": doc.get("series"),
        "number_of_pages": doc.get("number_of_pages"),
        "isbn_10": doc.get("isbn_10"),
        "isbn_13": doc.get("isbn_13"),
        "translated_from": doc.get("translated_from"),
        "languages": [l.get("key") for l in doc.get("languages") or [] if isinstance(l, dict)],
        "works": [w.get("key") for w in doc.get("works") or [] if isinstance(w, dict)],
        "physical_format": doc.get("physical_format"),
        "author_keys": author_keys,
    }
    _finish_block(
        outcome,
        {
            "title": _collapse_ws(doc.get("title")),
            "authors": authors or None,
            "year": years[0] if len(years) == 1 else None,
            "doi": None,
            "venue": publishers[0] if publishers else None,
            "identifier": doc.get("key") if isinstance(doc.get("key"), str) else None,
        },
    )
    return outcome


def _guarded(provider: str, impl: Callable[..., Any]) -> Callable[[Session, str, str, str], Dict[str, Any]]:
    """Run one provider lookup; a malformed payload becomes that provider's parse_failed, never a crash."""
    def run(session: Session, kind: str, value: str, raw_dir: str) -> Dict[str, Any]:
        outcome = _outcome(provider, "not_queried", lookup={"kind": kind, "value": value})
        try:
            impl(outcome, session, kind, value, raw_dir)
        except OSError:
            raise  # a raw-file or report write failure is an execution failure (exit 4), never 'parse_failed'
        except Exception as exc:  # noqa: BLE001 - provider payloads are untrusted input
            outcome["status"] = "parse_failed"
            outcome["block"] = None
            outcome["derived"] = {"doi": [], "arxiv": []}
            outcome["notes"].append(f"provider payload could not be interpreted: {exc.__class__.__name__}: {exc}")
        # Nothing non-Unicode may travel on into the comparator block, the derived identifiers,
        # or the details that end up in fetch_log.json.
        outcome["details"] = _scrub_unencodable(outcome.get("details") or {}, "details", outcome["notes"])
        outcome["derived"] = _scrub_unencodable(outcome.get("derived") or {"doi": [], "arxiv": []}, "derived", outcome["notes"])
        outcome["derived"] = {k: [v for v in vals if v] for k, vals in outcome["derived"].items()}
        if outcome.get("block") is not None:
            before = list(outcome["notes"])
            block = _scrub_unencodable(outcome["block"], "block", outcome["notes"])
            if len(outcome["notes"]) != len(before):
                # A field was dropped: re-validate so the block stays acceptable to the comparator.
                _finish_block(outcome, {k: block.get(k) for k in COMPARATOR.METADATA_FIELDS})
        outcome["notes"] = _scrub_notes(outcome["notes"])
        return outcome
    return run


LOOKUPS = {
    "crossref": _guarded("crossref", _lookup_crossref),
    "openalex": _guarded("openalex", _lookup_openalex),
    "inspire": _guarded("inspire", _lookup_inspire),
    "arxiv": _guarded("arxiv", _lookup_arxiv),
    "openlibrary": _guarded("openlibrary", _lookup_openlibrary),
}

# Which identifier kinds each provider can be queried with, in preference order.
PROVIDER_KINDS = {
    "crossref": ("doi",),
    "openalex": ("doi",),
    "inspire": ("inspire", "doi", "arxiv", "jref"),
    "arxiv": ("arxiv",),
    "openlibrary": ("isbn",),
}


# ---------------------------------------------------------------------------
# One citation
# ---------------------------------------------------------------------------

def _pick(kinds: Sequence[str], available: Dict[str, str]) -> Optional[Tuple[str, str]]:
    for kind in kinds:
        if kind in available:
            return kind, available[kind]
    return None


def parse_identifiers(identifiers: Sequence[str]) -> Tuple[List[Dict[str, str]], Dict[str, str]]:
    """Classify every identifier of one citation; reject two different values of one kind."""
    parsed: List[Dict[str, str]] = []
    available: Dict[str, str] = {}
    for raw in identifiers:
        kind, value = parse_identifier(raw)
        parsed.append({"raw": raw, "kind": kind, "value": value})
        if kind in available:
            if available[kind] != value:
                raise InputError(
                    f"two different {kind} identifiers given for one citation: {available[kind]!r} and {value!r}"
                )
            raise InputError(f"{kind} identifier given twice for one citation: {value!r}")
        available[kind] = value
    return parsed, available


RUN_ARTIFACTS = ("blocks.json", "report.json", "report.md", "report.cross_index.json", "report.cross_index.md", "fetch_log.json", "raw")
MANIFEST_ARTIFACTS = ("summary.json", "summary.md")


def _prepare_out_dir(out_dir: str, overwrite: bool, artifacts: Sequence[str] = RUN_ARTIFACTS) -> None:
    """Refuse to mix generations: a directory holding a previous run's artifacts is rejected unless --overwrite."""
    present = [name for name in artifacts if os.path.lexists(os.path.join(out_dir, name))]
    if not present:
        return
    if not overwrite:
        raise InputError(
            f"{out_dir}: already holds artifacts of a previous run ({', '.join(present)}); "
            "use a fresh --out-dir or pass --overwrite to replace them"
        )
    for name in present:
        path = os.path.join(out_dir, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.unlink(path)


def _stale_citation_dirs(out_dir: str, keep_segments: Sequence[str]) -> List[str]:
    """Sub-directories holding run artifacts that the current run will not rewrite."""
    if not os.path.isdir(out_dir):
        return []
    stale = []
    for entry in sorted(os.listdir(out_dir)):
        path = os.path.join(out_dir, entry)
        if os.path.isdir(path) and not os.path.islink(path) and entry not in keep_segments \
                and any(os.path.lexists(os.path.join(path, a)) for a in RUN_ARTIFACTS):
            stale.append(path)  # any remnant counts, including a raw-only or report-only partial generation
    return stale


def _guard_generations(out_dir: str, overwrite: bool, keep_segments: Sequence[str], root_run_artifacts: bool = False) -> None:
    """Top-level generation guard: summaries, a single-citation generation at the root (manifest mode),
    and foreign citation directories must not survive into a new run."""
    _prepare_out_dir(out_dir, overwrite, MANIFEST_ARTIFACTS + (RUN_ARTIFACTS if root_run_artifacts else ()))
    stale = _stale_citation_dirs(out_dir, keep_segments)
    if stale and not overwrite:
        raise InputError(
            f"{out_dir}: holds citation directories from a previous run that this run would not rewrite "
            f"({', '.join(os.path.basename(p) for p in stale)}); use a fresh --out-dir or pass --overwrite"
        )
    for path in stale:
        shutil.rmtree(path)


def resolve_destination(out_dir: str) -> str:
    """One validated absolute destination, used for every later read, cleanup and write.

    The parent is resolved in filesystem order (a symlink before ".." is followed
    the way the filesystem would follow it), and the final component is then
    required not to be a symbolic link. Lexical tricks -- trailing separators,
    "/.", a symlink followed by ".." -- therefore all name the same real
    directory as the filesystem does, or are refused.
    """
    spelled = os.path.abspath(os.getcwd()) if out_dir in ("", ".") else out_dir
    spelled = spelled if os.path.isabs(spelled) else os.path.join(os.getcwd(), spelled)
    while len(spelled) > 1 and (spelled.endswith(os.sep) or spelled.endswith(os.sep + ".")):
        spelled = spelled[:-1] if spelled.endswith(os.sep) else spelled[:-2]
    if not spelled:
        spelled = os.sep  # "/." stripped down to nothing names the root, not the working directory
    parent, name = os.path.split(spelled)
    if name in ("", ".", ".."):
        return os.path.realpath(spelled)  # names a directory through its parent; nothing left to be a link
    destination = os.path.join(os.path.realpath(parent), name)
    if os.path.islink(destination):
        raise InputError(f"{out_dir}: output directory is a symbolic link; refusing to write or clean artifacts behind it")
    if os.path.lexists(destination) and not os.path.isdir(destination):
        raise InputError(f"{out_dir}: output destination exists and is not a directory")  # refused before any request
    return destination


def resolve_input_path(path: str) -> str:
    """Resolve an input file the way the filesystem opens it: the working directory is
    prepended to a relative spelling and the whole path is then resolved with realpath,
    so a symlink before ".." is followed before the ".." applies (never abspath first)."""
    return os.path.realpath(path if os.path.isabs(path) else os.path.join(os.getcwd(), path))


def _reject_destination_aliases(manifest: Optional[str], out_dir: str, segments: Sequence[str]) -> None:
    """Inputs must not live where cleanup or writing can replace them, and every citation must own a distinct real directory."""
    out_real = os.path.realpath(out_dir)
    if manifest is not None:
        manifest_real = os.path.realpath(manifest)  # already resolved by resolve_input_path in main; realpath is idempotent
        try:
            inside = os.path.commonpath([manifest_real, out_real]) == out_real  # component-aware: a root destination contains everything
        except ValueError:
            inside = False  # different drives (Windows): cannot be inside
        if not inside and os.path.isdir(out_real):
            # Filesystem-faithful check for spellings the string comparison cannot see
            # (case aliases on a case-insensitive filesystem): walk the manifest's
            # ancestors and ask the filesystem whether any of them IS the destination.
            ancestor = os.path.dirname(manifest_real)
            while True:
                try:
                    if os.path.samefile(ancestor, out_real):
                        inside = True
                        break
                except OSError:
                    break
                parent = os.path.dirname(ancestor)
                if parent == ancestor:
                    break
                ancestor = parent
        if inside:
            raise InputError(f"manifest {manifest!r} lies inside the output directory {out_dir!r}; keep inputs outside the tree the run rewrites")
    seen: Dict[str, str] = {}
    for segment in segments:
        path = os.path.join(out_dir, segment)
        if os.path.islink(path):
            raise InputError(f"{path}: citation directory is a symbolic link; refusing to write artifacts behind it")
        if os.path.lexists(path) and not os.path.isdir(path):
            raise InputError(f"{path}: citation destination exists and is not a directory")  # refused before any request
        real = os.path.realpath(path)
        if real in seen:
            raise InputError(f"citation directories {seen[real]!r} and {segment!r} resolve to the same location {real!r}")
        seen[real] = segment


def _normalize_isbn(value: Any) -> Optional[str]:
    """Canonical ISBN-13 form (an ISBN-10 is converted), so the two spellings of one edition compare equal."""
    if not isinstance(value, str):
        return None
    isbn = re.sub(r"[\s\-]", "", value).upper()
    if not re.fullmatch(r"\d{9}[\dX]|\d{13}", isbn) or not _isbn_checksum_ok(isbn):
        return None  # a value with a wrong check digit is not an identifier, so it never compares equal to one
    if len(isbn) == 13:
        return isbn
    core = "978" + isbn[:9]
    check = (10 - sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core)) % 10) % 10
    return core + str(check)


def _as_str_list(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _fold_journal(value: Any) -> str:
    return re.sub(r"[\s.]", "", str(value)).casefold()


def check_supplied_identifiers(parsed: Sequence[Dict[str, str]], outcomes: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every supplied identifier is compared with every admitted record that carries that kind of identity.

    A provider queried by one identifier may return a record whose other
    identifiers contradict what the caller supplied (a DOI and a record number
    that denote different works). Such a record is not evidence about the cited
    work; the check is recorded and the caller drops the record.
    """
    checks: List[Dict[str, Any]] = []
    for name, outcome in outcomes.items():
        block, details = outcome.get("block"), outcome.get("details") or {}
        if block is None:
            continue
        # Supplied identifiers, plus the identifier this record was fetched by
        # (direct or derived): a lookup whose record does not carry what it
        # was asked for has resolved to something else.
        targets = [(item["kind"], item["value"], "supplied") for item in parsed]
        lookup = outcome.get("lookup") or {}
        if lookup.get("kind") and lookup.get("value") and (lookup["kind"], lookup["value"]) not in {(t[0], t[1]) for t in targets}:
            targets.append((lookup["kind"], lookup["value"], "lookup"))
        for kind, value, source in targets:
            try:
                status, observed = _check_one_identifier(kind, value, name, block, details)
            except Exception as exc:  # noqa: BLE001 - identity details are provider data; a bad shape must not abort the run
                status, observed = "check_failed", f"{exc.__class__.__name__}: {exc}"
            checks.append({"kind": kind, "value": value, "source": source, "provider": name, "status": status, "observed": observed})
    return checks


def _check_one_identifier(kind: str, value: str, name: str, block: Dict[str, Any], details: Dict[str, Any]) -> Tuple[str, Any]:
    if kind == "doi":
        # Only DOIs that denote the work count: the block's DOI plus every
        # publication DOI a multi-DOI record retained. An erratum or addendum
        # DOI is associated material, so a supplied DOI that matches only such
        # a DOI contradicts the work's identity rather than confirming it.
        publication = [d for d in [block.get("doi")] + _as_str_list(details.get("publication_dois")) if isinstance(d, str)]
        associated = [e for e in (details.get("dois_by_material") or []) if isinstance(e, dict) and e.get("material") not in (None, "publication")]
        associated_norm = {COMPARATOR.normalize_doi(e["value"]) for e in associated if isinstance(e.get("value"), str)}
        if publication:
            normalized = {COMPARATOR.normalize_doi(d) for d in publication}
            observed: Any = {"publication": publication, "associated": associated} if associated else publication
            return ("matched" if value in normalized else "contradicted"), observed
        if value in associated_norm:
            # The record carries only associated material and the supplied DOI is one
            # of those: it names an erratum or addendum, not the work.
            return "contradicted", {"publication": [], "associated": associated}
        return "not_checkable", None
    if kind == "arxiv":
        found: List[str] = []
        if name == "arxiv" and isinstance(block.get("identifier"), str):
            found.append(_ARXIV_VERSION_RE.sub("", block["identifier"]))
        found += [_ARXIV_VERSION_RE.sub("", e) for e in _as_str_list(details.get("arxiv_eprints"))]
        if found:
            folded = {f.casefold() for f in found}
            return ("matched" if value.casefold() in folded else "contradicted"), found
        return "not_checkable", None
    if kind == "inspire":
        if details.get("control_number") is not None:
            observed = str(details["control_number"])
            return ("matched" if observed == value else "contradicted"), observed
        return "not_checkable", None
    if kind == "isbn":
        raw = _as_str_list(details.get("isbn_10")) + _as_str_list(details.get("isbn_13")) + _as_str_list(details.get("isbn"))
        found = [i for i in (_normalize_isbn(x) for x in raw) if i]
        if found:
            return ("matched" if _normalize_isbn(value) in found else "contradicted"), raw
        return "not_checkable", None
    if kind == "jref":
        parts = [p.strip() for p in value.split(",")]
        if len(parts) < 3:
            return "not_checkable", None
        journal, volume, page = parts[0], parts[1], parts[2]
        # A supplied third part that is itself a hyphenated non-numeric string
        # (a purely numeric range was reduced to its start page at parse time)
        # has no established first page either: it can match a record page
        # exactly, but a non-match is absent evidence, never a contradiction.
        supplied_ambiguous = any(dash in page for dash in "-\u2012\u2013\u2014\u2015")

        def _whole(value: Any) -> Optional[str]:
            return str(value).strip() if isinstance(value, (str, int)) else None

        def _page_candidates(value: Any) -> Tuple[List[str], bool]:
            # Shared by every provider. The whole string always counts. A purely
            # numeric range "123-130" also yields its first page. Any other
            # hyphenated string (such as "A-123-A-130") is ambiguous: its first
            # page cannot be established, so it is not reduced.
            whole = _whole(value)
            if not whole:
                return [], False
            numeric = re.fullmatch(r"(\d+)\s*[-\u2012\u2013\u2014\u2015]\s*(\d+)", whole)
            if numeric:
                return [whole, numeric.group(1)], False
            return [whole], any(dash in whole for dash in "-\u2012\u2013\u2014\u2015")

        if name == "inspire":
            pubinfo = [p for p in details.get("publication_info") or [] if isinstance(p, dict) and p.get("journal_title")]
            if not pubinfo:
                return "not_checkable", None
            # Each entry can confirm or contradict only the fields it carries: a
            # missing volume or page is absent evidence, never a mismatch.
            vol_page_ok, mismatching = [], []
            for p in pubinfo:
                vol = p.get("journal_volume")
                # The article id and the page field each yield the whole string and, for a
                # purely numeric range, its first page; a hyphenated non-numeric string on
                # the record side has no established first page either and stays ambiguous.
                pages, record_ambiguous = set(), False
                for x in (p.get("artid"), p.get("page_start")):
                    candidates, ambiguous = _page_candidates(x)
                    pages.update(candidates)
                    record_ambiguous = record_ambiguous or ambiguous
                vol_state = None if vol is None else str(vol).strip() == volume
                page_state = None if not pages else (True if page in pages else (None if supplied_ambiguous or record_ambiguous else False))
                if vol_state is False or page_state is False:
                    mismatching.append(p)
                elif vol_state and page_state:
                    vol_page_ok.append(p)
            if not vol_page_ok:
                return ("contradicted", pubinfo) if mismatching else ("not_checkable", pubinfo)
            if any(_fold_journal(p.get("journal_title")) == _fold_journal(journal) for p in vol_page_ok):
                return "matched", pubinfo
            # Volume and page agree but the journal is spelled differently: the index
            # uses its own abbreviated title, so this is partial evidence, never a
            # contradiction (and never a match, so it cannot verify the reference).
            return "partial", {"publication_info": pubinfo, "note": "journal spelled differently from the index's own title"}
        # Crossref and OpenAlex name the journal in full while a journal
        # reference abbreviates it, so only volume and page / article number
        # are compared there; the venue stays report-only, as in the comparator.
        if name == "crossref":
            vol = details.get("volume")
            article = _whole(details.get("article_number"))
            pages, ambiguous = _page_candidates(details.get("page"))
        elif name == "openalex":
            biblio = details.get("biblio") if isinstance(details.get("biblio"), dict) else {}
            vol = biblio.get("volume")
            article = None
            pages, ambiguous = _page_candidates(biblio.get("first_page"))
        else:
            return "not_checkable", None
        # Field-wise, as for the domain index: a field the record carries can
        # confirm or contradict; a field it lacks is absent evidence. The
        # supplied third part may be a page or an article id, so it matches if
        # either explicit field agrees; the page string's ambiguity never hides
        # an explicit article-number disagreement.
        vol_state = None if vol is None else str(vol).strip() == volume
        if (article is not None and page == article) or (pages and page in pages):
            page_state = True
        elif (article is not None or (pages and not ambiguous)) and not supplied_ambiguous:
            page_state = False  # at least one explicit, unambiguous field is present and disagrees
        else:
            page_state = None   # nothing present, or an ambiguous hyphenated string on either side
        observed = {"volume": vol, "article_number": article, "pages": pages}
        if vol_state is False or page_state is False:
            return "contradicted", observed
        if vol_state is None or page_state is None:
            return "not_checkable", observed
        # Volume and page agreeing without the journal name is partial evidence: it
        # neither verifies the three-part reference nor contradicts it.
        return "partial", observed
    return "not_checkable", None


def triangulate_citation(
    session: Session,
    citation_key: Optional[str],
    identifiers: Sequence[str],
    out_dir: str,
    providers: Sequence[str],
    follow_derived: bool = True,
    overwrite: bool = False,
) -> Dict[str, Any]:
    parsed, available = parse_identifiers(identifiers)
    if citation_key is not None:
        _require_encodable(citation_key, "--citation-key")
        citation_key = " ".join(citation_key.split()) or None  # headers and logs stay one line
    _prepare_out_dir(out_dir, overwrite)
    request_start = len(session.requests)  # this citation's slice of the session request log

    raw_dir = os.path.join(out_dir, "raw")
    outcomes: Dict[str, Dict[str, Any]] = {}

    # Round 1: direct lookups with the identifiers supplied by the caller.
    for provider in providers:
        choice = _pick(PROVIDER_KINDS[provider], available)
        if choice is None:
            outcomes[provider] = _outcome(provider, "not_queried", notes=[
                f"no usable identifier (accepts {', '.join(PROVIDER_KINDS[provider])})"
            ])
            continue
        kind, value = choice
        outcomes[provider] = LOOKUPS[provider](session, kind, value, raw_dir)

    # Round 2: one hop through identifiers found in the fetched records.
    derived: Dict[str, Dict[str, List[str]]] = {"doi": {}, "arxiv": {}}
    for outcome in outcomes.values():
        for kind in ("doi", "arxiv"):
            for value in outcome["derived"][kind]:
                try:
                    canonical = canonical_identifier(kind, value)
                except InputError:
                    continue
                derived[kind].setdefault(canonical, [])
                if outcome["provider"] not in derived[kind][canonical]:
                    derived[kind][canonical].append(outcome["provider"])
    chain_notes: List[str] = []
    if follow_derived:
        for kind in ("doi", "arxiv"):
            if kind in available:
                values = {k: v for k, v in derived[kind].items() if k != available[kind]}
                for other, sources in values.items():
                    chain_notes.append(
                        f"{kind} {other!r} reported by {', '.join(sources)} differs from the supplied {available[kind]!r}"
                    )
                continue
            distinct = list(derived[kind].keys())
            if len(distinct) == 1:
                value = distinct[0]
                sources = derived[kind][value]
                for provider in providers:
                    if outcomes[provider]["status"] != "not_queried" or kind not in PROVIDER_KINDS[provider]:
                        continue
                    outcome = LOOKUPS[provider](session, kind, value, raw_dir)
                    outcome["lookup"]["derived_from"] = sources
                    outcomes[provider] = outcome
                available[kind] = value
            elif len(distinct) > 1:
                chain_notes.append(
                    f"{len(distinct)} distinct {kind} values found across records "
                    f"({', '.join(distinct)}); no chained lookups by {kind}"
                )

    # Identifiers are part of the claim. Three rules, all fail-closed:
    #  (1) a record contradicting any supplied or lookup identifier is withdrawn
    #      and the verdict is forced to conflicted;
    #  (2) a record whose own lookup identifier could not be positively matched
    #      (check failed, not checkable, partial) is withdrawn: it was asked for
    #      by that identifier and cannot show it carries it;
    #  (3) a supplied identifier that no admitted record positively matches
    #      leaves the run unable to pass as consistent.
    identifier_checks = check_supplied_identifiers(parsed, outcomes)
    contradictions = [c for c in identifier_checks if c["status"] == "contradicted"]
    check_failures = [c for c in identifier_checks if c["status"] == "check_failed"]
    unverified_lookups: List[Dict[str, Any]] = []
    for name, outcome in outcomes.items():
        lookup = outcome.get("lookup") or {}
        if outcome["block"] is None or not lookup.get("kind"):
            continue
        own = [c for c in identifier_checks if c["provider"] == name and c["kind"] == lookup["kind"] and c["value"] == lookup["value"]]
        if not own or own[0]["status"] not in ("matched", "contradicted", "check_failed"):
            unverified_lookups.append({"provider": name, "kind": lookup["kind"], "value": lookup["value"],
                                       "status": own[0]["status"] if own else "unchecked"})
    for check in contradictions + check_failures:
        outcome = outcomes[check["provider"]]
        if outcome["block"] is not None:
            outcome["block"] = None
            outcome["status"] = "identifier_contradicted" if check["status"] == "contradicted" else "identifier_check_failed"
        if check["status"] == "contradicted":
            outcome["notes"].append(
                f"record contradicts the {check['source']} {check['kind']} {check['value']!r} (record carries {check['observed']!r}); "
                "block withdrawn"
            )
        else:
            outcome["notes"].append(
                f"identity check against {check['source']} {check['kind']} {check['value']!r} failed ({check['observed']}); "
                "block withdrawn, verdict cannot be consistent"
            )
    for item in unverified_lookups:
        outcome = outcomes[item["provider"]]
        if outcome["block"] is not None:
            outcome["block"] = None
            outcome["status"] = "identifier_unverified"
        outcome["notes"].append(
            f"record fetched by {item['kind']} {item['value']!r} does not show that identifier ({item['status']}); "
            "block withdrawn, verdict cannot be consistent"
        )
    unverified_supplied = [
        item for item in parsed
        if not any(c["status"] == "matched" and c["kind"] == item["kind"] and c["value"] == item["value"]
                   and outcomes[c["provider"]]["block"] is not None for c in identifier_checks)
    ]

    blocks = [o["block"] for o in outcomes.values() if o["block"] is not None]
    blocks_path = os.path.join(out_dir, "blocks.json")
    report_json = os.path.join(out_dir, "report.json")
    report_md = os.path.join(out_dir, "report.md")

    if blocks:
        COMPARATOR.write_atomic(
            blocks_path,
            json.dumps({"citation_key": citation_key, "providers": blocks}, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        )
        # Re-load through the comparator's own loader so the written file is
        # exactly what a manual re-run would accept.
        loaded, loaded_key = COMPARATOR.load_provider_blocks([blocks_path], cli_citation_key=citation_key)
        report = COMPARATOR.build_report(loaded, loaded_key)
    else:
        report = COMPARATOR.build_report([], citation_key)
        report["verdict_reasons"].append("no provider returned an admissible record")
    cross_index_report = json.loads(json.dumps(report, allow_nan=False))  # frozen copy: pure comparator output
    if contradictions:
        # The cross-index comparison alone cannot see an identifier that points
        # elsewhere; the overall verdict is forced closed.
        report["verdict"] = "conflicted"
        report["exit_code"] = EXIT_CONFLICTED
        for check in contradictions:
            report["verdict_reasons"].append(
                f"{check['source']} {check['kind']} {check['value']!r} contradicted by the {check['provider']} record "
                f"({check['observed']!r}); that record was withdrawn"
            )
    else:
        if check_failures or unverified_lookups or unverified_supplied:
            if report["verdict"] == "consistent":
                report["verdict"] = "insufficient_sources"
                report["exit_code"] = EXIT_INSUFFICIENT
        for check in check_failures:
            report["verdict_reasons"].append(
                f"identity check of the {check['provider']} record against {check['source']} {check['kind']} "
                f"{check['value']!r} failed ({check['observed']}); record withdrawn, no pass without a completed check"
            )
        for item in unverified_lookups:
            report["verdict_reasons"].append(
                f"the {item['provider']} record does not show the {item['kind']} {item['value']!r} it was fetched by "
                f"({item['status']}); record withdrawn"
            )
        for item in unverified_supplied:
            report["verdict_reasons"].append(
                f"supplied {item['kind']} {item['value']!r} is not positively matched by any admitted record; no pass"
            )
    for check in identifier_checks:
        check["record_admitted"] = outcomes[check["provider"]]["block"] is not None
    report["supplied_identifier_checks"] = identifier_checks
    report["unverified_supplied_identifiers"] = [{"kind": i["kind"], "value": i["value"]} for i in unverified_supplied]

    # Two reports: the overall one (cross-index comparison plus the identifier
    # check, possibly forced closed) and a cross-index-only one whose matrix
    # and verdict the offline comparator re-run reproduces (only the timestamp
    # is regenerated). The re-run command targets the latter, so it can never
    # overwrite the stronger verdict.
    cross_index_json = os.path.join(out_dir, "report.cross_index.json")
    cross_index_md = os.path.join(out_dir, "report.cross_index.md")
    if blocks:
        COMPARATOR.write_atomic(cross_index_json, json.dumps(cross_index_report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        COMPARATOR.write_atomic(cross_index_md, COMPARATOR.render_markdown(cross_index_report))
    COMPARATOR.write_atomic(report_json, json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    COMPARATOR.write_atomic(report_md, _render_overall_markdown(report))

    rerun = (
        " ".join(
            shlex.quote(part)
            for part in (
                "python3", _COMPARATOR_PATH, os.path.abspath(blocks_path),
                "--out-json", os.path.abspath(cross_index_json), "--out-md", os.path.abspath(cross_index_md),
            )
        )
        if blocks
        else None
    )
    log = {
        "fetch_log_version": FETCH_LOG_VERSION,
        "citation_key": citation_key,
        "generated_at": _now(),
        "requested_identifiers": parsed,
        "providers": {
            name: {k: v for k, v in outcome.items() if k != "block"}
            for name, outcome in outcomes.items()
        },
        "derived_identifiers": derived,
        "supplied_identifier_checks": identifier_checks,
        "unverified_supplied_identifiers": [{"kind": i["kind"], "value": i["value"]} for i in unverified_supplied],
        "chain_notes": chain_notes,
        "admitted_providers": [o["provider"] for o in outcomes.values() if o["block"] is not None],
        "comparator": {
            "verdict": report["verdict"],
            "exit_code": report["exit_code"],
            "blocks": blocks_path if blocks else None,
            "report_json": report_json,
            "report_md": report_md,
            "cross_index_report_json": cross_index_json if blocks else None,
            "cross_index_report_md": cross_index_md if blocks else None,
            "rerun_command": rerun,
            "rerun_reproduces": "report.cross_index.* matrix and verdict (generated_at is regenerated)" if blocks else None,
        },
        "requests": list(session.requests[request_start:]),
    }
    COMPARATOR.write_atomic(os.path.join(out_dir, "fetch_log.json"), json.dumps(log, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n")
    return log


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _render_overall_markdown(report: Dict[str, Any]) -> str:
    """The comparator's matrix plus the supplied-identifier check table."""
    text = COMPARATOR.render_markdown(report)
    checks = report.get("supplied_identifier_checks") or []
    lines = ["", "## Identifier checks (withdrawn records included)", ""]
    if not checks:
        lines.append("No fetched record carried an identity to compare with the supplied or lookup identifiers.")
    else:
        lines += ["| kind | identifier | source | provider | status | record | observed |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for c in checks:
            admitted = "admitted" if c.get("record_admitted") else "withdrawn"
            lines.append("| " + " | ".join(COMPARATOR._markdown_cell(v) for v in (c["kind"], c["value"], c.get("source"), c["provider"], c["status"], admitted, c["observed"])) + " |")
    unverified = report.get("unverified_supplied_identifiers") or []
    if unverified:
        lines += ["", "Supplied identifiers not positively matched by any admitted record: "
                  + ", ".join(f"{u['kind']} {u['value']}" for u in unverified) + "."]
    lines += ["", "The offline comparator re-run reproduces `report.cross_index.*` (the matrix above); the identifier check is this file's own.", ""]
    return text + "\n".join(lines)


def _safe_segment(key: str) -> str:
    segment = re.sub(r"[^A-Za-z0-9._-]+", "_", key).strip("._")
    if not segment:
        raise InputError(f"citation_key {key!r} does not yield a usable directory name")
    return segment


def _read_manifest(path: str) -> List[Tuple[str, List[str]]]:
    entries: List[Tuple[str, List[str]]] = []
    seen: set = set()
    segments: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError as exc:
        raise InputError(f"{path}: cannot read manifest: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise InputError(f"{path}: manifest is not valid UTF-8: {exc}") from exc
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            raise InputError(f"{path}:{number}: invalid JSON: {exc}") from exc
        if not isinstance(entry, dict) or set(entry) - {"citation_key", "identifiers"}:
            raise InputError(f"{path}:{number}: each line must be {{\"citation_key\", \"identifiers\"}}")
        key = entry.get("citation_key")
        ids = entry.get("identifiers")
        if not isinstance(key, str) or not key.strip():
            raise InputError(f"{path}:{number}: 'citation_key' must be a non-empty string")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i.strip() for i in ids):
            raise InputError(f"{path}:{number}: 'identifiers' must be a non-empty list of strings")
        try:
            _require_encodable(key, "citation_key")
            for i in ids:
                _require_encodable(i, "identifier")
        except InputError as exc:
            raise InputError(f"{path}:{number}: {exc}") from exc
        if key in seen:
            raise InputError(f"{path}:{number}: duplicate citation_key {key!r}")
        seen.add(key)
        segment = _safe_segment(key)
        folded = segment.casefold()  # case-insensitive filesystems alias "Paper" and "paper"
        if folded in {a.casefold() for a in MANIFEST_ARTIFACTS + RUN_ARTIFACTS}:
            raise InputError(
                f"{path}:{number}: citation_key {key!r} would occupy the reserved output name {segment!r}; rename it"
            )
        if folded in segments:
            raise InputError(
                f"{path}:{number}: citation_key {key!r} and {segments[folded]!r} would share the "
                f"directory {segment!r} (compared case-insensitively); rename one so each report path names exactly one citation"
            )
        segments[folded] = key
        try:
            parse_identifiers(ids)
        except InputError as exc:
            raise InputError(f"{path}:{number}: {exc}") from exc
        entries.append((key.strip(), ids))
    if not entries:
        raise InputError(f"{path}: manifest has no entries")
    return entries


def _say(emit: Callable[[], None]) -> None:
    """Run a stdout summary step after every report is written.

    A terminal that cannot encode the summary must not change the exit code
    (the artifacts are complete); the condition is noted on stderr in ASCII.
    """
    try:
        emit()
    except UnicodeError as exc:
        print(f"note: stdout could not encode the summary ({exc.__class__.__name__}); the reports were written", file=sys.stderr)


def _print_log(log: Dict[str, Any], quiet: bool) -> None:
    label = log["citation_key"] or "(no key)"
    if not quiet:
        for name, outcome in log["providers"].items():
            lookup = outcome.get("lookup") or {}
            via = f"{lookup.get('kind')}:{lookup.get('value')}" if lookup.get("kind") else "-"
            if lookup.get("derived_from"):
                via += f" (derived from {', '.join(lookup['derived_from'])})"
            extra = f" raw={outcome['raw_path']} {outcome['raw_sha256']}" if outcome.get("raw_path") else ""
            print(f"[{label}] {name}: {outcome['status']} via {via}{extra}")
            for note in outcome.get("notes") or []:
                print(f"[{label}]   note: {note}")
        for note in log["chain_notes"]:
            print(f"[{label}] chain: {note}")
    comp = log["comparator"]
    print(f"[{label}] verdict: {comp['verdict']} (exit {comp['exit_code']}) -> {comp['report_md']}")
    if not quiet and comp["rerun_command"]:
        print(f"[{label}] re-run offline: {comp['rerun_command']}")


def _aggregate_exit(codes: Sequence[int]) -> int:
    if EXIT_CONFLICTED in codes:
        return EXIT_CONFLICTED
    if EXIT_INSUFFICIENT in codes:
        return EXIT_INSUFFICIENT
    return EXIT_CONSISTENT


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fetch_citation_records.py",
        description=(
            "Fetch one citation's records from the public bibliographic APIs "
            "(Crossref, OpenAlex, INSPIRE, arXiv, Open Library), save raw "
            "responses, write comparator provider blocks, and run the offline "
            "triangulation comparator. Exit codes: 0 consistent, 1 conflicted, "
            "2 insufficient_sources, 3 invalid input, 4 report write failure, "
            "5 unexpected internal failure."
        ),
    )
    parser.add_argument("--id", dest="ids", action="append", default=[], metavar="IDENTIFIER",
                        help="identifier of the ONE citation under test (repeatable): doi:, arxiv:, inspire:, jref:, isbn:")
    parser.add_argument("--citation-key", default=None, help="label for the citation (single-citation mode)")
    parser.add_argument("--manifest", default=None, metavar="FILE.jsonl",
                        help="JSON Lines file with one {\"citation_key\", \"identifiers\"} object per line; "
                             "each citation gets its own sub-directory of --out-dir")
    parser.add_argument("--out-dir", required=True, help="directory for raw responses, blocks, logs, and reports")
    parser.add_argument("--providers", default=",".join(PROVIDERS),
                        help=f"comma-separated subset of {', '.join(PROVIDERS)} (default: all)")
    parser.add_argument("--overwrite", action="store_true",
                        help="replace a previous run's artifacts found in the output directory (default: refuse)")
    parser.add_argument("--no-derived", action="store_true",
                        help="do not follow DOIs / arXiv ids found in fetched records to providers not yet queried")
    parser.add_argument("--timeout", type=float, default=30.0, help="per-request timeout in seconds (default 30)")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="minimum seconds between requests to one host (default 1; arXiv is always paced at 3)")
    parser.add_argument("--mailto", default=os.environ.get("CITATION_FETCH_MAILTO") or None,
                        help="contact address passed to Crossref/OpenAlex polite pools (or env CITATION_FETCH_MAILTO)")
    parser.add_argument("--user-agent", default="nullius-citation-triangulation/1 (python-urllib)")
    parser.add_argument("--quiet", action="store_true", help="print only the verdict line per citation")
    return parser


def main(argv: Optional[Sequence[str]] = None, fetcher: Fetcher = urllib_fetcher,
         sleep: Callable[[float], None] = time.sleep) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse exits 2 on usage errors; fold into the invalid-input code
        # (0 for --help passes through, as in the comparator).
        return EXIT_INVALID_INPUT if exc.code else 0

    providers = [p.strip() for p in args.providers.split(",") if p.strip()]
    unknown = [p for p in providers if p not in PROVIDERS]
    if unknown or not providers:
        print(f"error: unknown provider(s) {unknown}; choose from {', '.join(PROVIDERS)}", file=sys.stderr)
        return EXIT_INVALID_INPUT
    if len(set(providers)) != len(providers):
        # Each provider owns one outcome slot and one raw file; a repeated name
        # would overwrite the first response and its identity check.
        print(f"error: --providers lists a provider more than once ({args.providers!r})", file=sys.stderr)
        return EXIT_INVALID_INPUT
    if bool(args.manifest) == bool(args.ids):
        print("error: give either --id (one citation, repeatable) or --manifest, not both and not neither", file=sys.stderr)
        return EXIT_INVALID_INPUT
    if args.manifest and args.citation_key is not None:
        print("error: --citation-key applies to single-citation mode; manifest entries carry their own keys", file=sys.stderr)
        return EXIT_INVALID_INPUT
    import math
    for flag, value in (("--mailto", args.mailto), ("--user-agent", args.user_agent)):
        if value is None:
            continue
        # These go into request headers / query strings and into the log: printable ASCII only, no line breaks.
        if not all(32 <= ord(ch) < 127 for ch in value):
            print(f"error: {flag} must be printable ASCII without line breaks (got {value!r})", file=sys.stderr)
            return EXIT_INVALID_INPUT
    if not (math.isfinite(args.delay) and args.delay >= 0):
        print(f"error: --delay must be a finite, non-negative number of seconds (got {args.delay!r})", file=sys.stderr)
        return EXIT_INVALID_INPUT
    if not (math.isfinite(args.timeout) and args.timeout > 0):
        print(f"error: --timeout must be a finite, positive number of seconds (got {args.timeout!r})", file=sys.stderr)
        return EXIT_INVALID_INPUT

    session = Session(fetcher, args.timeout, args.delay, args.user_agent, args.mailto, sleep=sleep)

    try:
        out_dir = resolve_destination(args.out_dir)  # the one destination every cleanup and write uses
        if args.manifest:
            manifest = resolve_input_path(args.manifest)  # the one spelling read and checked for containment
            entries = _read_manifest(manifest)
            segments = [_safe_segment(key) for key, _ids in entries]
            _reject_destination_aliases(manifest, out_dir, segments)
            # Preflight every destination before the first fetch so one
            # generation never half-replaces another: stale summaries and
            # citation directories absent from this manifest go first.
            _guard_generations(out_dir, args.overwrite, segments, root_run_artifacts=True)
            for key, _ids in entries:
                _prepare_out_dir(os.path.join(out_dir, _safe_segment(key)), args.overwrite)
            summaries: List[Dict[str, Any]] = []
            for key, ids in entries:
                sub_dir = os.path.join(out_dir, _safe_segment(key))
                log = triangulate_citation(session, key, ids, sub_dir, providers, not args.no_derived, args.overwrite)
                _say(lambda: _print_log(log, args.quiet))  # a terminal that cannot encode one label must not abort the batch
                summaries.append({
                    "citation_key": key,
                    "directory": os.path.relpath(sub_dir, out_dir),
                    "verdict": log["comparator"]["verdict"],
                    "exit_code": log["comparator"]["exit_code"],
                    "admitted_providers": log["admitted_providers"],
                    "report_md": os.path.relpath(log["comparator"]["report_md"], out_dir),
                })
            summary = {"fetch_summary_version": FETCH_LOG_VERSION, "generated_at": _now(), "citations": summaries}
            COMPARATOR.write_atomic(os.path.join(out_dir, "summary.json"), json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            lines = ["# Citation triangulation summary", "", f"- generated_at: {summary['generated_at']}", "",
                     "| citation_key | verdict | providers | report |", "| --- | --- | --- | --- |"]
            for row in summaries:
                cells = [row["citation_key"], row["verdict"], ", ".join(row["admitted_providers"]) or "(none)", row["report_md"]]
                lines.append("| " + " | ".join(str(c).replace("|", "\\|").replace("\r", " ").replace("\n", " ") for c in cells) + " |")
            COMPARATOR.write_atomic(os.path.join(out_dir, "summary.md"), "\n".join(lines) + "\n")
            _say(lambda: print(f"summary: {os.path.join(out_dir, 'summary.md')}"))
            return _aggregate_exit([row["exit_code"] for row in summaries])

        parse_identifiers(args.ids)  # validate the input before any cleanup can touch an existing generation
        if args.citation_key is not None:
            _require_encodable(args.citation_key, "--citation-key")
        _reject_destination_aliases(None, out_dir, [])
        _guard_generations(out_dir, args.overwrite, [])  # a previous manifest run must not share this directory
        log = triangulate_citation(session, args.citation_key, args.ids, out_dir, providers, not args.no_derived, args.overwrite)
        _say(lambda: _print_log(log, args.quiet))
        return log["comparator"]["exit_code"]
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT
    except (OSError, UnicodeError) as exc:
        print(f"error: cannot write output: {exc}", file=sys.stderr)
        return EXIT_WRITE_FAILURE
    except Exception as exc:  # noqa: BLE001 - a crash must never read as a verdict
        print(f"error: unexpected failure: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return EXIT_UNEXPECTED_FAILURE


if __name__ == "__main__":
    sys.exit(main())
