// ============================================================
// GOODREADS CSV IMPORT
// GoodReads → My Books → Import/Export → Export Library
// ============================================================
import Papa from "https://esm.sh/papaparse@5.4.1";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
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

/**
 * @param {File} file
 * @param {(msg:string)=>void} onProgress
 */
export function importGoodreadsCSV(file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const rows = results.data;
          let imported = 0;
          let skipped = 0;

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

            onProgress(`(${i + 1}/${rows.length}) Looking up "${title}"…`);

            let coverId = null;
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
              tags: subjects.length ? subjects.slice(0, 8) : extractTags(row["Bookshelves"]),
              description,
              coverId,
              workKey,
              source: "goodreads-import",
              createdAt: serverTimestamp()
            });

            imported++;
            await sleep(120); // be polite to OpenLibrary's public API
          }

          resolve({ imported, skipped, total: rows.length });
        } catch (err) {
          reject(err);
        }
      },
      error: reject
    });
  });
}