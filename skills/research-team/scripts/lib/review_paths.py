"""Reviewer access to executor payloads: own output prefix only."""

from __future__ import annotations

import re


_PAYLOAD_PATH = re.compile(r"(?:team/runs|artifacts/runs/[^/\s'\";()]+/research_team)(?:/[^\s'\";()]*)?", re.IGNORECASE)


def is_forbidden_review_path(member_id: str, safe_tag: str, text: str) -> bool:
    normalized = text.replace("\\", "/")
    own = f"artifacts/runs/{safe_tag}/research_team/{member_id}"
    for match in _PAYLOAD_PATH.finditer(normalized):
        candidate = match.group(0)
        if not safe_tag or not (candidate == own or candidate.startswith(own + "/")):
            return True
    return False
