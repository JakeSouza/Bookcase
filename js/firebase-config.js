// ============================================================
// FIREBASE CONFIG
// Replace the values below with your own project's config.
// Firebase Console → Project settings → General → Your apps → SDK setup and config
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDnO2CwbmvO7MWKhNpq9Ov17lfGLumvop4",
  authDomain: "bookcase-c01bf.firebaseapp.com",
  projectId: "bookcase-c01bf",
  storageBucket: "bookcase-c01bf.firebasestorage.app",
  messagingSenderId: "413489194634",
  appId: "1:413489194634:web:9ab91d430e1d844c4a2f73"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);