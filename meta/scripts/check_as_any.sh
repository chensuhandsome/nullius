#!/usr/bin/env bash
# NEW-R02: Diff-scoped `as any` / `.catch(() => {})` gate.
#
# Checks that new code (staged or vs the remote default) does not introduce:
#   - `as any` casts
#   - `.catch(() => {})` swallowed errors
#
# Existing instances in the codebase are NOT flagged (diff-scoped).
#
# Usage:
#   bash meta/scripts/check_as_any.sh              # Check staged changes
#   bash meta/scripts/check_as_any.sh --vs-default # Check branch vs origin/HEAD
#   bash meta/scripts/check_as_any.sh --staged     # Check staged (default)

set -euo pipefail

case "${1:-}" in
  ""|--staged) MODE="staged" ;;
  --vs-default) MODE="vs-default" ;;
  *) echo 'Usage: check_as_any.sh [--staged|--vs-default]' >&2; exit 2 ;;
esac

if [[ "$MODE" == "vs-default" ]]; then
  DIFF_CMD="git diff origin/HEAD...HEAD"
else
  DIFF_CMD="git diff --cached"
fi

# Extract only added lines (^+) from .ts/.tsx files, excluding test files.
DIFF=$($DIFF_CMD -- '*.ts' '*.tsx' ':!*.test.ts' ':!*.test.tsx')
ADDED_LINES=$(printf '%s\n' "$DIFF" | grep '^\+[^+]' || true)

if [[ -z "$ADDED_LINES" ]]; then
  echo "NEW-R02 PASS: no new TS lines to check"
  exit 0
fi

VIOLATIONS=0

# Check for `as any`
AS_ANY_COUNT=$(echo "$ADDED_LINES" | grep -c '\bas any\b' || true)
if [[ "$AS_ANY_COUNT" -gt 0 ]]; then
  echo "NEW-R02 FAIL: $AS_ANY_COUNT new 'as any' cast(s) detected in added lines:" >&2
  echo "$ADDED_LINES" | grep '\bas any\b' | head -20 >&2
  VIOLATIONS=$((VIOLATIONS + AS_ANY_COUNT))
fi

# Check for `.catch(() => {})`
CATCH_COUNT=$(echo "$ADDED_LINES" | grep -cE '\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)' || true)
if [[ "$CATCH_COUNT" -gt 0 ]]; then
  echo "NEW-R02 FAIL: $CATCH_COUNT new swallowed .catch(() => {}) detected:" >&2
  echo "$ADDED_LINES" | grep -E '\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)' | head -20 >&2
  VIOLATIONS=$((VIOLATIONS + CATCH_COUNT))
fi

if [[ "$VIOLATIONS" -gt 0 ]]; then
  echo "NEW-R02: total $VIOLATIONS violation(s). Fix before committing." >&2
  exit 1
fi

echo "NEW-R02 PASS: no new 'as any' or swallowed .catch() in diff"
