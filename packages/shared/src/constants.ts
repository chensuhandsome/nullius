// Result size thresholds (H-13 Result Handling Reform)
// Reference: Anthropic Context Engineering Guide (2025-09), MCP Spec 2025-06-18

/** Soft limit: results up to this size are returned inline; between this and the hard cap they are returned unchanged */
export const MAX_INLINE_RESULT_BYTES = 40_000; // ~10K tokens

/** Hard limit: results above this many UTF-8 bytes are truncated on a character boundary, with a truncation marker */
export const HARD_CAP_RESULT_BYTES = 80_000; // ~20K tokens

/** M-21: Upper bound of the result-size limits above; not separately enforced at runtime (transport escaping is extra) */
export const STDIO_MAX_RESULT_BYTES = 100 * 1024; // 100 KB
