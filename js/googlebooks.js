// ============================================================
// GOOGLE BOOKS — secondary source for descriptions and categories
// Docs: https://developers.google.com/books/docs/v1/using
//
// Unauthenticated requests share a global "anonymous" quota across every
// app on the internet that doesn't send a key — it gets exhausted by
// unrelated traffic and returns HTTP 429. A free API key from the SAME
// Google Cloud project as your Firebase project gives you your own
// dedicated quota instead. To get one:
//   1. console.cloud.google.com → select your Firebase project (top dropdown)
//   2. Search "Books API" in the search bar → click it → Enable
//   3. APIs & Services → Credentials → Create Credentials → API key
//   4. Click "Restrict key" → API restrictions → limit it to Books API
//      (safe to embed in client-side code once restricted this way —
//      the same principle as your public Firebase web config)
//   5. Paste the key below, replacing the placeholder.
// ============================================================

const GOOGLE_BOOKS_API_KEY = "AIzaSyDIvzqVssbBjFY2oKc43UGAnuIjKzQ3Efo";

const VOLUMES_URL = "https://www.googleapis.com/books/v1/volumes";

/**
 * Best-effort single match, mirroring findBestMatch() in openlibrary.js.
 * Returns null only for a genuine "no match found" case. Request failures
 * (bad response, network/CORS errors) are thrown instead of swallowed, so
 * callers can tell the difference between "nothing to enrich" and
 * "something's actually broken."
 */
export async function searchGoogleBooks(title, author = "") {
  const q = `intitle:${title}${author ? `+inauthor:${author}` : ""}`;
  const params = new URLSearchParams({ q, maxResults: "1" });
  if (GOOGLE_BOOKS_API_KEY && GOOGLE_BOOKS_API_KEY !== "AIzaSyDIvzqVssbBjFY2oKc43UGAnuIjKzQ3Efo") {
    params.set("key", GOOGLE_BOOKS_API_KEY);
  }

  const res = await fetch(`${VOLUMES_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Books request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const item = data.items && data.items[0];
  if (!item) return null; // genuinely no match — not an error

  const info = item.volumeInfo || {};
  return {
    description: info.description || null,
    categories: parseCategories(info.categories),
    averageRating: info.averageRating ?? null,
    ratingsCount: info.ratingsCount ?? null
  };
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