/**
 * Heuristic rate-limit detection on Codex stderr / stdout and app-server
 * turn errors. Codex transports do not expose one stable structured error for
 * upstream LLM 429s, so common phrasings are matched in free text.
 */
export function isCodexRateLimitText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('rate-limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota')
  );
}
