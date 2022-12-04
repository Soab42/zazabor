// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey: "AIzaSyDnHVlxY_kz34qQVQHtDmT0vY-0qamC77Y",

  authDomain: "zaza-bor.firebaseapp.com",

  databaseURL:
    "https://zaza-bor-default-rtdb.asia-southeast1.firebasedatabase.app",

  projectId: "zaza-bor",
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
