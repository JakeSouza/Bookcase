// ============================================================
// GOOGLE BOOKS API KEY
//
// Kept in its own file, separate from googlebooks.js, so that future
// updates to that file's logic never accidentally overwrite your key
// with the placeholder again.
//
// Setup instructions are in the README (or see the comment at the top
// of js/googlebooks.js) — short version: console.cloud.google.com →
// select your Firebase project → enable "Books API" → Credentials →
// Create API key → restrict it to Books API → paste it below.
// ============================================================
export const GOOGLE_BOOKS_API_KEY =
	import.meta.env?.VITE_GOOGLE_BOOKS_API_KEY ?? "";