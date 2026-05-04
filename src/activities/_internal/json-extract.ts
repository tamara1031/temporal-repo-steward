/**
 * Shared JSON extraction for activity-side Codex output parsing.
 * Tolerant of preamble / markdown fences / trailing prose - Codex sometimes
 * leaks filler text despite prompt-side hardening.
 */

export type JsonObjectExtraction =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; kind: 'empty' | 'no-json-object' | 'malformed-json' | 'non-object-json'; message: string };

/**
 * Coerce an unknown JSON value to a `string[]`, silently dropping non-string elements.
 * Returns an empty array for any non-array input.
 */
export function extractStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

type JsonObjectExtractionFailure = Extract<JsonObjectExtraction, { ok: false }>;

/**
 * Pull the first `{...}` JSON object out of arbitrary model text. Tolerates a
 * preamble or markdown fences. Returns undefined on any parse failure.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const extracted = extractJsonObjectResult(text);
  return extracted.ok ? extracted.value : undefined;
}

/**
 * Normalize Codex's JSON-like output into either one object or one actionable
 * parse failure. If the response contains a malformed fenced or embedded object,
 * this reports that error instead of searching later text for another object.
 */
export function extractJsonObjectResult(text: string): JsonObjectExtraction {
  const trimmed = text.trim();
  if (!trimmed) {
    return failure('empty', 'structured output was empty');
  }

  // Fast path: whole text is JSON.
  try {
    const parsed = JSON.parse(trimmed);
    return asObject(parsed);
  } catch {
    if (startsLikeJson(trimmed)) {
      return malformed(trimmed);
    }
  }

  // Look for ```json ... ``` fence first (deterministic boundary).
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      return asObject(parsed);
    } catch (err) {
      return malformed(fenced[1].trim(), err);
    }
  }

  // Last resort: parse the first balanced-looking object in prose.
  const start = trimmed.indexOf('{');
  if (start < 0) {
    return failure('no-json-object', 'structured output did not contain a JSON object');
  }

  const candidate = firstBalancedObject(trimmed, start);
  if (!candidate) {
    return failure('malformed-json', 'structured output contained an unterminated JSON object');
  }

  try {
    const parsed = JSON.parse(candidate);
    return asObject(parsed);
  } catch (err) {
    return malformed(candidate, err);
  }
}

function asObject(parsed: unknown): JsonObjectExtraction {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, value: parsed as Record<string, unknown> };
  }
  return failure('non-object-json', 'structured output JSON root must be an object');
}

function malformed(candidate: string, err?: unknown): JsonObjectExtraction {
  const reason = err instanceof Error ? err.message : parseError(candidate);
  return failure('malformed-json', `structured output contained malformed JSON: ${reason}`);
}

function failure(kind: JsonObjectExtractionFailure['kind'], message: string): JsonObjectExtractionFailure {
  return { ok: false, kind, message };
}

function startsLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[');
}

function parseError(candidate: string): string {
  try {
    JSON.parse(candidate);
  } catch (err) {
    if (err instanceof Error) return err.message;
  }
  return 'unknown parse error';
}

function firstBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}
