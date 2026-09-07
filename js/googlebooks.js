// ============================================================
// GOOGLE BOOKS — keyless, client-side-friendly secondary source
// Used to fill gaps in OpenLibrary's data: descriptions and a second,
// more consistently-populated set of category tags.
// Docs: https://developers.google.com/books/docs/v1/using
// No API key needed for this volume of personal-library-scale search
// traffic; Google's endpoint supports CORS for direct browser calls.
// ============================================================

const VOLUMES_URL = "https://www.googleapis.com/books/v1/volumes";

/**
 * Best-effort single match, mirroring findBestMatch() in openlibrary.js.
 * Returns null on no match or any request failure — this is always a
 * supplementary source, never a required one.
 */
export async function searchGoogleBooks(title, author = "") {
  const q = `intitle:${title}${author ? `+inauthor:${author}` : ""}`;
  const params = new URLSearchParams({ q, maxResults: "1" });

  try {
    const res = await fetch(`${VOLUMES_URL}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item) return null;

    const info = item.volumeInfo || {};
    return {
      description: info.description || null,
      categories: parseCategories(info.categories),
      averageRating: info.averageRating ?? null,
      ratingsCount: info.ratingsCount ?? null
    };
  } catch {
    return null;
  }
}

// Google's categories often arrive as a single "/"-delimited BISAC-style
// path, e.g. "Fiction / Fantasy / Epic" — split into individual tags so
// they merge cleanly with OpenLibrary's flat subject list.
function parseCategories(categories) {
  if (!categories || !categories.length) return [];
  const out = new Set();
  for (const c of categories) {
    c.split("/").forEach((part) => {
      const clean = part.trim();
      if (clean) out.add(clean);
    });
  }
  return [...out];
}