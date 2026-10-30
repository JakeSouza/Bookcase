import { db, auth } from "./firebase-config.js";
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { searchBooks, coverUrl, fetchWorkById, getWorkDetails } from "./openlibrary.js";
import { searchGoogleBooks, fetchGoogleBookById } from "./googlebooks.js";
import { mergeTags } from "./tag-utils.js";
import { computeMatchScore, computeMatchScores, predictRating } from "./taste-match.js";
import { importGoodreadsCSV } from "./csv-import.js";

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let allBooks = [];
let isAdmin = false;
// Book id -> calibrated 0-5 match score from the latest to-read shelf
// render, so the book card shows the same number the shelf does.
let matchScoreById = {};

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
// Light-theme "no cover" placeholder, generated inline so it needs no
// third-party service (placehold.co can be slow or unavailable) and always
// matches the design.
const PLACEHOLDER_COVER = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">' +
  '<rect width="300" height="450" fill="#E7EAF0"/>' +
  '<path d="M150 118l38 76-76 0z" fill="#D3DAE4"/>' +
  '<rect x="70" y="215" width="160" height="8" rx="4" fill="#D3DAE4"/>' +
  '<rect x="90" y="232" width="120" height="8" rx="4" fill="#E2E8F0"/>' +
  '<text x="150" y="285" font-family="sans-serif" font-size="15" fill="#94A3B8" text-anchor="middle">No cover</text>' +
  '</svg>'
);

// A book's cover: OpenLibrary's cover if we have one, otherwise fall back
// to a Google Books cover image gathered during import/backfill, otherwise
// the inline placeholder above.
function resolveCoverUrl(book, size = "M") {
  if (book.coverId) return coverUrl(book.coverId, size);
  if (book.googleCoverUrl) return book.googleCoverUrl;
  return PLACEHOLDER_COVER;
}

// Firestore values can arrive as strings (older imports, manual edits) —
// always coerce before doing arithmetic or calling number methods.
function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function truncate(str, max) {
  if (!str) return "";
  const clean = str.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Progress is tracked in PAGES (pagesRead / pageCount) — the percentage
// is computed, never stored. Books from before this change (or with only
// a legacy percentage) fall back to progressPercent.
function bookProgress(book) {
  const pageCount = toNum(book.pageCount);
  const pagesRead = toNum(book.pagesRead);
  if (pageCount && pagesRead !== null) {
    return Math.max(0, Math.min(100, Math.round((pagesRead / pageCount) * 100)));
  }
  const pct = toNum(book.progressPercent);
  return pct !== null ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
}

// Reading velocity from the progress log: pages/day between the first
// and last logged check-ins. Needs at least two points at least half a
// day apart to mean anything.
function readingVelocity(book) {
  const log = Array.isArray(book.progressLog) ? [...book.progressLog].sort((a, b) => a.t - b.t) : [];
  if (log.length < 2) return null;
  const first = log[0];
  const last = log[log.length - 1];
  const days = (last.t - first.t) / 86400000;
  if (days < 0.5) return null;
  const pages = (toNum(last.p) ?? 0) - (toNum(first.p) ?? 0);
  if (pages <= 0) return null;
  return { pagesPerDay: pages / days, lastT: last.t };
}

// Friendly label for when the current book should be finished, given
// the recent reading pace.
function predictedFinishLabel(book, velocity) {
  const pageCount = toNum(book.pageCount);
  const pagesRead = toNum(book.pagesRead) ?? 0;
  if (!pageCount || pagesRead >= pageCount) return "soon";
  const daysLeft = (pageCount - pagesRead) / velocity.pagesPerDay;
  if (daysLeft > 365) return "someday, at this pace";
  const d = new Date(velocity.lastT + daysLeft * 86400000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Snapshot the taste model's predicted star rating for a book. Taken
// the moment a book goes live (started, finished or first rated) so the
// Year in Review can grade the recommender against reality later.
function predictForBook(book) {
  const p = predictRating(
    book,
    allBooks.filter((b) => b.status === "read" && toNum(b.rating) !== null && b.id !== book.id)
  );
  return p ? Math.round(p.pred * 100) / 100 : null;
}

// Multi-axis ratings: the dimensions a single star score can't capture.
const AXES = [["plot", "Plot"], ["characters", "Characters"], ["prose", "Prose"], ["pacing", "Pacing"], ["world", "World"]];

// Google Books (and sometimes OpenLibrary) descriptions arrive as HTML
// snippets (<b>, <i>, <br>, <p>). Instead of printing those tags as literal
// text, render the safe subset as real formatting. Everything outside the
// whitelist is unwrapped and every attribute is stripped, so API content can
// never inject scripts, links, or styles into the page.
function descriptionToHtml(raw, maxChars = Infinity, opts = {}) {
  if (!raw) return "";
  const hasTags = /<\/?[a-z][^>]*>/i.test(raw);
  if (!hasTags) {
    // Plain-text description: keep the old collapse-and-truncate behaviour.
    return "<p>" + escapeHtml(truncate(raw, maxChars)) + "</p>";
  }

  const parsed = new DOMParser().parseFromString(raw, "text/html");
  // Dangerous elements are removed outright, not unwrapped.
  for (const el of [...parsed.body.querySelectorAll("script, style, iframe, object, embed, link, meta, img")]) {
    el.remove();
  }
  const allowed = new Set(["B", "STRONG", "I", "EM", "U", "BR", "P"]);
  let disallowed;
  do {
    disallowed = [...parsed.body.querySelectorAll("*")].filter((el) => !allowed.has(el.tagName));
    for (const el of disallowed) el.replaceWith(...el.childNodes);
  } while (disallowed.length);
  for (const el of parsed.body.querySelectorAll("*")) {
    while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
  }

  if (opts.flow) {
    // Compact mode for tight spaces (the hero blurb): Google Books
    // descriptions put a <br> after every sentence, which would stretch the
    // card vertically. Treat line and paragraph breaks as spaces so the
    // blurb stays one flowing paragraph; only the bold/italic formatting
    // survives as structure.
    for (const br of [...parsed.body.querySelectorAll("br")]) {
      br.replaceWith(parsed.createTextNode(" "));
    }
    for (const p of [...parsed.body.querySelectorAll("p")]) {
      p.replaceWith(parsed.createTextNode(" "), ...p.childNodes, parsed.createTextNode(" "));
    }
  }

  if (maxChars !== Infinity) {
    // Trim to a text-only character budget so no tag can end up half-open.
    const textNodes = [];
    const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n);
    let seen = 0;
    for (const n of textNodes) {
      if (seen >= maxChars) {
        n.remove();
      } else if (seen + n.data.length > maxChars) {
        n.data = n.data.slice(0, maxChars - seen).replace(/\s+\S*$/, "") + "…";
        seen = maxChars;
      } else {
        seen += n.data.length;
      }
    }
    for (const p of [...parsed.body.querySelectorAll("p")]) {
      if (!p.textContent.trim()) p.remove();
    }
  }

  return parsed.body.innerHTML.trim();
}

function showToast(msg, ms = 3200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), ms);
}

function seriesAverages(books) {
  const bySeriesRating = {};
  for (const b of books) {
    const rating = toNum(b.rating);
    if (!b.series || rating === null) continue;
    (bySeriesRating[b.series] ||= []).push(rating);
  }
  const avg = {};
  for (const [series, ratings] of Object.entries(bySeriesRating)) {
    avg[series] = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  }
  return avg;
}

// ------------------------------------------------------------
// Firestore live data
// ------------------------------------------------------------
onSnapshot(
  collection(db, "books"),
  (snap) => {
    allBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  },
  (err) => {
    // Without this, a failed read (rules, quota, network) silently leaves
    // the page stuck on "Loading your shelves…" with only a console error.
    console.error("Failed to load books from Firestore:", err);
    const sub = document.getElementById("greeting-sub");
    if (sub) sub.textContent = "Couldn’t reach the library — your shelves failed to load. Check your connection or Firestore rules, then reload.";
    const shelf = document.getElementById("read-shelf");
    const queue = document.getElementById("tbr-shelf");
    const msg = "Library unavailable — see the browser console for details.";
    if (shelf) shelf.innerHTML = '<p class="shelf-empty">' + msg + "</p>";
    if (queue) queue.innerHTML = '<p class="shelf-empty">' + msg + "</p>";
  }
);

function renderStats() {
  const read = allBooks.filter((b) => b.status === "read");
  const tbr = allBooks.filter((b) => b.status === "to-read");
  const reading = allBooks.find((b) => b.status === "reading");
  const rated = read.map((b) => toNum(b.rating)).filter((r) => r !== null);
  const avg = rated.length ? rated.reduce((acc, r) => acc + r, 0) / rated.length : null;
  const authors = new Set(read.map((b) => b.author)).size;

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("stat-finished", String(read.length));
  set("stat-avg", avg ? avg.toFixed(1) : "–");
  set("stat-authors", String(authors));
  set("stat-queue", String(tbr.length));

  const finCount = document.querySelector('[data-count="finished"]');
  if (finCount) finCount.textContent = String(read.length);
  const queueCount = document.querySelector('[data-count="queue"]');
  if (queueCount) queueCount.textContent = String(tbr.length);

  const sub = document.getElementById("greeting-sub");
  if (sub) {
    if (reading) {
      const pct = bookProgress(reading);
      sub.textContent = pct >= 100
        ? "Almost done with \u201C" + reading.title + "\u201D\u2014 mark it finished to rate it."
        : "You\u2019re " + pct + "% into \u201C" + reading.title + "\u201D.";
    } else {
      sub.textContent = "Nothing on the nightstand \u2014 pick something from the queue.";
    }
  }
}

function renderAll() {
  // Each section renders independently \u2014 one malformed book document can
  // never blank out the whole page.
  const sections = [
    ["stats", renderStats],
    ["currently reading", renderCurrentlyReading],
    ["read shelf", renderReadShelf],
    ["to-read shelf", renderTbrShelf],
    ["year in review", renderYearReview],
  ];
  for (const [name, render] of sections) {
    try {
      render();
    } catch (err) {
      console.error("Render failed (" + name + "):", err);
    }
  }
}


// Time-of-day greeting, set once on load.
(function setGreeting() {
  const h = new Date().getHours();
  const word = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const el = document.getElementById("greeting-h");
  if (el) el.textContent = word + ", Jake";
})();

// ------------------------------------------------------------
// Panel 1 — Currently Reading
// ------------------------------------------------------------
function renderCurrentlyReading() {
  const container = document.getElementById("reading-content");
  const book = allBooks.find((b) => b.status === "reading");

  if (!book) {
    container.innerHTML = '<div class="reading-empty"><p>Nothing on the nightstand right now.</p></div>';
    return;
  }

  const progress = bookProgress(book);
  const pageCount = toNum(book.pageCount);
  const pagesRead = toNum(book.pagesRead);
  const velocity = readingVelocity(book);
  const blurb = book.description
    ? '<div class="reading-blurb">' + descriptionToHtml(book.description, 420, { flow: true }) + "</div>"
    : isAdmin
    ? '<p class="reading-blurb reading-blurb-empty">No description yet — open this book’s card and use "Reload from OpenLibrary" to fetch one.</p>'
    : "";

  const progressControl = isAdmin
    ? '<div class="reading-pages-controls">' +
        '<label class="pages-field">Pages read<input type="number" id="pages-read-input" min="0" step="1" value="' + (pagesRead ?? 0) + '"></label>' +
        '<span class="pages-of">of</span>' +
        '<label class="pages-field">Total pages<input type="number" id="page-count-input" min="0" step="1" value="' + (pageCount ?? "") + '" placeholder="—"></label>' +
      "</div>"
    : '<div class="reading-progress-track"><div class="reading-progress-fill" style="width:' + progress + '%"></div></div>';

  container.innerHTML =
    '<div class="hero-grid">' +
      '<div class="reading-cover-wrap" id="reading-cover-wrap" tabindex="0" role="button">' +
        '<img class="reading-cover" id="reading-cover-img" loading="lazy" decoding="async" src="' + resolveCoverUrl(book, "L") + '" alt="Cover of ' + escapeHtml(book.title) + '">' +
      "</div>" +
      '<div class="hero-info">' +
        '<p class="kicker">Reading now</p>' +
        (book.series ? '<p class="reading-series">' + escapeHtml(book.series) + (book.seriesPosition ? " · Book " + book.seriesPosition : "") + "</p>" : "") +
        '<h1 class="reading-title">' + escapeHtml(book.title) + "</h1>" +
        '<p class="reading-author">by ' + escapeHtml(book.author) + "</p>" +
        blurb +
        '<div class="reading-progress-row">' +
          progressControl +
          '<div class="reading-progress-label">' + progress + "% through" + (pageCount ? " · page " + (pagesRead ?? 0) + " of " + pageCount : "") + "</div>" +
        "</div>" +
        (velocity
          ? '<div class="reading-velocity">Pace: about <strong>' + Math.round(velocity.pagesPerDay) + " pages a day</strong> — on track to finish around " + predictedFinishLabel(book, velocity) + ".</div>"
          : "") +
        (isAdmin ? '<button class="stamp-button-ghost" id="mark-finished-btn" style="margin-top:20px;">Mark as finished</button>' : "") +
      "</div>" +
      '<div class="hero-ring" style="--pct:' + progress + '">' +
        '<div class="hero-ring-inner">' +
          '<span class="hero-ring-num">' + progress + "%</span>" +
          '<span class="hero-ring-sub">complete</span>' +
        "</div>" +
      "</div>" +
    "</div>";

  const coverWrap = document.getElementById("reading-cover-wrap");
  coverWrap.addEventListener("click", () => openBookCard(book.id));
  coverWrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openBookCard(book.id);
  });

  if (isAdmin) {
    const pagesInput = document.getElementById("pages-read-input");
    const countInput = document.getElementById("page-count-input");
    const label = container.querySelector(".reading-progress-label");
    const updateLive = () => {
      const total = parseInt(countInput.value, 10);
      const read = parseInt(pagesInput.value, 10) || 0;
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((read / total) * 100))) : 0;
      label.textContent = total > 0 ? pct + "% through · page " + read + " of " + total : read + " pages in";
      const ring = container.querySelector(".hero-ring");
      if (ring) {
        ring.style.setProperty("--pct", String(pct));
        const num = ring.querySelector(".hero-ring-num");
        if (num) num.textContent = pct + "%";
      }
    };
    pagesInput.addEventListener("input", updateLive);
    countInput.addEventListener("input", updateLive);
    countInput.addEventListener("change", () => {
      const total = parseInt(countInput.value, 10);
      updateDoc(doc(db, "books", book.id), { pageCount: Number.isFinite(total) && total > 0 ? total : null })
        .catch((err) => {
          console.error("Failed to save page count:", err);
          showToast("Couldn’t save the page count — check your connection and try again.");
        });
    });
    pagesInput.addEventListener("change", () => {
      const read = parseInt(pagesInput.value, 10);
      if (!Number.isFinite(read) || read < 0) return;
      // Every saved check-in lands in the progress log — that's what
      // feeds the reading-velocity stats.
      updateDoc(doc(db, "books", book.id), {
        pagesRead: read,
        progressLog: arrayUnion({ t: Date.now(), p: read })
      })
        .catch((err) => {
          console.error("Failed to save progress:", err);
          showToast("Couldn’t save your progress — check your connection and try again.");
        });
    });

    document.getElementById("mark-finished-btn").addEventListener("click", async () => {
      try {
        const finishUpdates = {
          status: "read",
          progressPercent: 100,
          readAt: book.readAt ?? Date.now()
        };
        if (book.predictedStars == null) {
          const pred = predictForBook(book);
          if (pred !== null) finishUpdates.predictedStars = pred;
        }
        await updateDoc(doc(db, "books", book.id), finishUpdates);
        showToast('Marked "' + book.title + '" as finished — add a rating whenever you\u2019re ready.');
        openBookCard(book.id);
      } catch (err) {
        console.error("Failed to mark book as finished:", err);
        showToast("Couldn’t update the book — check your connection and try again.");
      }
    });
  }
}

// ------------------------------------------------------------
// Panels 2 & 3 — Shelves
// ------------------------------------------------------------
function sortBooks(books, mode, seriesAvg) {
  const list = [...books];
  switch (mode) {
    case "rating-desc":
      return list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    case "match-desc":
      return list.sort((a, b) => (b._match ?? -1) - (a._match ?? -1));
    case "series-desc":
      return list.sort((a, b) => {
        const sa = a.series ? seriesAvg[a.series] ?? -1 : -1;
        const sb = b.series ? seriesAvg[b.series] ?? -1 : -1;
        if (sb !== sa) return sb - sa;
        return (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0);
      });
    case "author-asc":
      return list.sort((a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title));
    case "title-asc":
    default:
      return list.sort((a, b) => a.title.localeCompare(b.title));
  }
}

// Static (non-editable) star display for the finished-books grid.
function starsHtml(rating) {
  let html = '<span class="star-rating star-rating-static">';
  for (let i = 0; i < 5; i++) {
    const fillPct = Math.max(0, Math.min(1, rating - i)) * 100;
    html += '<span class="star">' +
      '<svg class="star-outline" viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg>' +
      '<span class="star-fill" style="--fill:' + fillPct + '%">' +
      '<svg class="star-fill-shape" viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg>' +
      "</span></span>";
  }
  return html + "</span>";
}

function renderShelf(containerId, books, badgeType) {
  const container = document.getElementById(containerId);
  if (!books.length) {
    container.innerHTML = '<p class="shelf-empty">Nothing here yet.</p>';
    return;
  }
  container.classList.toggle("shelf-grid", badgeType === "rating");
  container.classList.toggle("shelf-list", badgeType === "match");
  container.innerHTML = books
    .map((b) => {
      if (badgeType === "rating") {
        const rating = toNum(b.rating);
        const ratingHtml = rating !== null
          ? starsHtml(rating) + '<span class="rating-number">' + rating.toFixed(2).replace(/\.?0+$/, "") + "</span>"
          : '<span class="unrated">Not yet rated</span>';
        return '<div class="cover-wrap">' +
          '<div class="book-cover-card" tabindex="0" role="button" data-id="' + b.id + '"' +
          ' style="background-image:url(\'' + resolveCoverUrl(b, "M") + '\')"></div>' +
          '<div class="cover-caption">' + escapeHtml(b.title) + "</div>" +
          '<div class="cover-author">' + escapeHtml(b.author) + "</div>" +
          '<div class="cover-rating">' + ratingHtml + "</div>" +
        "</div>";
      }
      const score = toNum(b._match);
      return '<div class="tbr-row" tabindex="0" role="button" data-id="' + b.id + '">' +
        '<div class="tbr-cover" style="background-image:url(\'' + resolveCoverUrl(b, "M") + '\')"></div>' +
        '<div class="tbr-meta">' +
          '<div class="cover-caption">' + escapeHtml(b.title) + "</div>" +
          '<div class="cover-author">' + escapeHtml(b.author) + "</div>" +
        "</div>" +
        '<div class="tbr-score">' +
          '<div class="tbr-bar"><div class="tbr-bar-fill" style="width:' + (score !== null ? score * 20 : 0) + '%"></div></div>' +
          '<div class="tbr-num">' + (score !== null ? score.toFixed(1) : "–") + "</div>" +
        "</div>" +
      "</div>";
    })
    .join("");
}

function renderReadShelf() {
  const read = allBooks.filter((b) => b.status === "read");
  const avg = seriesAverages(read);
  const mode = document.getElementById("read-sort").value;
  renderShelf("read-shelf", sortBooks(read, mode, avg), "rating");
}

function renderTbrShelf() {
  const read = allBooks.filter((b) => b.status === "read" && toNum(b.rating) !== null);
  const tbr = allBooks.filter((b) => b.status === "to-read");
  const avg = seriesAverages(allBooks.filter((b) => b.status === "read"));

  // Score the whole queue at once — the calibration layer stretches
  // the scores across the full 0-5 scale relative to the queue itself.
  const scores = computeMatchScores(tbr, read);
  matchScoreById = {};
  const withScores = tbr.map((b, i) => {
    matchScoreById[b.id] = scores[i];
    return { ...b, _match: scores[i] };
  });
  const mode = document.getElementById("tbr-sort").value;
  renderShelf("tbr-shelf", sortBooks(withScores, mode, avg), "match");
}

// ------------------------------------------------------------
// Year in review — the reading year in wrap-up form: totals,
// favourites, and a report card for the taste model's predictions.
// ------------------------------------------------------------
function renderYearReview() {
  const container = document.getElementById("year-review");
  if (!container) return;
  const year = new Date().getFullYear();
  const read = allBooks.filter((b) => b.status === "read");
  const dated = read.filter((b) => {
    const t = toNum(b.readAt);
    return t !== null && new Date(t).getFullYear() === year;
  });
  const rated = dated.map((b) => toNum(b.rating)).filter((r) => r !== null);
  const avg = rated.length ? rated.reduce((a, r) => a + r, 0) / rated.length : null;
  const pages = dated.reduce((acc, b) => acc + (toNum(b.pageCount) ?? 0), 0);
  const authors = new Set(dated.map((b) => b.author)).size;
  const best = dated
    .filter((b) => toNum(b.rating) !== null)
    .sort((a, b) => toNum(a.rating) - toNum(b.rating))
    .pop();

  // Calibration: every book that carries both a snapshotted prediction
  // and a real rating grades the recommender.
  const calib = read
    .map((b) => ({ p: toNum(b.predictedStars), a: toNum(b.rating) }))
    .filter((c) => c.p !== null && c.a !== null);
  let calibCard;
  if (calib.length) {
    const mae = calib.reduce((acc, c) => acc + Math.abs(c.a - c.p), 0) / calib.length;
    const bias = calib.reduce((acc, c) => acc + (c.a - c.p), 0) / calib.length;
    const trend = bias > 0.1
      ? "The model tends to underrate you by " + bias.toFixed(2) + "★ a book."
      : bias < -0.1
      ? "The model tends to overrate you by " + Math.abs(bias).toFixed(2) + "★ a book."
      : "Well calibrated — predictions are landing close to your real ratings.";
    calibCard = '<div class="yr-card"><div class="stat-label">Prediction accuracy</div>' +
      '<div class="stat-value">' + mae.toFixed(2) + '★</div>' +
      '<div class="yr-note">average miss on ' + calib.length + " predicted book" + (calib.length === 1 ? "" : "s") + ". " + trend + "</div></div>";
  } else {
    calibCard = '<div class="yr-card"><div class="stat-label">Prediction accuracy</div>' +
      '<div class="stat-value">–</div>' +
      '<div class="yr-note">The taste model snapshots its predicted rating whenever you start or rate a book — its report card shows up here once you’ve rated a couple.</div></div>';
  }

  const card = (label, value) =>
    '<div class="yr-card"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + "</div></div>";

  container.innerHTML =
    '<div class="shelf-head"><h2 class="shelf-title">' + year + " in review</h2></div>" +
    '<div class="yr-grid">' +
      card("Books finished", String(dated.length)) +
      card("Pages read", pages ? pages.toLocaleString() : "–") +
      card("Average rating", avg !== null ? avg.toFixed(2).replace(/\.?0+$/, "") + "★" : "–") +
      card("Authors", String(authors)) +
      calibCard +
    "</div>" +
    (best
      ? '<div class="yr-best">Book of the year so far: <strong>' + escapeHtml(best.title) + "</strong> by " + escapeHtml(best.author) + " — " + toNum(best.rating).toFixed(2).replace(/\.?0+$/, "") + "★</div>"
      : "") +
    (read.length && !dated.length
      ? '<div class="yr-hint">None of your finished books have a finish date for ' + year + " yet. Dates are captured automatically when you mark a book finished — or re-import your GoodReads export, which now backfills dates onto books already in the library.</div>"
      : "") +
    (!read.length
      ? '<div class="yr-hint">Finish a book and this panel fills up with your year: books, pages, ratings, and how well the taste model predicted you.</div>'
      : "");
}

document.getElementById("read-sort").addEventListener("change", renderReadShelf);
document.getElementById("tbr-sort").addEventListener("change", renderTbrShelf);

// Event delegation: one listener per shelf container instead of one per
// book, so re-renders (every Firestore snapshot) don't churn listeners.
for (const shelfId of ["read-shelf", "tbr-shelf"]) {
  const shelf = document.getElementById(shelfId);
  shelf.addEventListener("click", (e) => {
    const el = e.target.closest("[data-id]");
    if (el) openBookCard(el.dataset.id);
  });
  shelf.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest("[data-id]");
    if (el) {
      e.preventDefault();
      openBookCard(el.dataset.id);
    }
  });
}

// ------------------------------------------------------------
// Book detail card
// ------------------------------------------------------------
const card = document.getElementById("book-card");

function openBookCard(id) {
  const book = allBooks.find((b) => b.id === id);
  if (!book) return;

  document.getElementById("bc-cover").src = resolveCoverUrl(book, "L");
  document.getElementById("bc-cover").alt = `Cover of ${book.title}`;
  document.getElementById("bc-series").textContent = book.series
    ? `${book.series}${book.seriesPosition ? " · Book " + book.seriesPosition : ""}`
    : "";
  document.getElementById("bc-title").textContent = book.title;
  document.getElementById("bc-author").textContent = `by ${book.author}`;
  const tags = Array.isArray(book.tags) ? book.tags : [];
  document.getElementById("bc-tags").innerHTML = tags
    .slice(0, 6)
    .map((t) => `<span class="bc-tag">${escapeHtml(t)}</span>`)
    .join("");

  // Page count: shown to everyone once known — the lazy lookup, CSV
  // import and the drawer's backfill fill it in automatically.
  const pagesWrap = document.getElementById("bc-pages-wrap");
  const totalPages = toNum(book.pageCount);
  pagesWrap.innerHTML = totalPages !== null ? '<span class="bc-pages-num">' + totalPages.toLocaleString() + " pages</span>" : "";

  const ratingWrap = document.getElementById("bc-rating-wrap");
  if (book.status === "to-read") {
    const readRated = allBooks.filter((b) => b.status === "read" && toNum(b.rating) !== null);
    // The same calibrated number the shelf shows; the absolute mapping
    // is only a fallback for books the shelf hasn't scored.
    const score = toNum(matchScoreById[book.id]) ?? computeMatchScore(book, readRated);
    // No axis ratings for unread books — hide the disclosure entirely.
    document.getElementById("bc-axes-wrap").hidden = true;
    ratingWrap.innerHTML = `<div class="bc-match-score">${score.toFixed(1)}<span style="font-size:1rem;color:var(--paper-dim)">/5</span></div><div class="bc-match-label">predicted match to your taste</div>`;
  } else {
    ratingWrap.innerHTML = "";
    const rating = toNum(book.rating) ?? 0;
    renderStarRating(ratingWrap, rating, isAdmin, (newRating) => {
      const updates = { rating: newRating };
      // Freeze the model's prediction alongside the first real rating,
      // so the Year in Review can grade the recommender later.
      if (book.predictedStars == null) {
        const pred = predictForBook(book);
        if (pred !== null) updates.predictedStars = pred;
      }
      updateDoc(doc(db, "books", book.id), updates)
        .catch((err) => {
          console.error("Failed to save rating:", err);
          showToast("Couldn’t save that rating — check your connection and try again.");
        });
    });

    // Calibration readout: how did the prediction do against reality?
    const predicted = toNum(book.predictedStars);
    if (predicted !== null && rating > 0) {
      const diff = rating - predicted;
      const verdict = Math.abs(diff) < 0.25
        ? "nailed it"
        : diff > 0 ? "you liked it more than predicted" : "you liked it less than predicted";
      const calibEl = document.createElement("p");
      calibEl.className = "bc-calibration";
      calibEl.textContent = "Predicted " + predicted.toFixed(1) + "★ → rated " + rating.toFixed(2).replace(/\.?0+$/, "") + "★ — " + verdict;
      ratingWrap.appendChild(calibEl);
    }

    // Multi-axis ratings: plot, characters, prose, pacing, world.
    const axesWrap = document.getElementById("bc-axes-wrap");
    axesWrap.hidden = false;
    const axesBody = document.getElementById("bc-axes-body");
    axesBody.innerHTML = "";
    for (const [key, label] of AXES) {
      const row = document.createElement("div");
      row.className = "bc-axis-row";
      const name = document.createElement("span");
      name.className = "bc-axis-name";
      name.textContent = label;
      row.appendChild(name);
      const axisVal = toNum(book.axes?.[key]) ?? 0;
      // renderStarRating clears its container before appending, so the
      // stars get their own wrapper — the axis label beside them
      // survives every re-render.
      const starsEl = document.createElement("span");
      starsEl.className = "bc-axis-stars";
      row.appendChild(starsEl);
      renderStarRating(starsEl, axisVal, isAdmin, (newVal) => {
        updateDoc(doc(db, "books", book.id), { ["axes." + key]: newVal })
          .catch((err) => {
            console.error("Failed to save axis rating:", err);
            showToast("Couldn’t save that rating — check your connection and try again.");
          });
      });
      axesBody.appendChild(row);
    }

    // Finish date: shown to everyone once set, editable by the
    // librarian — this is how previously-read books get backfilled
    // with their real dates (the Year in Review reads it).
    const finishedWrap = document.getElementById("bc-finished-wrap");
    finishedWrap.innerHTML = "";
    const finishedAt = toNum(book.readAt);
    if (isAdmin && (book.status === "read" || finishedAt !== null)) {
      const fRow = document.createElement("div");
      fRow.className = "bc-finished-row";
      const fName = document.createElement("span");
      fName.className = "bc-axis-name";
      fName.textContent = "Finished on";
      fRow.appendChild(fName);
      const fInput = document.createElement("input");
      fInput.type = "date";
      fInput.className = "bc-finished-input";
      fInput.title = "Set the date you finished this book";
      if (finishedAt !== null) {
        const d = new Date(finishedAt);
        fInput.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      }
      fInput.addEventListener("change", () => {
        if (fInput.value) {
          const t = new Date(fInput.value + "T00:00:00").getTime();
          if (Number.isFinite(t)) {
            updateDoc(doc(db, "books", book.id), { readAt: t })
              .catch((err) => {
                console.error("Failed to save finish date:", err);
                showToast("Couldn’t save the finish date — check your connection and try again.");
              });
          }
        } else {
          // Cleared: forget the stored date (re-reads and mistakes happen).
          updateDoc(doc(db, "books", book.id), { readAt: null })
            .catch((err) => {
              console.error("Failed to clear finish date:", err);
              showToast("Couldn’t clear the finish date — check your connection and try again.");
            });
        }
      });
      fRow.appendChild(fInput);
      finishedWrap.appendChild(fRow);
    } else if (finishedAt !== null) {
      const fLabel = document.createElement("p");
      fLabel.className = "bc-finished-label";
      fLabel.textContent = "Finished on " + new Date(finishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + ".";
      finishedWrap.appendChild(fLabel);
    }
  }

  const adminActions = document.getElementById("bc-admin-actions");
  if (isAdmin) {
    adminActions.hidden = false;
    adminActions.innerHTML = `
      <label style="display:block;margin-top:14px;font-size:.78rem;color:var(--paper-dim)">
        Status
        <select id="bc-status-select" style="display:block;margin-top:4px;background:var(--ink);color:var(--paper);border:1px solid var(--brass);padding:6px;border-radius:2px;">
          <option value="to-read" ${book.status === "to-read" ? "selected" : ""}>To read</option>
          <option value="reading" ${book.status === "reading" ? "selected" : ""}>Currently reading</option>
          <option value="read" ${book.status === "read" ? "selected" : ""}>Read</option>
        </select>
      </label>
      <div style="margin-top:16px;">
        <label style="display:block;font-size:.78rem;color:var(--paper-dim);margin-bottom:4px;">Reload from OpenLibrary (work or edition ID)</label>
        <input id="bc-olid-input" placeholder="Work ID e.g. OL45804W, or edition ID e.g. OL7353617M"
               value="${book.workKey ? book.workKey.replace("/works/", "") : ""}"
               style="width:100%;margin-bottom:6px;padding:7px;background:var(--ink);color:var(--paper);border:1px solid var(--brass);border-radius:2px;">
        <button class="stamp-button stamp-button-ghost" id="bc-refresh-olid">Reload cover, title, author & tags</button>
        <p id="bc-refresh-status" style="font-size:.75rem;color:var(--paper-dim);margin-top:6px;min-height:1em;"></p>
      </div>
      <div style="margin-top:16px;">
        <label style="display:block;font-size:.78rem;color:var(--paper-dim);margin-bottom:4px;">Reload from Google Books (ID or URL — leave blank to search by title/author)</label>
        <input id="bc-gbooks-input" placeholder="e.g. zyTCAlFPjgYC, or paste a books.google.com link"
               style="width:100%;margin-bottom:6px;padding:7px;background:var(--ink);color:var(--paper);border:1px solid var(--brass);border-radius:2px;">
        <button class="stamp-button stamp-button-ghost" id="bc-refresh-gbooks">Reload tags & description</button>
        <p id="bc-gbooks-status" style="font-size:.75rem;color:var(--paper-dim);margin-top:6px;min-height:1em;"></p>
      </div>
      <button class="stamp-button stamp-button-ghost" id="bc-delete" style="margin-top:12px;">Remove from library</button>
    `;
    document.getElementById("bc-status-select").addEventListener("change", (e) => {
      const updates = { status: e.target.value };
      if (e.target.value === "read") updates.readAt = book.readAt ?? Date.now();
      // Freeze the model's prediction the moment a book goes live.
      if ((e.target.value === "reading" || e.target.value === "read") && book.predictedStars == null) {
        const pred = predictForBook(book);
        if (pred !== null) updates.predictedStars = pred;
      }
      updateDoc(doc(db, "books", book.id), updates).catch((err) => {
        console.error("Failed to change status:", err);
        showToast("Couldn’t change the status — check your connection and try again.");
      });
    });
    document.getElementById("bc-refresh-olid").addEventListener("click", async () => {
      const rawId = document.getElementById("bc-olid-input").value.trim();
      const statusEl = document.getElementById("bc-refresh-status");
      if (!rawId) {
        statusEl.textContent = "Enter an OpenLibrary ID first.";
        return;
      }
      statusEl.textContent = "Fetching…";
      try {
        const data = await fetchWorkById(rawId);
        const updates = { workKey: data.workKey };
        if (data.title) updates.title = data.title;
        if (data.author) updates.author = data.author;
        if (data.coverId) updates.coverId = data.coverId;
        if (data.subjects.length) updates.tags = data.subjects.slice(0, 8);
        if (data.description) updates.description = data.description;
        await updateDoc(doc(db, "books", book.id), updates);
        statusEl.textContent = "Updated.";
        showToast(`Refreshed "${data.title || book.title}" from OpenLibrary.`);
        openBookCard(book.id); // re-render the card with the new data
      } catch (err) {
        statusEl.textContent = "Couldn't find that OpenLibrary ID — double-check it and try again.";
      }
    });
    document.getElementById("bc-refresh-gbooks").addEventListener("click", async () => {
      const rawId = document.getElementById("bc-gbooks-input").value.trim();
      const statusEl = document.getElementById("bc-gbooks-status");
      statusEl.textContent = "Fetching…";
      try {
        const gbook = rawId
          ? await fetchGoogleBookById(rawId)
          : await searchGoogleBooks(book.title, book.author);

        if (!gbook) {
          statusEl.textContent = "No match found on Google Books for this title/author.";
          return;
        }

        // An explicit reload overwrites the description (unlike the passive
        // backfill, which only fills gaps) — this is a deliberate user action.
        const updates = {};
        if (gbook.categories?.length) updates.tags = mergeTags(book.tags || [], gbook.categories);
        if (gbook.description) updates.description = gbook.description;
        if (gbook.coverUrl && !book.coverId) updates.googleCoverUrl = gbook.coverUrl;
        if (gbook.pageCount && !book.pageCount) updates.pageCount = gbook.pageCount;

        if (!Object.keys(updates).length) {
          statusEl.textContent = "Found a match, but it had nothing new to add.";
          return;
        }

        await updateDoc(doc(db, "books", book.id), updates);
        statusEl.textContent = "Updated.";
        showToast(`Refreshed "${book.title}" from Google Books.`);
        openBookCard(book.id);
      } catch (err) {
        statusEl.textContent = `Couldn't fetch that: ${err.message}`;
      }
    });
    document.getElementById("bc-delete").addEventListener("click", () => {
      if (confirm(`Remove "${book.title}" from your library?`)) {
        deleteDoc(doc(db, "books", book.id));
        closeBookCard();
      }
    });
  } else {
    adminActions.hidden = true;
    adminActions.innerHTML = "";
  }

  card.hidden = false;
}

function closeBookCard() {
  card.hidden = true;
}
document.getElementById("book-card-close").addEventListener("click", closeBookCard);

// Quarter-star rating widget
const STAR_PATH = "M12 2.5l2.95 6.02 6.64.97-4.8 4.68 1.13 6.61L12 17.6l-5.92 3.18 1.13-6.61-4.8-4.68 6.64-.97z";

function renderStarRating(container, rating, editable, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "star-rating";
  for (let i = 0; i < 5; i++) {
    const fillPct = Math.max(0, Math.min(1, rating - i)) * 100;
    const star = document.createElement("span");
    star.className = "star";
    star.innerHTML = `
      <svg class="star-outline" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
      <span class="star-fill" style="--fill:${fillPct}%">
        <svg class="star-fill-shape" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
      </span>`;
    if (editable) {
      star.style.cursor = "pointer";
      star.addEventListener("click", (e) => {
        const rect = star.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        const quarter = Math.max(0.25, Math.ceil(frac * 4) / 4);
        const newRating = Math.round((i + quarter) * 4) / 4;
        onChange(Math.min(newRating, 5));
        renderStarRating(container, Math.min(newRating, 5), editable, onChange);
      });
    }
    wrap.appendChild(star);
  }
  const label = document.createElement("span");
  label.className = "rating-number";
  label.textContent = rating ? rating.toFixed(2).replace(/\.?0+$/, "") : "Not yet rated";
  wrap.appendChild(label);
  container.innerHTML = "";
  container.appendChild(wrap);
}

// ------------------------------------------------------------
// Tab navigation — Finished / To read
// ------------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanes = document.querySelectorAll(".tab-pane");

let activeTab = "shelf";

function activateTab(name) {
  activeTab = name;
  tabButtons.forEach((b) => {
    const isActive = b.dataset.tab === name;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-selected", String(isActive));
  });
  tabPanes.forEach((p) => {
    const isActive = p.dataset.pane === name;
    p.classList.toggle("is-active", isActive);
    p.hidden = !isActive;
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Arrow-key support for the tab list, per the WAI-ARIA tabs pattern.
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const names = [...tabButtons].map((b) => b.dataset.tab);
  const dir = e.key === "ArrowRight" ? 1 : -1;
  const next = names[(names.indexOf(activeTab) + dir + names.length) % names.length];
  activateTab(next);
  tabButtons[names.indexOf(next)].focus();
});

// Apply the initial tab state (matches the markup's starting classes).
activateTab("shelf");
// ------------------------------------------------------------
// Admin: sign-in
// ------------------------------------------------------------
const signinPanel = document.getElementById("signin-panel");
const adminDrawer = document.getElementById("admin-drawer");
const adminToggle = document.getElementById("admin-toggle");

adminToggle.addEventListener("click", () => {
  if (isAdmin) {
    signOut(auth);
  } else {
    signinPanel.hidden = false;
  }
});
document.getElementById("signin-close").addEventListener("click", () => (signinPanel.hidden = true));

document.getElementById("signin-submit").addEventListener("click", async () => {
  const email = document.getElementById("signin-email").value.trim();
  const password = document.getElementById("signin-password").value;
  const errorEl = document.getElementById("signin-error");
  errorEl.textContent = "";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    signinPanel.hidden = true;
  } catch (err) {
    errorEl.textContent = "Couldn't sign in — check your email and password.";
  }
});

onAuthStateChanged(auth, (user) => {
  isAdmin = !!user;
  adminToggle.textContent = isAdmin ? "Sign out" : "Librarian sign-in";
  adminDrawer.hidden = !isAdmin;
  renderAll();
});

document.getElementById("admin-drawer-tab").addEventListener("click", () => {
  adminDrawer.classList.toggle("is-open");
});

// ------------------------------------------------------------
// Admin: add a book via OpenLibrary search
// ------------------------------------------------------------
document.getElementById("add-search").addEventListener("click", async () => {
  const title = document.getElementById("add-title").value.trim();
  const author = document.getElementById("add-author").value.trim();
  const resultsEl = document.getElementById("add-results");
  if (!title) return;
  resultsEl.textContent = "Searching…";
  try {
    const results = await searchBooks(title, author, 5);
    if (!results.length) {
      resultsEl.textContent = "No matches found.";
      return;
    }
    resultsEl.innerHTML = results
      .map(
        (r, i) => `
        <div class="add-result-item">
          <span>${escapeHtml(r.title)} — ${escapeHtml(r.author)}</span>
          <span>
            <select id="add-status-${i}">
              <option value="to-read">To read</option>
              <option value="reading">Reading</option>
              <option value="read">Read</option>
            </select>
            <button data-idx="${i}" class="stamp-button-ghost">Add</button>
          </span>
        </div>`
      )
      .join("");

    resultsEl.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = results[parseInt(btn.dataset.idx, 10)];
        const status = document.getElementById(`add-status-${btn.dataset.idx}`).value;
        let tags = r.subjects || [];
        let description = null;
        let googleCoverUrl = null;
        if (r.workKey) {
          const details = await getWorkDetails(r.workKey);
          if (details?.subjects?.length) tags = details.subjects.slice(0, 8);
          if (details?.description) description = details.description;
        }
        let gbook = null;
        try {
          gbook = await searchGoogleBooks(r.title, r.author);
          if (gbook) {
            tags = mergeTags(tags, gbook.categories);
            if (!description && gbook.description) description = gbook.description;
            if (!r.coverId && gbook.coverUrl) googleCoverUrl = gbook.coverUrl;
          }
        } catch {
          /* non-fatal — book still gets added with OpenLibrary data alone */
        }
        try {
          await addDoc(collection(db, "books"), {
            title: r.title,
            author: r.author,
            series: r.series || null,
            seriesPosition: null,
            status,
            rating: null,
            tags,
            description,
            coverId: r.coverId,
            googleCoverUrl,
            pageCount: gbook?.pageCount ?? null,
            workKey: r.workKey,
            source: "manual",
            createdAt: serverTimestamp()
          });
          showToast(`Added "${r.title}" to your library.`);
        } catch (err) {
          console.error("Failed to add book:", err);
          showToast("Couldn’t add that book — check your connection and try again.");
        }
      });
    });
  } catch {
    resultsEl.textContent = "Search failed — try again.";
  }
});

// ------------------------------------------------------------
// Admin: CSV import
// ------------------------------------------------------------
document.getElementById("csv-import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("csv-file");
  const statusEl = document.getElementById("csv-status");
  if (!fileInput.files.length) {
    statusEl.textContent = "Choose a GoodReads export CSV first.";
    return;
  }
  try {
    const result = await importGoodreadsCSV(
      fileInput.files[0],
      (msg) => {
        statusEl.textContent = msg;
      },
      allBooks
    );
    statusEl.textContent = `Done — imported ${result.imported}, refreshed ${result.refreshed}, skipped ${result.skipped} of ${result.total} rows.`;
  } catch (err) {
    statusEl.textContent = "Import failed: " + err.message;
  }
});

// ------------------------------------------------------------
// Admin: backfill Google Books data onto books already in the library
// ------------------------------------------------------------
document.getElementById("backfill-btn").addEventListener("click", async (e) => {
  const statusEl = document.getElementById("backfill-status");
  const btn = e.currentTarget;
  btn.disabled = true;

  const forceRecheck = document.getElementById("backfill-force").checked;
  const targets = allBooks.filter((b) => forceRecheck || !b.googleEnriched);
  if (!targets.length) {
    statusEl.textContent = "Everything's already been cross-referenced.";
    btn.disabled = false;
    return;
  }

  let enriched = 0;
  let firstError = null;
  for (const [i, book] of targets.entries()) {
    statusEl.textContent = `(${i + 1}/${targets.length}) Checking "${book.title}"…`;
    const updates = {};
    try {
      const gbook = await searchGoogleBooks(book.title, book.author);
      updates.googleEnriched = true; // only mark as checked when the request actually succeeded
      if (gbook) {
        if (gbook.categories?.length) updates.tags = mergeTags(book.tags || [], gbook.categories);
        if (!book.description && gbook.description) updates.description = gbook.description;
        if (!book.coverId && !book.googleCoverUrl && gbook.coverUrl) updates.googleCoverUrl = gbook.coverUrl;
        if (!book.pageCount && gbook.pageCount) updates.pageCount = gbook.pageCount;
        enriched++;
      }
    } catch (err) {
      if (!firstError) firstError = err.message;
      // leave googleEnriched unset so this book gets retried next run
    }
    if (Object.keys(updates).length) {
      try {
        await updateDoc(doc(db, "books", book.id), updates);
      } catch (err) {
        if (!firstError) firstError = err.message;
      }
    }
    await new Promise((r) => setTimeout(r, 150)); // be polite to the free API
  }

  statusEl.textContent = firstError
    ? `Done, but requests were failing — found data for ${enriched} of ${targets.length}. First error: ${firstError}`
    : `Done — found new data for ${enriched} of ${targets.length} books checked.`;
  btn.disabled = false;
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
