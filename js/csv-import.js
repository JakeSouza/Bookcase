// ============================================================
// GOODREADS CSV IMPORT
// GoodReads → My Books → Import/Export → Export Library
// ============================================================
import Papa from "https://esm.sh/papaparse@5.4.1";
import { collection, addDoc, serverTimestamp, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-config.js";
import { findBestMatch, getWorkDetails } from "./openlibrary.js";
import { searchGoogleBooks } from "./googlebooks.js";
import { mergeTags } from "./tag-utils.js";

const SHELF_STATUS_MAP = {
  read: "read",
  "to-read": "to-read",
  "currently-reading": "reading"
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// GoodReads bakes series into the title, e.g. "Mistborn (The Mistborn Trilogy, #1)"
function splitSeriesFromTitle(rawTitle) {
  const match = rawTitle.match(/^(.*?)\s*\(([^,()]+)(?:,\s*#?([\d.]+))?\)\s*$/);
  if (!match) return { title: rawTitle.trim(), series: null, seriesPosition: null };
  return {
    title: match[1].trim(),
    series: match[2].trim(),
    seriesPosition: match[3] ? parseFloat(match[3]) : null
  };
}

function extractTags(bookshelvesRaw) {
  if (!bookshelvesRaw) return [];
  return bookshelvesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !["read", "to-read", "currently-reading"].includes(s));
}

// GoodReads exports dates like "2026/03/14" (sometimes with a time
// suffix); "Number of Pages" is a plain number, quoted or not.
function parseGoodreadsDate(raw) {
  if (!raw) return null;
  const t = Date.parse(String(raw).trim().replace(/\//g, "-"));
  return Number.isFinite(t) ? t : null;
}

function parsePageCount(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const libraryKey = (title, author) => (title + "|" + author).toLowerCase().trim();

/**
 * @param {File} file
 * @param {(msg:string)=>void} onProgress
 */
export function importGoodreadsCSV(file, onProgress = () => {}, existingBooks = []) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const rows = results.data;
          let imported = 0;
          let skipped = 0;
          let refreshed = 0;
          const existing = new Map(
            existingBooks.map((b) => [libraryKey(b.title || "", b.author || ""), b])
          );

          for (const [i, row] of rows.entries()) {
            const status = SHELF_STATUS_MAP[(row["Exclusive Shelf"] || "").trim()];
            const rawTitle = (row["Title"] || "").trim();
            if (!status || !rawTitle) {
              skipped++;
              continue;
            }

            const { title, series, seriesPosition } = splitSeriesFromTitle(rawTitle);
            const author = (row["Author"] || "Unknown author").trim();
            const goodreadsRating = parseFloat(row["My Rating"]) || 0;
            const dateRead = status === "read" ? parseGoodreadsDate(row["Date Read"]) : null;
            const csvPageCount = parsePageCount(row["Number of Pages"]);

            // Already in the library? Don't duplicate it — but backfill
            // finish dates and page counts, which power the Year in
            // Review and reading-velocity stats.
            const existingBook = existing.get(libraryKey(title, author));
            if (existingBook) {
              const updates = {};
              if (existingBook.readAt == null && dateRead !== null) updates.readAt = dateRead;
              if (existingBook.pageCount == null && csvPageCount !== null) updates.pageCount = csvPageCount;
              if (Object.keys(updates).length) {
                await updateDoc(doc(db, "books", existingBook.id), updates);
                refreshed++;
              } else {
                skipped++;
              }
              continue;
            }

            onProgress(`(${i + 1}/${rows.length}) Looking up "${title}"…`);

            let coverId = null;
            let googleCoverUrl = null;
            let subjects = [];
            let description = null;
            let workKey = null;
            const match = await findBestMatch(title, author);
            if (match) {
              coverId = match.coverId;
              workKey = match.workKey;
              subjects = match.subjects || [];
              if (match.workKey) {
                const details = await getWorkDetails(match.workKey);
                if (details?.subjects?.length) subjects = details.subjects.slice(0, 12);
                if (details?.description) description = details.description;
              }
            }

            // Cross-reference Google Books — fills gaps and tends to have
            // more consistently-populated categories/descriptions than
            // OpenLibrary alone, without needing an account or API key.
            try {
              const gbook = await searchGoogleBooks(title, author);
              if (gbook) {
                subjects = mergeTags(subjects, gbook.categories);
                if (!description && gbook.description) description = gbook.description;
                if (!coverId && gbook.coverUrl) googleCoverUrl = gbook.coverUrl;
              }
            } catch {
              /* non-fatal — this book just won't get the Google Books cross-reference */
            }

            await addDoc(collection(db, "books"), {
              title,
              author,
              series: series || null,
              seriesPosition: seriesPosition || null,
              status,
              rating: status === "read" && goodreadsRating > 0 ? goodreadsRating : null,
              readAt: dateRead,
              pageCount: csvPageCount,
              tags: subjects.length ? subjects.slice(0, 8) : extractTags(row["Bookshelves"]),
              description,
              coverId,
              googleCoverUrl,
              workKey,
              source: "goodreads-import",
              createdAt: serverTimestamp()
            });

            imported++;
            await sleep(120); // be polite to OpenLibrary's public API
          }

          resolve({ imported, skipped, refreshed, total: rows.length });
        } catch (err) {
          reject(err);
        }
      },
      error: reject
    });
  });
}