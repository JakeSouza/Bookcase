// ============================================================
// TAG UTILITIES — shared across import/add flows that combine tags
// from more than one metadata source (OpenLibrary + Google Books).
// ============================================================

const TAG_DISPLAY_CAP = 8;

/**
 * Merges tag lists case-insensitively, alternating between sources round-
 * robin style so a prolific source (usually OpenLibrary) can't fill every
 * slot before a sparser one (usually Google Books) gets a turn. Preserves
 * the casing of whichever source saw a tag first.
 */
export function mergeTags(...lists) {
  const cleaned = lists.map((list) =>
    (list || []).map((t) => (t || "").trim()).filter(Boolean)
  );

  const seenKeys = new Set();
  const result = [];
  let index = 0;
  let addedThisRound = true;

  while (addedThisRound && result.length < TAG_DISPLAY_CAP) {
    addedThisRound = false;
    for (const list of cleaned) {
      if (result.length >= TAG_DISPLAY_CAP) break;
      const tag = list[index];
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        result.push(tag);
        addedThisRound = true;
      }
    }
    index++;
  }

  return result;
}