// ============================================================
// FIREBASE CONFIG
// Replace the values below with your own project's config.
// Firebase Console → Project settings → General → Your apps → SDK setup and config
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: import.meta.env?.FIREBASE_API_KEY ?? "",
  authDomain: "bookcase-c01bf.firebaseapp.com",
  projectId: import.meta.env?.FIREBASE_PROJECT_ID ?? "",
  storageBucket: "bookcase-c01bf.firebasestorage.app",
  messagingSenderId: import.meta.env?.FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env?.FIREBASE_APP_ID ?? ""
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);