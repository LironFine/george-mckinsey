import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  projectId: "gen-lang-client-0766618683",
  appId: "1:478311515884:web:103fb4b7a3df9230d787c9",
  apiKey: "AIzaSyCGCQCTDNKI3SEBrwlmUUQeQfuLvM0mjJM",
  authDomain: "gen-lang-client-0766618683.firebaseapp.com",
  storageBucket: "gen-lang-client-0766618683.firebasestorage.app",
  messagingSenderId: "478311515884",
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app, 'ai-studio-8280a1b0-1e71-4be4-a656-68ed51e8000f');
