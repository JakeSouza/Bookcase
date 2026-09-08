// ============================================================
// GOOGLE BOOKS API KEY
//
// The __GOOGLE_BOOKS_API_KEY__ placeholder below is filled in
// automatically by the GitHub Actions workflow at deploy time, pulling
// from your repo's Settings → Secrets and variables → Actions. This file
// itself never contains your real key.
//
// For real protection on top of that (recommended for this key, unlike
// Firebase's config): add an HTTP referrer restriction in Google Cloud
// Console → Credentials → your key → Application restrictions → HTTP
// referrers → limit it to your GitHub Pages URL (e.g.
// https://yourusername.github.io/*). That way the key only works when
// called from your own site, even though the deployed page still has to
// contain the key's value for the browser to use it.
// ============================================================

export const GOOGLE_BOOKS_API_KEY = "__GOOGLE_BOOKS_API_KEY__";