/**
 * Shared helper for converting parallel review results into the flat
 * `string[]` feedback passed to the next iteration's implementer or refiner.
 *
 * Both `refactor-step-loop.ts` and `design-phase-loop.ts` follow the same
 * pattern: zip reviews with their concern labels, emit each blocking issue
 * as `[concern] issue` and the first N suggestions as `[concern] suggestion`.
 * Centralising the logic here removes the three-way duplication and makes
 * the intent of "collect feedback from every reviewer, optionally skipping
 * one" explicit.
 *
 * Determinism: pure data transform, no Temporal API. Safe to import from
 * any workflow file.
 */

interface ReviewSlice {
  blocking_issues: string[];
  suggestions: string[];
}

/**
 * Flatten an array of parallel review results into a feedback string list.
 *
 * @param reviews      Results from the reviewer activities, one per concern.
 * @param concerns     Labels in the same order as `reviews`.
 * @param skipIndex    When provided, the review at this index is omitted.
 *                     Used in the critical_block path where the blocking
 *                     reviewer's feedback has already been added separately.
 * @param maxSuggestions  Maximum suggestions to take per reviewer (default 2).
 */
export function collectFeedback(
  reviews: readonly ReviewSlice[],
  concerns: readonly string[],
  skipIndex?: number,
  maxSuggestions = 2,
): string[] {
  const feedback: string[] = [];
  for (let i = 0; i < reviews.length; i++) {
    if (i === skipIndex) continue;
    const r = reviews[i];
    const tag = concerns[i];
    for (const issue of r.blocking_issues) feedback.push(`[${tag}] ${issue}`);
    for (const sugg of r.suggestions.slice(0, maxSuggestions)) feedback.push(`[${tag}] ${sugg}`);
  }
  return feedback;
}
