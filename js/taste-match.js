// ============================================================
// TASTE MATCH — scores a to-read book 0–10 against your rated library
//
// Blends three signals, each derived only from books you've already
// rated:
//   1. Author affinity  — your average rating of that author's other books
//   2. Series affinity  — your average rating of that series so far
//   3. Tag/subject overlap — how much this book's subjects resemble
//      the subjects of books you've rated highly, weighted by rating
//
// Weights shift when a signal isn't available (e.g. no series) so the
// remaining signals still produce a meaningful score.
// ============================================================

const WEIGHTS = { author: 0.35, series: 0.25, tags: 0.40 };

function avgRating(books) {
  if (!books.length) return null;
  const sum = books.reduce((acc, b) => acc + (b.rating || 0), 0);
  return sum / books.length;
}

function tagOverlapScore(candidateTags, readBooks) {
  const withTags = readBooks.filter((b) => b.tags && b.tags.length);
  if (!withTags.length || !candidateTags || !candidateTags.length) return null;

  const freqData = computeTagDocFrequency(withTags);
  const candidateSet = new Set(candidateTags.map((t) => t.toLowerCase()));

  let weightedSum = 0;
  let weightTotal = 0;

  for (const book of withTags) {
    const bookTags = new Set(book.tags.map((t) => t.toLowerCase()));
    const sharedTags = [...candidateSet].filter((t) => bookTags.has(t));
    const unionTags = new Set([...candidateSet, ...bookTags]);
    if (unionTags.size === 0) continue;

    // Weight shared tags by rarity across your read shelf — a match on
    // something specific like "cli-fi" should count for more than a
    // match on a generic tag like "Fiction" that's on almost everything.
    const sharedWeight = sharedTags.reduce((sum, t) => sum + idfWeight(t, freqData), 0);
    const unionWeight = [...unionTags].reduce((sum, t) => sum + idfWeight(t, freqData), 0);
    const weightedJaccard = unionWeight > 0 ? sharedWeight / unionWeight : 0;

    const weight = Math.max(book.rating || 0, 0.5); // even a 0-rated read still counts a little
    weightedSum += weightedJaccard * weight;
    weightTotal += weight;
  }

  if (weightTotal === 0) return null;
  // Normalize: weightedSum/weightTotal is a 0..1-ish similarity; scale to 0..10
  return Math.min((weightedSum / weightTotal) * 5, 1) * 10;
}

// How many of your read books carry each tag, lower-cased. Used to
// downweight tags that appear on nearly everything you've read (they
// carry little information about *this* book specifically) and upweight
// tags that appear on only a few of your favorites (a stronger signal).
function computeTagDocFrequency(readBooks) {
  const freq = {};
  for (const book of readBooks) {
    const seen = new Set(book.tags.map((t) => t.toLowerCase()));
    seen.forEach((t) => { freq[t] = (freq[t] || 0) + 1; });
  }
  return { freq, totalDocs: readBooks.length || 1 };
}

function idfWeight(tag, freqData) {
  const df = freqData.freq[tag] || 0;
  return Math.log((freqData.totalDocs + 1) / (df + 1)) + 1;
}

/**
 * @param {{author:string, series?:string, tags?:string[]}} candidate
 * @param {Array<{author:string, series?:string, tags?:string[], rating:number}>} readBooks
 * @returns {number} score from 0 to 10, one decimal place
 */
export function computeMatchScore(candidate, readBooks) {
  if (!readBooks || !readBooks.length) return 5.0; // neutral — no taste data yet

  const authorBooks = readBooks.filter(
    (b) => b.author && candidate.author && b.author.toLowerCase() === candidate.author.toLowerCase()
  );
  const seriesBooks = candidate.series
    ? readBooks.filter(
        (b) => b.series && b.series.toLowerCase() === candidate.series.toLowerCase()
      )
    : [];

  const authorScore = authorBooks.length ? avgRating(authorBooks) * 2 : null; // 0-5 -> 0-10
  const seriesScore = seriesBooks.length ? avgRating(seriesBooks) * 2 : null;
  const tagScore = tagOverlapScore(candidate.tags, readBooks);

  const available = [
    { key: "author", value: authorScore },
    { key: "series", value: seriesScore },
    { key: "tags", value: tagScore }
  ].filter((s) => s.value !== null);

  if (!available.length) return 5.0;

  const totalWeight = available.reduce((acc, s) => acc + WEIGHTS[s.key], 0);
  const score = available.reduce(
    (acc, s) => acc + (s.value * WEIGHTS[s.key]) / totalWeight,
    0
  );

  return Math.round(Math.min(Math.max(score, 0), 10) * 10) / 10;
}