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
 * Normalizes user-entered OpenLibrary identifiers into a work key.
 * Accepts "OL45804W", "/works/OL45804W", or a full openlibrary.org URL.
 */
function normalizeWorkKey(raw) {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/\/works\/OL\w+/i);
  if (urlMatch) return urlMatch[0];
  if (trimmed.startsWith("/works/")) return trimmed;
  return `/works/${trimmed.replace(/^\/+/, "")}`;
}

/**
 * Fetches a specific OpenLibrary work by ID — used to manually re-sync
 * a book's title, author, cover, and tags when the automatic search
 * matched the wrong edition (or you just have the ID handy).
 */
export async function fetchWorkById(rawId) {
  const key = normalizeWorkKey(rawId);
  const res = await fetch(`https://openlibrary.org${key}.json`);
  if (!res.ok) throw new Error(`OpenLibrary work not found (${res.status})`);
  const data = await res.json();

  let authorName = null;
  const authorRef = data.authors?.[0]?.author?.key || data.authors?.[0]?.key;
  if (authorRef) {
    try {
      const aRes = await fetch(`https://openlibrary.org${authorRef}.json`);
      if (aRes.ok) authorName = (await aRes.json()).name;
    } catch {
      /* non-fatal — keep the book's existing author on failure */
    }
  }

  return {
    workKey: key,
    title: data.title || null,
    author: authorName,
    coverId: (data.covers && data.covers[0]) || null,
    subjects: (data.subjects || []).slice(0, 12)
  };
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