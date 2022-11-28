// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey: "AIzaSyDnHVlxY_kz34qQVQHtDmT0vY-0qamC77Y",

  authDomain: "zaza-bor.firebaseapp.com",

  databaseURL:
    "https://zaza-bor-default-rtdb.asia-southeast1.firebasedatabase.app",

  projectId: "zaza-bor",

  storageBucket: "zaza-bor.appspot.com",

  messagingSenderId: "467249732865",

  appId: "1:467249732865:web:52e84d2d3b52e6aac90f00",

  measurementId: "G-YQM9KTD8KS",
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
