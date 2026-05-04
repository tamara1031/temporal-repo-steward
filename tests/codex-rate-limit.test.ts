import { describe, expect, it } from 'vitest';
import { isCodexRateLimitText } from '../src/activities/_internal/codex-rate-limit';

describe('isCodexRateLimitText', () => {
  it.each([
    'request failed with HTTP 429 from upstream',
    'model provider reported a rate limit',
    'rate_limit_exceeded',
    'rate-limit exceeded',
    'Too Many Requests',
    'quota has been exhausted',
  ])('matches Codex rate-limit phrase: %s', (message) => {
    expect(isCodexRateLimitText(message)).toBe(true);
  });

  it.each([
    '',
    'authentication failed',
    'JSON-RPC -32602 invalid params',
    'model returned malformed JSON',
    'network connection reset',
  ])('does not match unrelated Codex failure text: %s', (message) => {
    expect(isCodexRateLimitText(message)).toBe(false);
  });
});
