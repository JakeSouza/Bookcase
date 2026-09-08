// ============================================================
// FIREBASE CONFIG
//
// The __TOKEN__ placeholders below are filled in automatically by the
// GitHub Actions workflow (.github/workflows/deploy.yml) at deploy time,
// pulling from your repo's Settings → Secrets and variables → Actions.
// This file itself never contains your real values — see the README for
// which secrets to add and what to name them.
//
// Note: Firebase's web config isn't a traditional secret (Google designs
// it to be public in client-side code) — your real security boundary is
// the Firestore rules and Firebase Auth. Keeping these out of the repo
// is about hygiene and avoiding secret-scanning noise, not confidentiality
// from someone viewing your live site, which unavoidably still needs
// these values to call Firebase at all.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "bookcase-c01bf.firebaseapp.com",
  projectId: "__FIREBASE_PROJECT_ID__",
  storageBucket: "bookcase-c01bf.firebasestorage.app",
  messagingSenderId: "__FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__FIREBASE_APP_ID__"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);