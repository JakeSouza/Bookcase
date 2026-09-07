// ============================================================
// TAG UTILITIES — shared across import/add flows that combine tags
// from more than one metadata source (OpenLibrary + Google Books).
// ============================================================
 
/**
 * Merges tag lists case-insensitively, preserving the first-seen casing
 * and original order, and caps the result to a sane display length.
 */
export function mergeTags(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      const trimmed = (raw || "").trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !seen.has(key)) seen.set(key, trimmed);
    }
  }
  return [...seen.values()].slice(0, 10);
}