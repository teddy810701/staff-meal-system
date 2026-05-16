import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCQy8KiTnE9aN0ofMDIlUU5SEmKbBLJAZs",
  authDomain: "work-checkin-77acf.firebaseapp.com",
  databaseURL: "https://work-checkin-77acf-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "work-checkin-77acf",
  storageBucket: "work-checkin-77acf.firebasestorage.app",
  messagingSenderId: "853278662909",
  appId: "1:853278662909:web:b2e50c09af06dd601cde94",
  measurementId: "G-CKC8WT20HW"
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const auth = getAuth(app);