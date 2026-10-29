// ============================================================
// TASTE MATCH — scores a to-read book 0-10 against your rated library
//
// The score answers: "how far above or below YOUR average read is this
// book predicted to land?", on 0-10. 5.0 = predicted to be exactly
// your average book; +0.8 predicted stars over your mean = 10
// (a can't-miss favorite); -0.8 stars = 0 (a predicted dud). The full
// range is genuinely reachable because the mapping measures deviation
// from your mean, which has no ceiling: a percentile-of-your-ratings
// mapping was tried first, but damped predictions can never exceed the
// top ratings you have already handed out, so a rater with many 5-star
// books saw every candidate stuck below ~7.
//
// It predicts a star rating for the candidate from three evidence
// signals, each centered on your mean rating and shrunk toward it
// when the evidence is thin:
//   1. Author affinity — damped average of your ratings of this author
//   2. Series affinity — damped average of your ratings of this series,
//      with a confidence bonus when the candidate is the next numbered
//      installment (the strongest predictor a series reader has)
//   3. Tag/subject profile — cosine similarity between the candidate's
//      tags and a signed, IDF-weighted taste profile built from every
//      book you've rated. Books you rated BELOW your mean push their
//      tags down instead of up, so disliked subjects reduce the score.
//
// Why it's built this way:
//   - Mean-centering: a 3.5 from a stingy rater isn't a 3.5 from a
//     generous one, so signals are measured relative to your own mean.
//   - Bayesian shrinkage: an author with one 5-star book shouldn't
//     score like an author with ten of them. Small samples are pulled
//     toward your mean (damped mean) and carry proportionally less
//     weight (confidence-scaled blending).
//   - No saturation: the previous tag score hit its maximum at ~20%
//     overlap, which compressed most of the shelf into a narrow band
//     and destroyed the ranking's usefulness.
//   - Fuzzy matching: authors and series are compared after stripping
//     "(Goodreads Author)" decoration, initials, "series"/"the" noise,
//     so cross-source variants of the same name still match.
// ============================================================

const BASE_WEIGHTS = { author: 0.35, series: 0.25, tags: 0.40 };
const SHRINKAGE_K = 2;        // pseudo-ratings of "your average" blended into small samples
const TAG_CONFIDENCE_N = 6;   // rated+tagged books needed for full tag-signal confidence
const TAG_DELTA_STARS = 1.5;  // max star swing from tag alignment alone

function toRating(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toPos(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
// Name / tag normalization
// ------------------------------------------------------------

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")          // "(Goodreads Author)" and friends
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation, keep letters/digits
    .replace(/\s+/g, " ")
    .trim();
}

function sameAuthor(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb || na === "unknown author" || nb === "unknown author") return false;
  if (na === nb) return true;
  const sa = na.split(" ");
  const sb = nb.split(" ");
  // Require the surname to match exactly, then let given names match if
  // one is a prefix/initial of the other ("Matt Dinniman" ~ "Matthew
  // T. Dinniman", "F. Scott Fitzgerald" ~ "Francis Scott Fitzgerald").
  if (sa[sa.length - 1] !== sb[sb.length - 1]) return false;
  const givenA = sa.slice(0, -1);
  const givenB = sb.slice(0, -1);
  if (!givenA.length || !givenB.length) return true;
  const n = Math.min(givenA.length, givenB.length);
  for (let i = 0; i < n; i++) {
    const ga = givenA[i];
    const gb = givenB[i];
    if (ga === gb) continue;
    if (ga.startsWith(gb) || gb.startsWith(ga)) continue;
    return false;
  }
  return true;
}

function normalizeSeries(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[,;:#]/g, " ")
    .replace(/\bseries\b/g, " ")        // "Dungeon Crawler Carl series"
    .replace(/^(the|a|an)\s+/, "")     // "The Dresden Files"
    .replace(/\s+/g, " ")
    .trim();
}

// OpenLibrary, Goodreads and Google Books phrase the same series
// differently, so accept an exact or prefix match after cleanup.
function sameSeries(a, b) {
  const na = normalizeSeries(a);
  const nb = normalizeSeries(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

function normalizeTag(t) {
  return (t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normTags(tags) {
  return [...new Set((tags || []).map(normalizeTag).filter(Boolean))];
}

// ------------------------------------------------------------
// Signals
// ------------------------------------------------------------

// Damped (shrunken) mean: pulls small samples toward the user's prior.
// One 5-star book no longer reads as "this author is a guaranteed 5".
function dampedMean(ratings, prior) {
  const sum = ratings.reduce((acc, r) => acc + r, 0);
  return (sum + SHRINKAGE_K * prior) / (ratings.length + SHRINKAGE_K);
}

function buildTasteProfile(readBooks, userMean) {
  const freq = {};
  for (const b of readBooks) {
    for (const t of normTags(b.tags)) freq[t] = (freq[t] || 0) + 1;
  }
  const totalDocs = Math.max(readBooks.length, 1);
  const idf = (t) => Math.log((totalDocs + 1) / ((freq[t] || 0) + 1)) + 1;

  // Signed profile: a tag's weight goes up when books you rated above
  // your mean carry it, and DOWN when books you rated below it do.
  const profile = {};
  let evidence = 0;
  for (const b of readBooks) {
    const rating = toRating(b.rating);
    const tags = normTags(b.tags);
    if (rating === null || !tags.length) continue;
    evidence++;
    const delta = rating - userMean;
    for (const t of tags) profile[t] = (profile[t] || 0) + delta * idf(t);
  }
  return { profile, idf, evidence };
}

// Cosine similarity (-1..1) between the candidate's IDF-weighted tag
// vector and the signed taste profile.
function tagCosine(candidateTags, taste) {
  const candTags = normTags(candidateTags);
  const profileEntries = Object.entries(taste.profile);
  if (!candTags.length || !profileEntries.length) return null;

  let dot = 0;
  let candSq = 0;
  for (const t of candTags) {
    const w = taste.idf(t);
    candSq += w * w;
    if (taste.profile[t] !== undefined) dot += w * taste.profile[t];
  }
  const profSq = profileEntries.reduce((acc, [, p]) => acc + p * p, 0);
  if (candSq === 0 || profSq === 0) return null;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(candSq * profSq)));
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------

/**
 * @param {{author:string, series?:string, seriesPosition?:number, tags?:string[]}} candidate
 * @param {Array<{author:string, series?:string, seriesPosition?:number, tags?:string[], rating:number}>} readBooks
 * @returns {number} score 0-10, one decimal; 5.0 = your average book, +/-0.8 predicted stars = full scale
 */
export function computeMatchScore(candidate, readBooks) {
  const rated = (readBooks || []).filter((b) => toRating(b.rating) !== null);
  if (!rated.length) return 5.0; // cold start: no taste data yet

  const ratings = rated.map((b) => toRating(b.rating));
  const userMean = ratings.reduce((acc, r) => acc + r, 0) / ratings.length;

  // --- signal 1: author affinity, damped toward your mean ---
  const authorRatings = rated.filter((b) => sameAuthor(b.author, candidate.author)).map((b) => toRating(b.rating));
  const authorPred = authorRatings.length ? dampedMean(authorRatings, userMean) : null;
  const authorConf = authorRatings.length / (authorRatings.length + SHRINKAGE_K);

  // --- signal 2: series affinity, with a continuation bonus ---
  let seriesPred = null;
  let seriesConf = 0;
  if (candidate.series) {
    const seriesBooks = rated.filter((b) => sameSeries(b.series, candidate.series));
    const seriesRatings = seriesBooks.map((b) => toRating(b.rating));
    if (seriesRatings.length) {
      seriesPred = dampedMean(seriesRatings, userMean);
      seriesConf = seriesRatings.length / (seriesRatings.length + SHRINKAGE_K);
      const positions = seriesBooks
        .map((b) => toPos(b.seriesPosition))
        .filter((p) => p !== null);
      const candPos = toPos(candidate.seriesPosition);
      const isNext = candPos !== null && positions.length &&
        Math.abs(candPos - Math.max(...positions) - 1) < 0.01;
      if (isNext) seriesConf = Math.min(1, seriesConf + 0.25);
    }
  }

  // --- signal 3: signed tag-profile similarity ---
  const taste = buildTasteProfile(rated, userMean);
  const cosine = tagCosine(candidate.tags, taste);
  const tagConf = Math.min(1, taste.evidence / TAG_CONFIDENCE_N);
  const tagPred = cosine !== null
    ? Math.min(5, Math.max(0.5, userMean + cosine * TAG_DELTA_STARS))
    : null;

  // --- blend available signals, weighted by base weight x confidence ---
  const signals = [];
  if (authorPred !== null) signals.push({ w: BASE_WEIGHTS.author * authorConf, pred: authorPred });
  if (seriesPred !== null) signals.push({ w: BASE_WEIGHTS.series * seriesConf, pred: seriesPred });
  if (tagPred !== null) signals.push({ w: BASE_WEIGHTS.tags * tagConf, pred: tagPred });

  const wTotal = signals.reduce((acc, s) => acc + s.w, 0);
  const pred = wTotal > 0
    ? signals.reduce((acc, s) => acc + s.pred * s.w, 0) / wTotal
    : userMean;

  // Map the prediction onto the FULL 0-10 scale, centered on your
  // mean: 5.0 = predicted to be exactly your average read, and 0.8 of
  // a predicted star spans each half of the scale (+0.8 stars = 10,
  // -0.8 stars = 0). Small predicted differences therefore spread
  // across the whole range instead of bunching up: the +/-0.4-star
  // band where most honest predictions live covers 2.5 -> 7.5, and
  // genuinely strong (or dire) evidence pushes past those edges.
  const score = 5 + (pred - userMean) * 6.25;
  return Math.round(Math.min(Math.max(score, 0), 10) * 10) / 10;
}