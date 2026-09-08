# The Reading Room

A swipeable, three-panel personal reading tracker: currently reading (spotlighted), a shelf of everything you've read (rate 0–5 in quarter-star steps, sort by rating/series/author/title), and a "waiting stack" of to-read books scored 0–10 against your taste based on your ratings.

Book metadata (covers, subjects/tags) comes from the free [OpenLibrary API](https://openlibrary.org/developers/api) — no key needed. Your library data lives in your own Firebase Firestore project.

## 1. Set up Firebase

1. Go to the [Firebase console](https://console.firebase.google.com/) → **Add project** (use your existing account).
2. In the project, go to **Build → Firestore Database → Create database**. Start in **production mode** (rules below lock it down).
3. Go to **Build → Authentication → Get started → Email/Password → Enable**. Then **Users → Add user** and create yourself an account — this is how you'll sign in as the site's "librarian" to add books, rate things, and import your CSV. The site has no public sign-up form on purpose.
4. Go to **Project settings → General → Your apps → Add app → Web (`</>`)**. Name it anything. Copy the `firebaseConfig` object it gives you — you'll need these values in step 1a below, not pasted directly into the file.

### 1a. Keep your keys out of the repo with GitHub Actions

`js/firebase-config.js` and `js/google-books-config.js` contain placeholder tokens (like `__FIREBASE_API_KEY__`) instead of real values. A GitHub Actions workflow (`.github/workflows/deploy.yml`) fills them in automatically at deploy time, pulling from repo secrets — so your real keys never get committed.

1. In your repo, go to **Settings → Secrets and variables → Actions → New repository secret**, and add each of these (paste the matching value from your Firebase config / Google Books key):
   - `FIREBASE_API_KEY`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
   - `GOOGLE_BOOKS_API_KEY`
2. Go to **Settings → Pages → Build and deployment → Source**, and change it to **GitHub Actions** (instead of "Deploy from a branch"). The included workflow handles building and publishing from here on.
3. Push to `main`. The **Actions** tab will show the workflow running — once it finishes, your site is live with the real values baked into the deployed output only, not the source you pushed.

Note: `authDomain` and `storageBucket` are left as plain values in `firebase-config.js` rather than secrets, since they're just your project ID with a fixed suffix — not sensitive on their own.

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

## 2. Set up your Google Books API key

The site cross-references [Google Books](https://developers.google.com/books/docs/v1/using) alongside OpenLibrary for descriptions and tags. Requests without a key share a global "anonymous" quota with every other app on the internet that skips one — it gets exhausted fast and returns errors that have nothing to do with your own usage. A free key gives you your own dedicated quota instead, and since Firebase *is* Google Cloud, it comes from the same project you already made — no new signup.

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and select your existing Firebase project from the project dropdown at the top of the page.
2. Use the search bar to find **Books API**, click into it, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → API key**. Google generates one immediately.
4. Click **Restrict key** → under **API restrictions**, choose **Restrict key** and select **Books API** only. This is what makes it safe to embed in client-side code — the key can't be used for anything else even if someone finds it in your page source, the same principle as your public Firebase web config.
5. Copy the key and paste it into `js/googlebooks.js`, replacing the `YOUR_GOOGLE_BOOKS_API_KEY` placeholder.

## 3. Import your GoodReads library

1. In GoodReads: **My Books → Import/Export (bottom of the tools list on the left) → Export Library**. Download the CSV it emails you or generates.
2. Open your deployed site, click **Librarian sign-in** (top right), sign in with the account you made above.
3. Open the **Librarian tools** tab on the right edge, choose your CSV under **Import GoodReads export**, and click **Import CSV**.

The importer reads your `Exclusive Shelf` column to sort books into reading / read / to-read, pulls series info out of GoodReads' `Title (Series, #N)` format, and looks each title up on OpenLibrary for a cover and subject tags. It's rate-limited to be polite to OpenLibrary's free API, so a large library (500+ books) may take several minutes — leave the tab open until the status line says "Done."

Your GoodReads star ratings (whole numbers, 1–5) import as-is. Since the site supports quarter-star precision going forward, feel free to go back and fine-tune any of them from the book's detail card.

## 4. Deploy to GitHub Pages

Covered in step 1a above (Pages source set to GitHub Actions, secrets added). Once that's done, every push to `main` redeploys automatically — no separate deploy step needed. Your site lives at `https://<username>.github.io/<repo>/`.

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