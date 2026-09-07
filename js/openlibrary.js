// ============================================================
// OPENLIBRARY — search + enrichment helpers
// Docs: https://openlibrary.org/developers/api
// ============================================================

const SEARCH_URL = "https://openlibrary.org/search.json";
const WORKS_URL = "https://openlibrary.org/works";
const COVERS_URL = "https://covers.openlibrary.org/b/id";

/**
 * Search OpenLibrary for a book by title (and optionally author).
 * Returns a normalized list of candidate matches.
 */
export async function searchBooks(title, author = "", limit = 5) {
  const params = new URLSearchParams({
    title,
    limit: String(limit),
    fields: "key,title,author_name,cover_i,first_publish_year,subject,series"
  });
  if (author) params.set("author", author);

  const res = await fetch(`${SEARCH_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`OpenLibrary search failed: ${res.status}`);
  const data = await res.json();

  return (data.docs || []).map((doc) => ({
    workKey: doc.key, // e.g. "/works/OL45804W"
    title: doc.title,
    author: (doc.author_name && doc.author_name[0]) || "Unknown author",
    coverId: doc.cover_i || null,
    firstPublishYear: doc.first_publish_year || null,
    subjects: (doc.subject || []).slice(0, 12),
    series: (doc.series && doc.series[0]) || null
  }));
}

/**
 * Fetch full work details (mainly for a richer subjects list, since
 * the search endpoint sometimes truncates it).
 */
export async function getWorkDetails(workKey) {
  if (!workKey) return null;
  const res = await fetch(`https://openlibrary.org${workKey}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    subjects: data.subjects || [],
    description:
      typeof data.description === "string"
        ? data.description
        : data.description?.value || ""
  };
}

export function coverUrl(coverId, size = "L") {
  if (!coverId) return "https://placehold.co/300x450/1B2620/EDE6D6?text=No+Cover";
  return `${COVERS_URL}/${coverId}-${size}.jpg`;
}

/**
 * Fetches a book by OpenLibrary ID — used to manually re-sync a book's
 * title, author, cover, and tags when the automatic search matched the
 * wrong edition (or you just have the ID handy).
 *
 * Accepts either a WORK id (e.g. "OL45804W", ends in W) or an EDITION id
 * (e.g. "OL7353617M", ends in M), in bare form, "/works/..." / "/books/..."
 * path form, or a full openlibrary.org URL.
 */
export async function fetchWorkById(rawId) {
  const idMatch = rawId.trim().match(/OL\d+[A-Za-z]/i);
  const olid = (idMatch ? idMatch[0] : rawId.trim()).toUpperCase();
  const type = olid.slice(-1);

  if (type === "M") return fetchFromEdition(olid);
  return fetchFromWork(`/works/${olid}`);
}

async function fetchFromWork(workKey) {
  const res = await fetch(`https://openlibrary.org${workKey}.json`);
  if (!res.ok) throw new Error(`OpenLibrary work not found (${res.status})`);
  const data = await res.json();
  return {
    workKey,
    title: data.title || null,
    author: await resolveAuthorName(data.authors),
    coverId: (data.covers && data.covers[0]) || null,
    subjects: (data.subjects || []).slice(0, 12)
  };
}

async function fetchFromEdition(editionOlid) {
  const res = await fetch(`https://openlibrary.org/books/${editionOlid}.json`);
  if (!res.ok) throw new Error(`OpenLibrary edition not found (${res.status})`);
  const edition = await res.json();

  const workRef = (edition.works && edition.works[0] && edition.works[0].key) || null;
  let subjects = [];
  let authorName = null;

  // Editions rarely carry subjects themselves — pull those (and author, as
  // a fallback) from the parent work when one is linked.
  if (workRef) {
    try {
      const workRes = await fetch(`https://openlibrary.org${workRef}.json`);
      if (workRes.ok) {
        const work = await workRes.json();
        subjects = (work.subjects || []).slice(0, 12);
        authorName = await resolveAuthorName(work.authors);
      }
    } catch {
      /* fall through to edition-level author below */
    }
  }
  if (!authorName) authorName = await resolveAuthorName(edition.authors);

  return {
    workKey: workRef || `/books/${editionOlid}`,
    title: edition.title || null,
    author: authorName,
    coverId: (edition.covers && edition.covers[0]) || null,
    subjects
  };
}

async function resolveAuthorName(authorsField) {
  const ref = authorsField && authorsField[0] && (authorsField[0].author?.key || authorsField[0].key);
  if (!ref) return null;
  try {
    const res = await fetch(`https://openlibrary.org${ref}.json`);
    if (res.ok) return (await res.json()).name || null;
  } catch {
    /* non-fatal — caller keeps the book's existing author */
  }
  return null;
}

/**
 * Best-effort single match for CSV import — takes the first search
 * result. Good enough for enrichment; the admin panel lets you fix
 * mismatches by hand.
 */
export async function findBestMatch(title, author = "") {
  try {
    const results = await searchBooks(title, author, 1);
    return results[0] || null;
  } catch {
    return null;
  }
}