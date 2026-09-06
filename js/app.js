import { db, auth } from "./firebase-config.js";
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { searchBooks, coverUrl } from "./openlibrary.js";
import { computeMatchScore } from "./taste-match.js";
import { importGoodreadsCSV } from "./csv-import.js";

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let allBooks = [];
let isAdmin = false;
let currentPanel = 0;
const PANEL_COUNT = 3;

const SPINE_PALETTE = ["#7C8C80", "#A23E48", "#B8925A", "#3E5C50", "#6B4A3A", "#8A6C86"];

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return SPINE_PALETTE[Math.abs(hash) % SPINE_PALETTE.length];
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
    if (!b.series || b.rating == null) continue;
    (bySeriesRating[b.series] ||= []).push(b.rating);
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
onSnapshot(collection(db, "books"), (snap) => {
  allBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderAll();
});

function renderAll() {
  renderCurrentlyReading();
  renderReadShelf();
  renderTbrShelf();
}

// ------------------------------------------------------------
// Panel 1 — Currently Reading
// ------------------------------------------------------------
function renderCurrentlyReading() {
  const container = document.getElementById("reading-content");
  const book = allBooks.find((b) => b.status === "reading");

  if (!book) {
    container.innerHTML = `<div class="reading-empty"><p>Nothing on the nightstand right now.</p></div>`;
    return;
  }

  const progress = book.progressPercent ?? null;

  container.innerHTML = `
    <img class="reading-cover" src="${coverUrl(book.coverId, "L")}" alt="Cover of ${escapeHtml(book.title)}">
    ${book.series ? `<p class="reading-series">${escapeHtml(book.series)}${book.seriesPosition ? " · Book " + book.seriesPosition : ""}</p>` : ""}
    <h1 class="reading-title">${escapeHtml(book.title)}</h1>
    <p class="reading-author">by ${escapeHtml(book.author)}</p>
    ${
      progress !== null
        ? `<div class="reading-progress-row">
             <div class="reading-progress-track"><div class="reading-progress-fill" style="width:${progress}%"></div></div>
             <div class="reading-progress-label">${progress}% through</div>
           </div>`
        : ""
    }
  `;
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

function renderShelf(containerId, books, badgeType) {
  const container = document.getElementById(containerId);
  if (!books.length) {
    container.innerHTML = `<p class="shelf-empty">Nothing here yet.</p>`;
    return;
  }
  container.innerHTML = books
    .map((b) => {
      const badge =
        badgeType === "rating"
          ? b.rating != null
            ? `<div class="spine-badge badge-rating">${b.rating}</div>`
            : ""
          : `<div class="spine-badge badge-match">${b._match?.toFixed(1) ?? "–"}</div>`;
      return `
        <div class="book-spine" tabindex="0" role="button" data-id="${b.id}"
             style="background: linear-gradient(160deg, ${hashColor(b.title)}, ${hashColor(b.title)}dd);">
          ${badge}
          <span class="spine-title">${escapeHtml(b.title)}</span>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".book-spine").forEach((el) => {
    el.addEventListener("click", () => openBookCard(el.dataset.id));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openBookCard(el.dataset.id);
    });
  });
}

function renderReadShelf() {
  const read = allBooks.filter((b) => b.status === "read");
  const avg = seriesAverages(read);
  const mode = document.getElementById("read-sort").value;
  renderShelf("read-shelf", sortBooks(read, mode, avg), "rating");
}

function renderTbrShelf() {
  const read = allBooks.filter((b) => b.status === "read" && b.rating != null);
  const tbr = allBooks.filter((b) => b.status === "to-read");
  const avg = seriesAverages(allBooks.filter((b) => b.status === "read"));

  const withScores = tbr.map((b) => ({ ...b, _match: computeMatchScore(b, read) }));
  const mode = document.getElementById("tbr-sort").value;
  renderShelf("tbr-shelf", sortBooks(withScores, mode, avg), "match");
}

document.getElementById("read-sort").addEventListener("change", renderReadShelf);
document.getElementById("tbr-sort").addEventListener("change", renderTbrShelf);

// ------------------------------------------------------------
// Book detail card
// ------------------------------------------------------------
const card = document.getElementById("book-card");

function openBookCard(id) {
  const book = allBooks.find((b) => b.id === id);
  if (!book) return;

  document.getElementById("bc-cover").src = coverUrl(book.coverId, "L");
  document.getElementById("bc-cover").alt = `Cover of ${book.title}`;
  document.getElementById("bc-series").textContent = book.series
    ? `${book.series}${book.seriesPosition ? " · Book " + book.seriesPosition : ""}`
    : "";
  document.getElementById("bc-title").textContent = book.title;
  document.getElementById("bc-author").textContent = `by ${book.author}`;
  document.getElementById("bc-tags").innerHTML = (book.tags || [])
    .slice(0, 6)
    .map((t) => `<span class="bc-tag">${escapeHtml(t)}</span>`)
    .join("");

  const ratingWrap = document.getElementById("bc-rating-wrap");
  if (book.status === "to-read") {
    const score = computeMatchScore(
      book,
      allBooks.filter((b) => b.status === "read" && b.rating != null)
    );
    ratingWrap.innerHTML = `<div class="bc-match-score">${score.toFixed(1)}<span style="font-size:1rem;color:var(--paper-dim)">/10</span></div><div class="bc-match-label">match to your taste</div>`;
  } else {
    ratingWrap.innerHTML = "";
    renderStarRating(ratingWrap, book.rating || 0, isAdmin, (newRating) => {
      updateDoc(doc(db, "books", book.id), { rating: newRating });
    });
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
      <button class="stamp-button stamp-button-ghost" id="bc-delete" style="margin-top:12px;">Remove from library</button>
    `;
    document.getElementById("bc-status-select").addEventListener("change", (e) => {
      updateDoc(doc(db, "books", book.id), { status: e.target.value });
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
// Swipe / panel navigation
// ------------------------------------------------------------
const track = document.getElementById("track");
const dots = document.querySelectorAll(".nav-dot");

function goToPanel(index) {
  currentPanel = Math.max(0, Math.min(PANEL_COUNT - 1, index));
  track.style.transform = `translateX(-${currentPanel * 100}vw)`;
  dots.forEach((d, i) => d.classList.toggle("is-active", i === currentPanel));
}

document.getElementById("nav-prev").addEventListener("click", () => goToPanel(currentPanel - 1));
document.getElementById("nav-next").addEventListener("click", () => goToPanel(currentPanel + 1));
dots.forEach((d) => d.addEventListener("click", () => goToPanel(parseInt(d.dataset.goto, 10))));

document.addEventListener("keydown", (e) => {
  if (card && !card.hidden) return;
  if (e.key === "ArrowLeft") goToPanel(currentPanel - 1);
  if (e.key === "ArrowRight") goToPanel(currentPanel + 1);
});

// Touch swipe
let touchStartX = null;
let touchStartY = null;
track.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

track.addEventListener("touchend", (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    goToPanel(currentPanel + (dx < 0 ? 1 : -1));
  }
  touchStartX = null;
}, { passive: true });

// Trackpad horizontal wheel
let wheelLock = false;
track.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return; // let vertical scroll happen inside a panel
  if (wheelLock) return;
  if (Math.abs(e.deltaX) > 30) {
    wheelLock = true;
    goToPanel(currentPanel + (e.deltaX > 0 ? 1 : -1));
    setTimeout(() => (wheelLock = false), 500);
  }
}, { passive: true });

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
        await addDoc(collection(db, "books"), {
          title: r.title,
          author: r.author,
          series: r.series || null,
          seriesPosition: null,
          status,
          rating: null,
          tags: r.subjects || [],
          coverId: r.coverId,
          workKey: r.workKey,
          source: "manual",
          createdAt: serverTimestamp()
        });
        showToast(`Added "${r.title}" to your library.`);
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
    const result = await importGoodreadsCSV(fileInput.files[0], (msg) => {
      statusEl.textContent = msg;
    });
    statusEl.textContent = `Done — imported ${result.imported} of ${result.total} rows (${result.skipped} skipped).`;
  } catch (err) {
    statusEl.textContent = "Import failed: " + err.message;
  }
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}