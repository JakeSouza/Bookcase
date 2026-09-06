# The Reading Room

A swipeable, three-panel personal reading tracker: currently reading (spotlighted), a shelf of everything you've read (rate 0–5 in quarter-star steps, sort by rating/series/author/title), and a "waiting stack" of to-read books scored 0–10 against your taste based on your ratings.

Book metadata (covers, subjects/tags) comes from the free [OpenLibrary API](https://openlibrary.org/developers/api) — no key needed. Your library data lives in your own Firebase Firestore project.

## 1. Set up Firebase

1. Go to the [Firebase console](https://console.firebase.google.com/) → **Add project** (use your existing account).
2. In the project, go to **Build → Firestore Database → Create database**. Start in **production mode** (rules below lock it down).
3. Go to **Build → Authentication → Get started → Email/Password → Enable**. Then **Users → Add user** and create yourself an account — this is how you'll sign in as the site's "librarian" to add books, rate things, and import your CSV. The site has no public sign-up form on purpose.
4. Go to **Project settings → General → Your apps → Add app → Web (`</>`)**. Name it anything. Copy the `firebaseConfig` object it gives you.
5. Paste those values into `js/firebase-config.js`, replacing the placeholders.

### Firestore security rules

In **Firestore → Rules**, use:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /books/{bookId} {
      allow read: if true;                 // your site is public to view
      allow write: if request.auth != null; // only signed-in you can edit
    }
  }
}
```

This makes your shelves visible to anyone who visits the page, but only your signed-in account can add, edit, or delete books.

## 2. Import your GoodReads library

1. In GoodReads: **My Books → Import/Export (bottom of the tools list on the left) → Export Library**. Download the CSV it emails you or generates.
2. Open your deployed site, click **Librarian sign-in** (top right), sign in with the account you made above.
3. Open the **Librarian tools** tab on the right edge, choose your CSV under **Import GoodReads export**, and click **Import CSV**.

The importer reads your `Exclusive Shelf` column to sort books into reading / read / to-read, pulls series info out of GoodReads' `Title (Series, #N)` format, and looks each title up on OpenLibrary for a cover and subject tags. It's rate-limited to be polite to OpenLibrary's free API, so a large library (500+ books) may take several minutes — leave the tab open until the status line says "Done."

Your GoodReads star ratings (whole numbers, 1–5) import as-is. Since the site supports quarter-star precision going forward, feel free to go back and fine-tune any of them from the book's detail card.

## 3. Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/root`.
3. Your site will be live at `https://<username>.github.io/<repo>/` within a minute or two.

## How the taste-match score works

For each to-read book, `js/taste-match.js` blends three signals from your rated library:

- **Author affinity** — your average rating of other books by that author
- **Series affinity** — your average rating of that series so far
- **Subject overlap** — how much the book's OpenLibrary subjects resemble the subjects of books you've rated, weighted by rating

Whichever signals are actually available (a debut author with no series, say) get reweighted so the score is still meaningful. With no rated books yet, everything shows a neutral 5.0.

## Notes

- "Currently reading" pulls whichever book has `status: "reading"` — if you use this for more than one book at a time, it shows the first match. There's an optional `progressPercent` field (0–100) you can set on that book's Firestore document to show a progress bar.
- Manually adding a book (via the Librarian tools search) queries OpenLibrary live, so you can add books before you've even opened GoodReads.
- Swiping works with touch, trackpad horizontal scroll, the on-screen arrows/dots, and left/right arrow keys.