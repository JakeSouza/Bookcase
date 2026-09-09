import { db, auth } from "./firebase-config.js";
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { searchBooks, coverUrl, fetchWorkById, getWorkDetails } from "./openlibrary.js";
import { searchGoogleBooks, fetchGoogleBookById } from "./googlebooks.js";
import { mergeTags } from "./tag-utils.js";
import { computeMatchScore } from "./taste-match.js";
import { importGoodreadsCSV } from "./csv-import.js";

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let allBooks = [];
let isAdmin = false;
let currentPanel = 0;
const PANEL_COUNT = 3;

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
// Deterministic "spine stripe" color per book, echoing a publisher's
// genre-coded imprint colors — same book always gets the same stripe.
const STRIPE_COLORS = ["#2E8177", "#E8A93B", "#8A8D94"];
function stripeColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return STRIPE_COLORS[Math.abs(hash) % STRIPE_COLORS.length];
}

// A book's cover: OpenLibrary's cover if we have one, otherwise fall back
// to a Google Books cover image gathered during import/backfill, otherwise
// the generic placeholder.
function resolveCoverUrl(book, size = "M") {
  if (book.coverId) return coverUrl(book.coverId, size);
  if (book.googleCoverUrl) return book.googleCoverUrl;
  return coverUrl(null, size);
}

// Cursor-tilt parallax + light-sheen sweep. Applies a 3D tilt toward the
// cursor and a moving highlight, like light catching a glossy dust jacket.
function attachTiltEffect(el, { maxTilt = 8, lift = 6, scaleAmount = 1.02 } = {}) {
  el.classList.add("tilt-target");
  el.addEventListener("mousemove", (e) => {
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const tiltX = (py - 0.5) * -maxTilt;
    const tiltY = (px - 0.5) * maxTilt;
    el.style.transform = `perspective(700px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateY(-${lift}px) scale(${scaleAmount})`;
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
  });
  el.addEventListener("mouseenter", () => el.classList.add("is-hovering"));
  el.addEventListener("mouseleave", () => {
    el.classList.remove("is-hovering");
    el.style.transform = "";
  });
}

function truncate(str, max) {
  if (!str) return "";
  const clean = str.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
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

  const progress = book.progressPercent ?? 0;
  const blurb = book.description
    ? `<p class="reading-blurb">${escapeHtml(truncate(book.description, 420))}</p>`
    : isAdmin
    ? `<p class="reading-blurb reading-blurb-empty">No description yet — open this book's card and use "Reload from OpenLibrary" to fetch one.</p>`
    : "";

  const progressControl = isAdmin
    ? `<input type="range" id="progress-slider" class="reading-progress-slider" min="0" max="100" value="${progress}"
         style="--progress:${progress}%">`
    : `<div class="reading-progress-track"><div class="reading-progress-fill" style="width:${progress}%"></div></div>`;

  container.innerHTML = `
    <p class="kicker">Currently reading</p>
    <div class="reading-cover-wrap" id="reading-cover-wrap" tabindex="0" role="button">
      <img class="reading-cover" id="reading-cover-img"
           src="${resolveCoverUrl(book, "L")}" alt="Cover of ${escapeHtml(book.title)}">
    </div>
    ${book.series ? `<p class="reading-series">${escapeHtml(book.series)}${book.seriesPosition ? " · Book " + book.seriesPosition : ""}</p>` : ""}
    <h1 class="reading-title">${escapeHtml(book.title)}</h1>
    <p class="reading-author">by ${escapeHtml(book.author)}</p>
    ${blurb}
    <div class="reading-progress-row">
      ${progressControl}
      <div class="reading-progress-label">${progress}% through</div>
    </div>
    ${isAdmin ? `<button class="stamp-button-ghost" id="mark-finished-btn" style="margin-top:20px;">Mark as finished</button>` : ""}
  `;

  const coverWrap = document.getElementById("reading-cover-wrap");
  coverWrap.addEventListener("click", () => openBookCard(book.id));
  coverWrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openBookCard(book.id);
  });
  attachTiltEffect(coverWrap, { maxTilt: 6, lift: 4, scaleAmount: 1.015 });

  if (isAdmin) {
    const slider = document.getElementById("progress-slider");
    const label = container.querySelector(".reading-progress-label");
    slider.addEventListener("input", () => {
      label.textContent = `${slider.value}% through`;
      slider.style.setProperty("--progress", `${slider.value}%`);
    });
    slider.addEventListener("change", () => {
      updateDoc(doc(db, "books", book.id), { progressPercent: parseInt(slider.value, 10) });
    });

    document.getElementById("mark-finished-btn").addEventListener("click", async () => {
      await updateDoc(doc(db, "books", book.id), { status: "read", progressPercent: 100 });
      showToast(`Marked "${book.title}" as finished — add a rating whenever you're ready.`);
      openBookCard(book.id);
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
        <div class="cover-wrap">
          <div class="book-cover-card" tabindex="0" role="button" data-id="${b.id}"
               style="background-image:url('${resolveCoverUrl(b, "M")}'); border-left-color:${stripeColor(b.title)};">
            ${badge}
          </div>
          <div class="cover-caption">${escapeHtml(b.title)}</div>
          <div class="cover-author">${escapeHtml(b.author)}</div>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".book-cover-card").forEach((el) => {
    el.addEventListener("click", () => openBookCard(el.dataset.id));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openBookCard(el.dataset.id);
    });
    attachTiltEffect(el);
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

  document.getElementById("bc-cover").src = resolveCoverUrl(book, "L");
  document.getElementById("bc-cover").alt = `Cover of ${book.title}`;
  document.getElementById("bc-spine").style.background = stripeColor(book.title);
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
      updateDoc(doc(db, "books", book.id), { status: e.target.value });
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
// Swipe / panel navigation
// ------------------------------------------------------------
const track = document.getElementById("track");
const panels = document.querySelectorAll(".panel");
const dots = document.querySelectorAll(".nav-dot");
const ribbonMarker = document.getElementById("ribbon-marker");

function goToPanel(index) {
  const newPanel = Math.max(0, Math.min(PANEL_COUNT - 1, index));
  if (newPanel === currentPanel) return;

  const outgoingPanel = document.querySelector(`.panel[data-panel="${currentPanel}"]`);
  const incomingPanel = document.querySelector(`.panel[data-panel="${newPanel}"]`);
  const direction = newPanel > currentPanel ? "forward" : "backward";
  const delta = direction === "forward" ? -180 : 180; // both panels rotate the same way, like one physical page

  // Snap every uninvolved panel to its canonical hidden angle instantly —
  // harmless since it's invisible either way, and keeps the bookkeeping
  // simple no matter how many flips have happened before this one.
  panels.forEach((p) => {
    if (p !== outgoingPanel && p !== incomingPanel) {
      p.style.transition = "none";
      p.style.transform = "rotateY(180deg)";
    }
  });

  // Snap the two panels involved to a canonical starting angle (no
  // animation), then immediately animate to the real target — this is
  // what makes every flip look identical regardless of prior state.
  outgoingPanel.style.transition = "none";
  outgoingPanel.style.transform = "rotateY(0deg)";
  incomingPanel.style.transition = "none";
  incomingPanel.style.transform = "rotateY(180deg)";
  void track.offsetWidth; // force the snap above to apply before animating

  outgoingPanel.style.transition = "";
  incomingPanel.style.transition = "";
  outgoingPanel.style.transform = `rotateY(${delta}deg)`;
  incomingPanel.style.transform = `rotateY(${180 + delta}deg)`; // lands on 0 or 360 — visually identical

  outgoingPanel.classList.remove("is-active-panel");
  incomingPanel.classList.add("is-active-panel");

  currentPanel = newPanel;
  dots.forEach((d, i) => d.classList.toggle("is-active", i === currentPanel));
  positionRibbonMarker();
}

function positionRibbonMarker() {
  const activeDot = dots[currentPanel];
  if (!activeDot || !ribbonMarker) return;
  const x = activeDot.offsetLeft + activeDot.offsetWidth / 2 - ribbonMarker.offsetWidth / 2;
  ribbonMarker.style.transform = `translateX(${x}px)`;
}
positionRibbonMarker(); // set initial position on load

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
        let tags = r.subjects || [];
        let description = null;
        let googleCoverUrl = null;
        if (r.workKey) {
          const details = await getWorkDetails(r.workKey);
          if (details?.subjects?.length) tags = details.subjects.slice(0, 8);
          if (details?.description) description = details.description;
        }
        try {
          const gbook = await searchGoogleBooks(r.title, r.author);
          if (gbook) {
            tags = mergeTags(tags, gbook.categories);
            if (!description && gbook.description) description = gbook.description;
            if (!r.coverId && gbook.coverUrl) googleCoverUrl = gbook.coverUrl;
          }
        } catch {
          /* non-fatal — book still gets added with OpenLibrary data alone */
        }
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
        enriched++;
      }
    } catch (err) {
      if (!firstError) firstError = err.message;
      // leave googleEnriched unset so this book gets retried next run
    }
    if (Object.keys(updates).length) await updateDoc(doc(db, "books", book.id), updates);
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