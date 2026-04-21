/**
 * Pure helper that maps a topic's weight (relative to the heaviest topic on
 * the same person) onto font-size and opacity. Extracted so PersonPanel's
 * chip sizing can be smoke-tested without a DOM.
 *
 * - Relative weight is clamped to [0.25, 1]: even the lightest chip stays
 *   legible.
 * - Font-size scales 10px..14px with relative weight.
 * - Opacity scales 0.6..1 with relative weight.
 */
export function topicChipStyle(
  weight: number,
  maxWeight: number,
): { fontSize: string; opacity: number } {
  const w = Number.isFinite(weight) ? weight : 0;
  const m = Number.isFinite(maxWeight) && maxWeight > 0 ? maxWeight : 1;
  const rel = Math.max(0.25, Math.min(1, w / m));
  const fontSize = 10 + rel * 4;
  const opacity = 0.6 + rel * 0.4;
  return { fontSize: `${fontSize.toFixed(1)}px`, opacity };
}
